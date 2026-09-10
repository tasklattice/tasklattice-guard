"""Real TCP Runner -> model transport with frozen artifacts, no compiler.

The loopback model emits synthetic classifications. These tests establish
checked-release timing and transactional retry, not model safety accuracy or
end-to-end LiteLLM/SSE cancellation behavior.
"""
import asyncio
from contextlib import asynccontextmanager
import json
from pathlib import Path
import socket

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import httpx
import pytest
import uvicorn

from runner import generated as protocol
from runner.api import RunnerAPI
from runner.metrics import RunnerMetrics
from runner.providers import dynamic_runtime_action_providers
from runner.toolkit.runtime.context import CallContextStore
from runner.toolkit.runtime.service import GuardrailRuntimeService
from tests.data_plane.test_artifact_execution import _runtime, RUNTIME_CREDENTIAL, Telemetry


@asynccontextmanager
async def tcp_server(app):
    """Bind an OS-assigned loopback port; never reuse or stop a user service."""
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(
        app, host="127.0.0.1", port=port, lifespan="off", access_log=False,
        log_level="error", timeout_graceful_shutdown=2,
    ))
    task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        async with asyncio.timeout(5):
            while not server.started:
                if task.done():
                    await task
                    raise AssertionError("Loopback server stopped before startup")
                await asyncio.sleep(0.01)
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        try:
            await asyncio.wait_for(task, 5)
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            sock.close()


@pytest.mark.parametrize("mode", ["interruptible", "window_buffered", "full_buffered"])
@pytest.mark.parametrize("family", ["nvidia", "qwen"])
@pytest.mark.parametrize("scenario", ["safe", "blocked", "failure-retry"])
async def test_tcp_waits_for_check_before_release_and_retries_exact_candidate(tmp_path, mode, family, scenario):
    prefix = "benign " * 600
    fragments = [prefix, "ordinary ", "answer"] if scenario == "safe" else [prefix, "REGRESSION_", "UNSAFE"]
    marker = "REGRESSION_UNSAFE"
    model = "nvidia/llama-3.1-nemotron-safety-guard-8b-v3" if family == "nvidia" else "Qwen/Qwen3Guard-Gen-8B"
    profile = "tali.nemotron-safety-guard-v3.v1" if family == "nvidia" else "tali.qwen3guard.v1"
    entered, proceed = asyncio.Event(), asyncio.Event()
    proceed.set()
    calls = []
    fault_pending = scenario == "failure-retry"
    model_app = FastAPI()

    @model_app.post("/v1/chat/completions")
    async def classify(request: Request):
        nonlocal fault_pending
        assert request.headers["authorization"] == "Bearer fixture-model-key"
        payload = await request.json()
        assert payload["model"] == model
        calls.append(payload)
        entered.set()
        await asyncio.wait_for(proceed.wait(), 5)
        unsafe = marker in json.dumps(payload["messages"])
        if unsafe and fault_pending:
            fault_pending = False
            return JSONResponse({"error": "private synthetic backend detail"}, status_code=503)
        verdict = json.dumps({"User Safety": "safe", "Response Safety": "unsafe" if unsafe else "safe",
            "Safety Categories": "Violence" if unsafe else ""}) if family == "nvidia" else (
            "Safety: Unsafe\nCategories: Violent" if unsafe else "Safety: Safe\nCategories: None")
        return {"choices": [{"message": {"content": verdict}}]}

    async with tcp_server(model_app) as model_url:
        configuration = protocol.DataPlaneModelConfiguration(revision_id="fixture-tcp-models", revision=1,
            runtimes=[protocol.ModelRuntime(id="safety", base_url=f"{model_url}/v1", model=model,
                profile_ref=profile, credential_ref="fixture-provider", timeout_seconds=3, max_tokens=128)],
            bindings=[protocol.CapabilityBinding(binding_id="content_safety.output", capability_ref="content_safety",
                rail_type=protocol.RAIL_TYPE_OUTPUT, implementation_ref="tali.runtime.safety-model.v1",
                model_ref="safety", profile_ref=profile, contract_refs=["tali.guard.content-safety.v1"])])
        providers = dynamic_runtime_action_providers(configuration, {"fixture-provider": "fixture-model-key"})
        fixture = Path(__file__).resolve().parents[1] / "fixtures" / "artifacts" / f"stream-safety-{mode}-v1"
        store, registry, engine = _runtime(tmp_path, fixture, providers=providers)
        telemetry = Telemetry()
        app = FastAPI()
        app.include_router(RunnerAPI(GuardrailRuntimeService(engine, store, contexts=CallContextStore()),
            store, RunnerMetrics(4), telemetry, "fixture-tcp", "fixture-controller-token").router)
        endpoint = "/runtime/v1/endpoints/fixture-endpoint/guardrails/output-stream"
        try:
            async with tcp_server(app) as runner_url, httpx.AsyncClient(base_url=runner_url, timeout=10, trust_env=False) as client:
                async def send(sequence, received):
                    async with client.stream("POST", endpoint, headers={"x-api-key": RUNTIME_CREDENTIAL}, json={
                        "stream_id": "tcp-stream", "sequence": sequence, "text": fragments[sequence],
                        "final": sequence == 2, "protocol": "litellm",
                        "messages": [{"role": "user", "content": "Tell me a story."}],
                    }) as response:
                        async for chunk in response.aiter_raw():
                            received.append(chunk)
                        return response.status_code, json.loads(b"".join(received))

                async def gated_send(sequence):
                    entered.clear()
                    proceed.clear()
                    received = []
                    pending = asyncio.create_task(send(sequence, received))
                    try:
                        await asyncio.wait_for(entered.wait(), 5)
                        # Let the TCP client consume anything incorrectly emitted
                        # while the real provider request remains suspended.
                        await asyncio.sleep(0.05)
                        assert not pending.done(), "Runner returned before the detector finished"
                        assert received == [], "Unchecked response bytes reached the TCP client"
                        proceed.set()
                        return await asyncio.wait_for(pending, 5)
                    finally:
                        proceed.set()
                        if not pending.done():
                            pending.cancel()
                        await asyncio.gather(pending, return_exceptions=True)

                released = ""
                release_id = None
                for sequence in (0, 1):
                    must_check = mode == "interruptible" or (mode == "window_buffered" and sequence == 0)
                    status, result = await gated_send(sequence) if must_check else await send(sequence, [])
                    assert status == 200, result
                    assert result["mode"] == result["requested_mode"] == mode
                    assert not result["terminate"]
                    release_id = release_id or result["effective_release_id"]
                    assert result["effective_release_id"] == release_id
                    released += result["released_text"]
                expected = "" if mode == "full_buffered" else prefix[:-2048] if mode == "window_buffered" else "".join(fragments[:2])
                assert released == expected
                assert len(calls) == {"full_buffered": 0, "window_buffered": 1, "interruptible": 2}[mode]

                status, result = await gated_send(2)
                if scenario == "failure-retry":
                    assert status == 502, result
                    assert "released_text" not in result
                    assert marker not in json.dumps(result)
                    assert "private synthetic" not in json.dumps(result)
                    failed_payload = calls[-1]
                    status, result = await gated_send(2)
                    assert calls[-1] == failed_payload, "Retry changed or duplicated the accumulated candidate"
                assert status == 200, result
                assert result["effective_release_id"] == release_id
                if scenario == "safe":
                    assert result["status"] == "completed"
                    assert released + result["released_text"] == "".join(fragments)
                else:
                    assert result["status"] == "blocked" and result["terminate"] is True
                    assert result["released_text"] == "" and marker not in released
                assert result["decision"]["usage"]["fail_closed"] is False
                assert result["decision"]["usage"]["model_invocations"] == 1
                assert registry.readiness()["ready"] is True
                assert telemetry.events
        finally:
            proceed.set()
            await engine.shutdown()
