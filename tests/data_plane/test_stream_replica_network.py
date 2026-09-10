"""Frozen artifact failover with two real TCP Runners and shared Redis.

Opt in with GUARD_TEST_REDIS_URL pointing at a dedicated loopback Redis. Only
random call/stream keys owned by this test are deleted, never FLUSHDB.
Synthetic model HTTP responses prove transport/state behavior, not accuracy.
"""
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import httpx
import pytest

from runner import generated as protocol
from runner.api import RunnerAPI
from runner.call_context import RedisCallContextStore
from runner.metrics import RunnerMetrics
from runner.output_streaming import RedisOutputStreamSessionStore
from runner.providers import dynamic_runtime_action_providers
from runner.toolkit.runtime.service import GuardrailRuntimeService
from tests.data_plane.test_artifact_execution import _runtime, RUNTIME_CREDENTIAL, Telemetry
from tests.data_plane.test_stream_safety_network import tcp_server


@pytest.mark.parametrize("mode", ["interruptible", "window_buffered", "full_buffered"])
@pytest.mark.parametrize("scenario", ["safe", "blocked", "failure-retry", "expired-context"])
async def test_stopped_tcp_replica_hands_pinned_checked_stream_to_second_runner(tmp_path, mode, scenario):
    redis_url = os.environ.get("GUARD_TEST_REDIS_URL")
    if not redis_url:
        pytest.skip("Set GUARD_TEST_REDIS_URL to a dedicated loopback Redis")
    assert urlparse(redis_url).hostname in {"127.0.0.1", "localhost", "::1"}
    call_id, stream_id = str(uuid4()), str(uuid4())
    scoped_call_id = f"fixture-endpoint:{call_id}"
    contexts = [RedisCallContextStore(redis_url) for _ in range(2)]
    streams = [RedisOutputStreamSessionStore(redis_url) for _ in range(2)]
    prefix = "benign " * 600
    suffix = "ordinary answer" if scenario == "safe" else "REGRESSION_UNSAFE"
    calls = []
    fault_pending = scenario == "failure-retry"
    model_app = FastAPI()

    @model_app.post("/v1/chat/completions")
    async def classify(request: Request):
        nonlocal fault_pending
        assert request.headers["authorization"] == "Bearer fixture-model-key"
        payload = await request.json()
        assert payload["model"] == "nvidia/llama-3.1-nemotron-safety-guard-8b-v3"
        calls.append(payload)
        unsafe = "REGRESSION_UNSAFE" in json.dumps(payload["messages"])
        if unsafe and fault_pending:
            fault_pending = False
            return JSONResponse({"error": "private synthetic backend"}, status_code=503)
        verdict = json.dumps({"User Safety": "safe", "Response Safety": "unsafe" if unsafe else "safe",
            "Safety Categories": "Violence" if unsafe else ""})
        return {"choices": [{"message": {"content": verdict}}]}

    engines = []
    try:
        assert contexts[0]._redis.ping()
        async with tcp_server(model_app) as model_url:
            config = protocol.DataPlaneModelConfiguration(revision_id="fixture-replicas", revision=1,
                runtimes=[protocol.ModelRuntime(id="safety", base_url=f"{model_url}/v1",
                    model="nvidia/llama-3.1-nemotron-safety-guard-8b-v3", profile_ref="tali.nemotron-safety-guard-v3.v1",
                    credential_ref="fixture-provider", timeout_seconds=3, max_tokens=128)],
                bindings=[protocol.CapabilityBinding(binding_id="content_safety.output", capability_ref="content_safety",
                    rail_type=protocol.RAIL_TYPE_OUTPUT, implementation_ref="tali.runtime.safety-model.v1",
                    model_ref="safety", profile_ref="tali.nemotron-safety-guard-v3.v1",
                    contract_refs=["tali.guard.content-safety.v1"])])
            apps = []
            for index in range(2):
                providers = dynamic_runtime_action_providers(config, {"fixture-provider": "fixture-model-key"})
                fixture = Path(__file__).resolve().parents[1] / "fixtures/artifacts" / f"stream-safety-{mode}-v1"
                store, _registry, engine = _runtime(tmp_path / f"replica-{index}", fixture, providers)
                engines.append(engine)
                app = FastAPI()
                app.include_router(RunnerAPI(GuardrailRuntimeService(engine, store, contexts=contexts[index]),
                    store, RunnerMetrics(4), Telemetry(), f"replica-{index}", "fixture-controller-token",
                    output_streams=streams[index]).router)
                apps.append(app)

            endpoint = "/runtime/v1/endpoints/fixture-endpoint/guardrails/output-stream"
            async with httpx.AsyncClient(timeout=10, trust_env=False) as client, tcp_server(apps[1]) as second_url:
                async def send(url, sequence):
                    return await client.post(url + endpoint, headers={"x-api-key": RUNTIME_CREDENTIAL}, json={
                        "stream_id": stream_id, "call_id": call_id, "sequence": sequence,
                        "text": prefix if sequence == 0 else suffix, "final": sequence == 1,
                        "protocol": "litellm", "messages": [{"role": "user", "content": "Tell me a story."}],
                    })

                async with tcp_server(apps[0]) as first_url:
                    first_response = await send(first_url, 0)
                    assert first_response.status_code == 200, first_response.text
                    first = first_response.json()
                    assert first["effective_release_id"]
                    expected_prefix = "" if mode == "full_buffered" else prefix[:-2048] if mode == "window_buffered" else prefix
                    assert first["released_text"] == expected_prefix
                    key = streams[0]._key(f"fixture-endpoint:{stream_id}")
                    before = await streams[0]._redis.get(key)
                    assert json.loads(before)["next_sequence"] == 1
                    assert contexts[1].get(scoped_call_id).resolution.effective_release_id == first["effective_release_id"]

                # First server is actually stopped; the second cannot obtain
                # context or buffered text from its process-local Python state.
                await engines[0].shutdown()
                engines = engines[1:]
                with pytest.raises(httpx.ConnectError):
                    await client.get(first_url + "/health/ready")
                if scenario == "expired-context":
                    # Expire only this test-owned pin, retaining the stream
                    # buffer. A successor must never silently re-resolve it.
                    assert contexts[0]._redis.pexpire(contexts[0]._key(scoped_call_id), 0)
                    calls_before = len(calls)
                    expired = await send(second_url, 1)
                    assert expired.status_code == 409, expired.text
                    assert "pinned release expired" in expired.json()["detail"]
                    assert "released_text" not in expired.json()
                    assert len(calls) == calls_before
                    assert await streams[1]._redis.get(key) == before
                    return
                final_response = await send(second_url, 1)
                if scenario == "failure-retry":
                    assert final_response.status_code == 502, final_response.text
                    assert "released_text" not in final_response.json()
                    assert "private synthetic" not in final_response.text
                    assert await streams[1]._redis.get(key) == before
                    failed_payload = calls[-1]
                    final_response = await send(second_url, 1)
                    assert calls[-1] == failed_payload
                assert final_response.status_code == 200, final_response.text
                final = final_response.json()
                assert final["effective_release_id"] == first["effective_release_id"]
                assert final["model_revision_id"] == first["model_revision_id"]
                assert final["mode"] == final["requested_mode"] == mode
                assert final["decision"]["usage"]["model_invocations"] == 1
                assert final["decision"]["usage"]["fail_closed"] is False
                assert prefix + suffix in json.dumps(calls[-1]["messages"])
                if scenario == "safe":
                    assert final["status"] == "completed"
                    assert first["released_text"] + final["released_text"] == prefix + suffix
                else:
                    assert final["status"] == "blocked" and final["terminate"] is True
                    assert final["released_text"] == ""
                state = json.loads(await streams[1]._redis.get(key))
                assert state["next_sequence"] == 2 and state["complete"]
                assert state["all_text"] == prefix + suffix
                assert 0 < await streams[1]._redis.ttl(key) <= 300
                replay = await send(second_url, 1)
                assert replay.status_code == 409, "A completed sequence must not release duplicate text"
    finally:
        for engine in engines:
            await engine.shutdown()
        key = streams[0]._key(f"fixture-endpoint:{stream_id}")
        try:
            await streams[0]._redis.delete(key, f"{key}:lock", contexts[0]._key(scoped_call_id))
        finally:
            for item in streams:
                await item._redis.aclose()
            for item in contexts:
                item._redis.close()
