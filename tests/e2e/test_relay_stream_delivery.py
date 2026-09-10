"""Opt-in actual Relay proxy -> frozen Runner -> synthetic model TCP regression.

GUARD_TEST_RELAY_IMAGE=<existing-local-image> pytest -q -s <this file>
Requires Docker Desktop host.docker.internal routing. No Controller writes,
compiler, external models, image pulls, or user ports. Only this test's random
proxy container is stopped. Current Relay Guard endpoint is mounted read-only
unless GUARD_TEST_RELAY_BAKED_IMAGE=1, which verifies and tests image-baked code.
"""
import asyncio
import hashlib
import json
import os
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
import httpx
import pytest

from runner import generated as protocol
from runner.api import RunnerAPI
from runner.metrics import RunnerMetrics
from runner.providers import dynamic_runtime_action_providers
from runner.toolkit.runtime.context import CallContextStore
from runner.toolkit.runtime.service import GuardrailRuntimeService
from tests.data_plane.test_artifact_execution import _runtime, RUNTIME_CREDENTIAL, Telemetry
from tests.data_plane.test_stream_safety_network import tcp_server


async def docker(*args):
    process = await asyncio.create_subprocess_exec("docker", *args,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    stdout, _stderr = await asyncio.wait_for(process.communicate(), 30)
    assert process.returncode == 0, f"Docker {args[0]} failed (arguments/output omitted)"
    return stdout.decode().strip()


@pytest.mark.parametrize("mode", ["interruptible", "window_buffered", "full_buffered"])
async def test_actual_relay_stream_delivery_and_cancellation(tmp_path, mode):
    image = os.environ.get("GUARD_TEST_RELAY_IMAGE")
    if not image:
        pytest.skip("Set GUARD_TEST_RELAY_IMAGE to an existing isolated Relay test image")
    root = Path(__file__).resolve().parents[2]
    overlay = root.parent / "tasklattice-relay/infra/litellm/v1.87.0/overlay/litellm/proxy/guardrails/guardrail_hooks/tasklattice_guard"
    assert (overlay / "streaming.py").is_file()
    image_id = await docker("image", "inspect", image, "--format", "{{.Id}}")
    baked_mode = os.environ.get("GUARD_TEST_RELAY_BAKED_IMAGE", "0")
    assert baked_mode in {"0", "1"}, "GUARD_TEST_RELAY_BAKED_IMAGE must be 0 or 1"
    code_mount = ["--mount", f"type=bind,source={overlay},target=/app/litellm/proxy/guardrails/guardrail_hooks/tasklattice_guard,readonly"]
    if baked_mode == "1":
        probe = (
            "import hashlib,importlib.machinery,json,pathlib; "
            "s=importlib.machinery.PathFinder.find_spec('litellm'); "
            "p=pathlib.Path(s.origin).parent/'proxy/guardrails/guardrail_hooks/tasklattice_guard'; "
            "assert p.is_dir(), 'Missing baked TaskLattice Guard endpoint'; "
            "print(json.dumps({str(f.relative_to(p)):hashlib.sha256(f.read_bytes()).hexdigest() "
            "for f in sorted(p.rglob('*.py'))},sort_keys=True))"
        )
        actual = json.loads(await docker("run", "--rm", "--pull=never", "--network=none", "--read-only",
            "--entrypoint", "python", image_id, "-c", probe))
        expected = {str(path.relative_to(overlay)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(overlay.rglob("*.py"))}
        assert actual == expected, "Baked Relay Guard code differs from the current sibling overlay; rebuild the image"
        code_mount = []
    name = f"guard-incremental-e2e-{uuid4()}"
    proxy_key = f"sk-test-{uuid4()}"
    prefix = "benign " * 600
    safe_suffix = "ordinary answer"
    # Replay a captured business answer without contacting that model again.
    # Detector verdicts remain synthetic here: this is an engineering contract test.
    business_recording = os.environ.get("GUARD_TEST_BUSINESS_RECORDING")
    if business_recording:
        recording = json.loads(Path(business_recording).read_text())
        assert recording["source"] == "live-deepseek-business-sse"
        assert recording["finish_reason"] == "stop"
        prefix = recording["text"]
        assert len(prefix) > 2048, "Recorded answer must span a stream check boundary"
        safe_suffix = ""
    marker = "REGRESSION_UNSAFE"
    scenario = "safe"
    upstream_entered, upstream_continue, upstream_closed = (asyncio.Event() for _ in range(3))
    detector_calls = []
    business_calls = 0
    model_app = FastAPI()

    @model_app.post("/v1/chat/completions")
    async def model_endpoint(request: Request):
        nonlocal business_calls
        payload = await request.json()
        if payload["model"] != "replay-model":
            assert payload["model"] == "nvidia/llama-3.1-nemotron-safety-guard-8b-v3"
            detector_calls.append(payload)
            unsafe = marker in json.dumps(payload["messages"])
            if unsafe and scenario == "detector-failure":
                return JSONResponse({"error": "synthetic detector failure"}, status_code=503)
            verdict = json.dumps({"User Safety": "safe", "Response Safety": "unsafe" if unsafe else "safe",
                "Safety Categories": "Violence" if unsafe else ""})
            return {"choices": [{"message": {"content": verdict}}]}
        business_calls += 1
        assert payload["stream"] is True

        async def generate():
            def frame(content, finish=None):
                return "data: " + json.dumps({"id": "chatcmpl-fixture", "created": 1, "model": "replay-model",
                    "object": "chat.completion.chunk", "choices": [{"index": 0,
                    "delta": {"content": content}, "finish_reason": finish}]}) + "\n\n"
            try:
                if scenario in {"cancel-before-first-frame", "first-frame-timeout"}:
                    upstream_entered.set()
                    await upstream_continue.wait()
                yield frame(prefix)
                upstream_entered.set()
                await upstream_continue.wait()
                yield frame(safe_suffix if scenario == "safe" else marker)
                yield frame("", "stop")
                yield "data: [DONE]\n\n"
            finally:
                upstream_closed.set()
        return StreamingResponse(generate(), media_type="text/event-stream")

    async with tcp_server(model_app) as model_url:
        configuration = protocol.DataPlaneModelConfiguration(revision_id="fixture-relay-models", revision=1,
            runtimes=[protocol.ModelRuntime(id="safety", base_url=f"{model_url}/v1",
                model="nvidia/llama-3.1-nemotron-safety-guard-8b-v3", profile_ref="tali.nemotron-safety-guard-v3.v1",
                credential_ref="fixture-provider", timeout_seconds=3, max_tokens=128)],
            bindings=[protocol.CapabilityBinding(binding_id="content_safety.output", capability_ref="content_safety",
                rail_type=protocol.RAIL_TYPE_OUTPUT, implementation_ref="tali.runtime.safety-model.v1",
                model_ref="safety", profile_ref="tali.nemotron-safety-guard-v3.v1",
                contract_refs=["tali.guard.content-safety.v1"])])
        providers = dynamic_runtime_action_providers(configuration, {"fixture-provider": "fixture-model-key"})
        store, registry, engine = _runtime(tmp_path, root / f"tests/fixtures/artifacts/stream-safety-{mode}-v1", providers)
        app = FastAPI()
        app.include_router(RunnerAPI(GuardrailRuntimeService(engine, store, contexts=CallContextStore()),
            store, RunnerMetrics(4), Telemetry(), "fixture-relay", "fixture-controller-token").router)
        started = False
        try:
            async with tcp_server(app) as runner_url:
                await docker("run", "-d", "--pull=never", "--name", name, "-p", "127.0.0.1::4000",
                    "--mount", f"type=bind,source={root}/tests/fixtures/business-replay/litellm.yaml,target=/tmp/replay.yaml,readonly",
                    *code_mount,
                    "-e", f"BUSINESS_REPLAY_BASE={model_url.replace('127.0.0.1', 'host.docker.internal')}/v1",
                    "-e", f"TASKLATTICE_GUARD_API_BASE={runner_url.replace('127.0.0.1', 'host.docker.internal')}/runtime/v1/endpoints/fixture-endpoint",
                    "-e", f"TASKLATTICE_GUARD_API_KEY={RUNTIME_CREDENTIAL}",
                    "-e", f"REPLAY_PROXY_MASTER_KEY={proxy_key}",
                    "-e", "LITELLM_LOCAL_MODEL_COST_MAP=True", "-e", "DISABLE_ADMIN_UI=true",
                    image_id, "--config", "/tmp/replay.yaml", "--host", "0.0.0.0", "--port", "4000")
                started = True
                address = await docker("port", name, "4000/tcp")
                assert address.startswith("127.0.0.1:") and "\n" not in address
                async with httpx.AsyncClient(base_url=f"http://{address}", timeout=20, trust_env=False) as client:
                    async with asyncio.timeout(60):
                        while True:
                            try:
                                if (await client.get("/health/liveliness", timeout=1)).status_code == 200:
                                    break
                            except httpx.TransportError:
                                pass
                            assert await docker("inspect", name, "--format", "{{.State.Running}}") == "true"
                            await asyncio.sleep(0.2)

                    scenarios = ["cancel-before-first-frame", "safe", "blocked", "detector-failure", "cancel"]
                    if mode == "full_buffered":
                        scenarios.append("first-frame-timeout")
                    for scenario in scenarios:
                        upstream_entered.clear()
                        upstream_continue.clear()
                        upstream_closed.clear()
                        content, errors, finishes = [], [], []
                        received_content = asyncio.Event()
                        calls_before = business_calls
                        detector_before = len(detector_calls)

                        async def consume():
                            async with client.stream("POST", "/v1/chat/completions",
                                headers={"authorization": f"Bearer {proxy_key}"},
                                json={"model": "replay-model", "messages": [{"role": "user", "content": "Tell me a story."}], "stream": True}) as response:
                                if response.status_code != 200:
                                    # Before any SSE text is released, the proxy
                                    # may return a normal HTTP error instead.
                                    raw = await response.aread()
                                    error = json.loads(raw).get("error")
                                    assert isinstance(error, dict)
                                    errors.append({**error, "code": response.status_code})
                                    return
                                async for line in response.aiter_lines():
                                    if not line.startswith("data: ") or line == "data: [DONE]":
                                        continue
                                    data = json.loads(line[6:])
                                    if data.get("error"):
                                        errors.append(data["error"])
                                    for choice in data.get("choices", []):
                                        text = choice.get("delta", {}).get("content")
                                        if text:
                                            content.append(text)
                                            received_content.set()
                                        if choice.get("finish_reason"):
                                            finishes.append(choice["finish_reason"])

                        pending = asyncio.create_task(consume())
                        try:
                            await asyncio.wait_for(upstream_entered.wait(), 10)
                            if mode != "full_buffered" and scenario not in {"cancel-before-first-frame", "first-frame-timeout"}:
                                await asyncio.wait_for(received_content.wait(), 5)
                                expected_prefix = prefix if mode == "interruptible" else prefix[:-2048]
                                assert "".join(content) == expected_prefix
                                assert len(detector_calls) > detector_before
                            else:
                                await asyncio.sleep(0.1)
                                assert content == [] and len(detector_calls) == detector_before
                            assert not upstream_continue.is_set() and not pending.done()
                            if scenario in {"cancel", "cancel-before-first-frame"}:
                                pending.cancel()
                                with pytest.raises(asyncio.CancelledError):
                                    await pending
                                # Observe the actual business HTTP generator,
                                # not just the local client's cancellation.
                                await asyncio.wait_for(upstream_closed.wait(), 3)
                            elif scenario == "first-frame-timeout":
                                # The default Guard callback/idle timeout is 10s.
                                # Keep the producer stalled and require an actual
                                # 504 error frame, not just our client's timeout.
                                await asyncio.wait_for(pending, 15)
                                assert errors and int(errors[-1].get("code", 0)) == 504
                                assert content == [] and finishes == []
                                assert len(detector_calls) == detector_before
                                await asyncio.wait_for(upstream_closed.wait(), 3)
                            else:
                                upstream_continue.set()
                                await asyncio.wait_for(pending, 10)
                                if scenario == "safe":
                                    assert "".join(content) == prefix + safe_suffix
                                    assert errors == [] and finishes == ["stop"]
                                else:
                                    assert marker not in "".join(content)
                                    assert "".join(content) == ("" if mode == "full_buffered" else expected_prefix)
                                    assert errors and finishes == []
                                    code = int(errors[-1].get("code", 0))
                                    assert (code >= 500) if scenario == "detector-failure" else (400 <= code < 500)
                            assert business_calls == calls_before + 1
                            assert registry.readiness()["ready"] is True
                            print(json.dumps({"mode": mode, "scenario": scenario, "passed": True,
                                "client_characters": sum(map(len, content)), "detector_calls": len(detector_calls) - detector_before,
                                "proxy_image": image_id,
                                "relay_code_source": "baked-image" if baked_mode == "1" else "mounted-overlay"}))
                        finally:
                            upstream_continue.set()
                            if not pending.done():
                                pending.cancel()
                            await asyncio.gather(pending, return_exceptions=True)
        except Exception:
            if started:
                # Only synthetic fixture data is used; still strip credentials.
                process = await asyncio.create_subprocess_exec("docker", "logs", "--tail", "60", name,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
                output, _ = await asyncio.wait_for(process.communicate(), 10)
                print(output.decode().replace(proxy_key, "[redacted]").replace(RUNTIME_CREDENTIAL, "[redacted]")[-9000:])
            raise
        finally:
            if started:
                await docker("stop", "--time", "2", name)
                await docker("rm", name)
            await engine.shutdown()
