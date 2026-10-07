"""One authenticated WebSocket owns one pinned, non-resumable output stream."""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import replace
from typing import Any, Literal

from fastapi import Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .routing import RoutingError
from .toolkit.runtime.streaming import OutputStreamEvaluationError

INPUT_CREDITS = 8
MAX_SECONDS = 300
MAX_FRAMES = 100_000
MAX_CHARACTERS = 1_000_000
MAX_MESSAGE_CHARACTERS = 1_048_576
# Version carried by start/ready frames. LiteLLM gateway images advertise the
# version their Provider speaks as io.tasklattice.guard.output-stream-protocol;
# scripts/verify_relay_stream_image.py refuses images that disagree.
OUTPUT_STREAM_PROTOCOL_VERSION = 1


class StreamStart(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    type: Literal["start"]
    version: int = Field(ge=OUTPUT_STREAM_PROTOCOL_VERSION, le=OUTPUT_STREAM_PROTOCOL_VERSION)
    stream_id: str = Field(min_length=1, max_length=256)
    call_id: str | None = Field(default=None, min_length=1, max_length=256)
    protocol: Literal["http", "a2a", "litellm"]
    messages: list[dict[str, Any]] = Field(default_factory=list, max_length=20)
    request_data: dict[str, Any] = Field(default_factory=dict)
    request_headers: dict[str, str] = Field(default_factory=dict)
    attributes: dict[str, str] = Field(default_factory=dict)
    model: str | None = None
    output_sink: Literal["display", "markdown", "html", "sql", "shell", "url", "json", "tool_argument"] | None = None


class StreamFrame(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    type: Literal["delta", "end"]
    sequence: int = Field(ge=0, le=MAX_FRAMES)
    text: str = Field(default="", max_length=100_000)


class StreamProtocolError(ValueError):
    pass


async def _receive(socket: WebSocket):
    message = await socket.receive()
    if message["type"] == "websocket.disconnect":
        raise WebSocketDisconnect(message.get("code", 1000))
    text = message.get("text")
    if not isinstance(text, str) or len(text) > MAX_MESSAGE_CHARACTERS:
        raise StreamProtocolError("Invalid stream frame.")
    return json.loads(text)


def register_output_stream(api) -> None:
    # HTTP adapters remain the authority for Endpoint/principal mapping.
    from .api import (
        EvaluateRequest, LiteLLMGuardrailRequest, LITELLM_ADAPTER_ID,
        _http_protection_request, _litellm_protection_request,
    )

    @api.router.websocket("/runtime/v1/endpoints/{endpoint_id}/guardrails/output-stream")
    async def output_stream(socket: WebSocket, endpoint_id: str):
        authenticated = api._store.authenticate_endpoint(endpoint_id, socket.headers.get("x-api-key"))
        adapter = api._store.endpoint_adapter(endpoint_id)
        protocol = {"a2a-guard": "a2a", "generic-http-guard": "http", LITELLM_ADAPTER_ID: "litellm"}.get(adapter)
        api._metrics.observe_authentication(protocol or "http", authenticated)
        if not authenticated or protocol is None:
            await socket.close(code=1008)
            return
        await socket.accept()
        stream_id = None
        output_sequence = 0
        checks = 0
        source_ended = False
        lock = asyncio.Lock()
        queue: asyncio.Queue[StreamFrame] = asyncio.Queue(INPUT_CREDITS)

        async def send(payload):
            async with lock:
                await socket.send_json({"stream_id": stream_id, **payload})

        async def read_frames():
            expected, size, ended = 0, 0, False
            while True:
                frame = StreamFrame.model_validate(await _receive(socket))
                if ended or frame.sequence != expected or (frame.type == "end" and frame.text):
                    raise StreamProtocolError("Invalid stream sequence or terminal frame.")
                size += len(frame.text)
                if size > MAX_CHARACTERS or (frame.type == "delta" and expected >= MAX_FRAMES):
                    raise StreamProtocolError("Output stream exceeded its limit.")
                ended = frame.type == "end"
                expected += 1
                # Credits return on consumption. This reader stays available
                # for disconnects even while the engine checks a full window.
                try:
                    queue.put_nowait(frame)
                except asyncio.QueueFull:
                    raise StreamProtocolError("Output stream exceeded its input credits.") from None

        async def source():
            nonlocal source_ended
            while True:
                frame = await queue.get()
                await send({"type": "ack", "sequence": frame.sequence})
                if frame.type == "end":
                    source_ended = True
                    return
                yield frame.text

        async def emit(text):
            nonlocal output_sequence
            await send({"type": "delta", "sequence": output_sequence, "text": text})
            output_sequence += 1

        async def terminal_error(code):
            # Never copy exception strings, provider responses or Policy text.
            try:
                async with asyncio.timeout(2):
                    await send({"type": "error", "sequence": output_sequence, "checks": checks,
                                "code": code, "message": "Protected output stream failed; unchecked text was withheld."})
            except (RuntimeError, WebSocketDisconnect, OSError, TimeoutError):
                pass

        try:
            async with asyncio.timeout(MAX_SECONDS):
                async with asyncio.timeout(10):
                    start = StreamStart.model_validate(await _receive(socket))
                stream_id = start.stream_id
                if start.protocol != protocol:
                    raise StreamProtocolError("Endpoint adapter does not match the stream protocol.")
                request = Request({**socket.scope, "type": "http", "method": "GET"})
                if protocol == "litellm":
                    protection = _litellm_protection_request(LiteLLMGuardrailRequest(
                        input_type="response", texts=[""], litellm_call_id=start.call_id or start.stream_id,
                        structured_messages=start.messages, model=start.model,
                        request_data=start.request_data, request_headers=start.request_headers,
                    ), endpoint_id, request)
                else:
                    protection = _http_protection_request(EvaluateRequest(
                        phase="output", texts=[""], call_id=start.call_id or start.stream_id,
                        protocol=protocol, messages=start.messages, attributes=start.attributes,
                        model=start.model, output_sink=start.output_sink,
                    ), request, endpoint_id)
                protection = replace(protection, context=replace(protection.context,
                    fields=(*protection.context.fields, ("routing.stream", "true"))))
                effective_mode = None
                check_started = time.perf_counter()

                async def ready(contract, resolution):
                    nonlocal effective_mode
                    effective_mode = contract.effective_mode
                    await send({"type": "ready", "version": OUTPUT_STREAM_PROTOCOL_VERSION, "input_credits": INPUT_CREDITS,
                        "mode": contract.effective_mode, "requested_mode": contract.requested_mode,
                        "effective_release_id": resolution.effective_release_id,
                        "model_revision_id": resolution.model_revision_id})

                async def observe(decision):
                    nonlocal checks, check_started
                    checks += 1
                    await api._emit_telemetry(
                        request_id=str(uuid.uuid4()), call_id=protection.call_id, endpoint_id=endpoint_id,
                        phase="output", protocol=f"{protocol}-stream", mode=protection.mode,
                        started=check_started, decision=decision,
                        stream_metadata={"streamId": stream_id, "streamCheck": checks,
                                         "streamFinalCheck": source_ended,
                                         "effectiveOutputDelivery": effective_mode},
                    )
                    check_started = time.perf_counter()

                iterator = source()
                worker = asyncio.create_task(api._runtime.stream_output(protection, iterator,
                    ready=ready, emit=emit, observe=observe, allow_new_output=start.call_id is None))
                reader = asyncio.create_task(read_frames())
                try:
                    done, _ = await asyncio.wait((worker, reader), return_when=asyncio.FIRST_COMPLETED)
                    # Disconnect/protocol violation wins over simultaneous EOF.
                    if reader in done:
                        await reader
                    result = await worker
                    await send({"type": result.status, "sequence": output_sequence, "checks": result.checks,
                                "released_characters": result.released_characters, "transformed": result.transformed})
                finally:
                    for task in (worker, reader):
                        task.cancel()
                    await asyncio.gather(worker, reader, return_exceptions=True)
                    await iterator.aclose()
        except WebSocketDisconnect:
            pass
        except asyncio.CancelledError:
            raise
        except TimeoutError:
            await terminal_error("timeout")
        except OutputStreamEvaluationError as error:
            await terminal_error("timeout" if error.timed_out else "protection_failed")
        except RoutingError:
            await terminal_error("routing_failed")
        except (StreamProtocolError, ValidationError, json.JSONDecodeError):
            await terminal_error("invalid_stream")
        except Exception:
            await terminal_error("protection_failed")
        finally:
            try:
                async with asyncio.timeout(2):
                    await socket.close(code=1000)
            except (RuntimeError, WebSocketDisconnect, OSError, TimeoutError):
                pass
