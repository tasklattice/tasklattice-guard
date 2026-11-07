"""Production TS Controller transport/codec -> Python Runner over real gRPC.

The signed persisted Artifact is a fixture. Its conversion to wire data is
performed by the production Controller, never by a Python MockController.
Node dependencies are mandatory in this CI suite; missing setup must fail.
"""
import asyncio
import base64
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import grpc
import pytest

from runner import generated as protocol
from runner.artifact_store import ArtifactStore
from runner.control_client import RunnerControlClient
from runner.metrics import RunnerMetrics
from runner.protocol_codec import artifact_content
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.actions import local_action_providers
from runner.toolkit.nemo.registry import NeMoRuntimeRegistry


ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "tests/fixtures/artifacts/local-secrets-v1"


async def _controller_observation(process, client_task):
    reading = asyncio.create_task(process.stdout.readline())
    try:
        done, _ = await asyncio.wait({reading, client_task}, timeout=15, return_when=asyncio.FIRST_COMPLETED)
        if client_task in done:
            await client_task
            raise AssertionError("Runner disconnected before the Controller observed its acknowledgement.")
        assert reading in done, "Controller did not observe the Runner acknowledgement."
        line = await reading
        assert line, "TypeScript Controller stopped before emitting the acknowledgement."
        return json.loads(line)
    finally:
        if not reading.done():
            reading.cancel()
        await asyncio.gather(reading, return_exceptions=True)


@pytest.mark.parametrize("invalid_action,credential_required", [
    (None, True), (None, False),
    *[(action, True) for action in ["reject", "pass", "unspecified", "typo", "PRIVATE_REPORT_CREDENTIAL_SENTINEL"]],
])
async def test_typescript_controller_distributes_signed_artifact_or_rejects_invalid_action(tmp_path, invalid_action, credential_required):
    desired = protocol.DesiredState.FromString(base64.b64decode((FIXTURE / "desired-state.pb.b64").read_bytes()))
    artifact = desired.artifacts[0]
    payload = {"artifact": {"id": artifact.artifact_id, **artifact_content(artifact),
        "generation": int(artifact.generation), "checksum": artifact.checksum, "signature": artifact.signature}}
    credential = "cross-language-test-credential"
    payload["endpoints"] = [{"endpointId": "cross-language-endpoint", "adapter": "litellm-generic-guardrail",
        "credentialRequired": credential_required, "scanFlagOnlyDefault": True,
        "verification": {"credentials": [{"id": "credential-1", "keyHint": "fixture",
            "sha256": hashlib.sha256(credential.encode()).hexdigest(), "createdAt": "2026-11-02T00:00:00Z"}]}}]
    if invalid_action is not None:
        payload["invalidAction"] = invalid_action
    with (tmp_path / "controller.log").open("w+") as log:
        process = await asyncio.create_subprocess_exec("node", "--import", "tsx", "scripts/control-channel-e2e.mjs",
            cwd=ROOT / "controller", stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=log)
        client_task = None
        try:
            process.stdin.write((json.dumps(payload) + "\n").encode())
            await process.stdin.drain()
            line = await asyncio.wait_for(process.stdout.readline(), 15)
            log.flush(); log.seek(0)
            assert line, f"TypeScript Controller did not start: {log.read()}"
            ready = json.loads(line)
            assert ready["type"] == "ready"
            store = ArtifactStore(FIXTURE / "public-key.pem", tmp_path / "state")
            registry = NeMoRuntimeRegistry(store, action_providers(*local_action_providers()))
            store.attach_registry(registry)
            settings = SimpleNamespace(runner_id="cross-language", pool_id="default", compiler_capable=False,
                max_concurrency=4, controller_ca_path=None, client_key_path=None, client_certificate_path=None,
                controller_target=f"127.0.0.1:{ready['port']}", controller_token="fixture-runner-token-at-least-32-characters", control_token=None)
            client = RunnerControlClient(settings, store, RunnerMetrics(4))
            client_task = asyncio.create_task(client._connect_once())
            if invalid_action is not None:
                with pytest.raises(grpc.aio.AioRpcError) as failure:
                    await asyncio.wait_for(client_task, 10)
                assert failure.value.code() == grpc.StatusCode.INTERNAL
                assert invalid_action not in failure.value.details()
                # The Runner answers the protection overlay that precedes the
                # rejected desired state, so its in-flight result can reach a
                # stream the Controller has just terminated. gRPC then reports
                # that local send failure instead of the redacted status; both
                # paths must stay redacted. The diagnostics below prove the
                # Controller's mapping either way.
                mapped = "Runner control request failed (unknown)."
                raced_send = (failure.value.details() == "Internal error from Core"
                              and "SendMessageOperation" in failure.value.debug_error_string())
                assert failure.value.details() == mapped or raced_send, failure.value.details()
                log.flush(); log.seek(0)
                controller_log = log.read()
                diagnostics = [json.loads(line) for line in controller_log.splitlines() if line.startswith("{")]
                assert any(item.get("event") == "runner.control_error" and item["error"]["category"] == "unknown"
                           for item in diagnostics)
                assert "Invalid enforcement action" not in controller_log
                assert "PRIVATE_REPORT_CREDENTIAL_SENTINEL" not in controller_log
                assert store.generation == 0 and not client.synchronized
            else:
                result = await _controller_observation(process, client_task)
                assert result == {"type": "ack", "desiredGeneration": 1, "distributionStatus": "ready"}
                assert store.generation == 1 and client.synchronized
                assert store.protection_generation == 1
                assert store.protection_mode(artifact.guardrail_id) == "bypass"
                assert store.observability_counts() == (1, 0, 1)
                access = store.authorize_endpoint("cross-language-endpoint", None)
                assert access.allowed is (not credential_required)
                assert access.authenticated is (False if credential_required else None)
                with_key = store.authorize_endpoint("cross-language-endpoint", credential)
                assert with_key.allowed
                assert with_key.authenticated is (True if credential_required else None)
                assert store.plan(artifact.guardrail_id, artifact.guardrail_version).guardrail_id == artifact.guardrail_id
                assert registry.readiness()["ready"]
        finally:
            if client_task is not None:
                client_task.cancel()
                await asyncio.gather(client_task, return_exceptions=True)
            if process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), 5)
                except TimeoutError:
                    process.kill()
                    await process.wait()
