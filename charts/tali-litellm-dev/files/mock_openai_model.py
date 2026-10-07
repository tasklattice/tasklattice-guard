"""Synthetic OpenAI-compatible chat model for LiteLLM adapter integration tests.

Echoes the last user message so Guard input/output decisions stay observable.

Scenario tokens in the last user message select a canned reply. They are
innocuous on the Input stage, so the Output stage is what Guard must act on:

  [mock:leak-secret]   reply contains a synthetic cloud access key
  [mock:leak-pii]      reply contains a synthetic e-mail address and phone number
  [mock:long]          reply is ~2,000 characters, for windowed streaming

Request headers steer the reply when the caller talks to the mock directly
(LiteLLM does not forward arbitrary client headers upstream):

  x-mock-response        complete assistant text to return instead of the echo
  x-mock-chunk-delay-ms  pause between streamed chunks (default 20)
  x-mock-chunk-size      characters per streamed chunk (default 12)
  x-mock-status          HTTP status to fail with (for upstream-error cases)
"""
from __future__ import annotations

import asyncio
import json
import os
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
import uvicorn

MODEL = os.environ.get("MOCK_MODEL_NAME", "mock-model")
app = FastAPI(title="TaskLattice Guard mock model")
# Synthetic values only; the AWS example key is the documented placeholder.
SCENARIOS = {
    "leak-secret": "Sure. The deployment uses access key AKIAIOSFODNN7EXAMPLE with secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY.",
    "leak-pii": "The customer on file is Jane Example, reachable at jane.example@example.com or +1 415 555 0132.",
    "long": " ".join(f"Paragraph {index}: the quick brown fox jumps over the lazy dog." for index in range(1, 40)),
}


def _last_user_text(body: dict) -> str | None:
    for message in reversed(body.get("messages") or []):
        if message.get("role") == "user":
            content = message.get("content")
            if isinstance(content, list):
                content = " ".join(part.get("text", "") for part in content if isinstance(part, dict))
            return str(content)
    return None


def _reply(body: dict, request: Request) -> str:
    override = request.headers.get("x-mock-response")
    if override is not None:
        return override
    text = _last_user_text(body)
    if text is None:
        return "Echo: (no user message)"
    for name, canned in SCENARIOS.items():
        if f"[mock:{name}]" in text:
            return canned
    return f"Echo: {text}"


def _usage(prompt: str, completion: str) -> dict:
    prompt_tokens, completion_tokens = max(1, len(prompt) // 4), max(1, len(completion) // 4)
    return {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens, "total_tokens": prompt_tokens + completion_tokens}


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "component": "mock-model"}


@app.get("/v1/models")
async def models() -> dict:
    return {"object": "list", "data": [{"id": MODEL, "object": "model", "created": 0, "owned_by": "tasklattice-test"}]}


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    body = await request.json()
    status = request.headers.get("x-mock-status")
    if status and status != "200":
        return JSONResponse({"error": {"message": f"mock upstream failure {status}", "type": "mock_error"}}, status_code=int(status))
    reply = _reply(body, request)
    completion_id = f"chatcmpl-mock-{uuid.uuid4().hex[:24]}"
    created = int(time.time())
    model = body.get("model") or MODEL
    prompt = json.dumps(body.get("messages") or [])
    if not body.get("stream"):
        return {
            "id": completion_id, "object": "chat.completion", "created": created, "model": model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": reply}, "finish_reason": "stop"}],
            "usage": _usage(prompt, reply),
        }

    delay = int(request.headers.get("x-mock-chunk-delay-ms", "20")) / 1000
    size = max(1, int(request.headers.get("x-mock-chunk-size", "12")))

    def chunk(delta: dict, finish: str | None = None, usage: dict | None = None) -> str:
        payload = {"id": completion_id, "object": "chat.completion.chunk", "created": created, "model": model,
                   "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
        if usage is not None:
            payload["usage"] = usage
        return f"data: {json.dumps(payload)}\n\n"

    async def stream():
        yield chunk({"role": "assistant", "content": ""})
        for start in range(0, len(reply), size):
            await asyncio.sleep(delay)
            yield chunk({"content": reply[start:start + size]})
        yield chunk({}, finish="stop", usage=_usage(prompt, reply))
        yield "data: [DONE]\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("MOCK_MODEL_PORT", "8097")), access_log=False, log_level="warning")
