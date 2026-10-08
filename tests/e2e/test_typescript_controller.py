"""Production TS Controller transport/codec -> Python Runner over real gRPC.

The signed persisted Artifact is a fixture. Its conversion to wire data is
performed by the production Controller, never by a Python MockController.
Node dependencies are mandatory in this CI suite; missing setup must fail.
"""
import asyncio
import base64
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


@pytest.mark.parametrize("invalid_action", [None, "reject", "pass", "unspecified", "typo"])
async def test_typescript_controller_distributes_signed_artifact_or_rejects_invalid_action(tmp_path, invalid_action):
    desired = protocol.DesiredState.FromString(base64.b64decode((FIXTURE / "desired-state.pb.b64").read_bytes()))
    artifact = desired.artifacts[0]
    payload = {"artifact": {"id": artifact.artifact_id, **artifact_content(artifact),
        "generation": int(artifact.generation), "checksum": artifact.checksum, "signature": artifact.signature}}
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
                controller_target=f"127.0.0.1:{ready['port']}", controller_token="fixture-runner-token-at-least-32-characters")
            client = RunnerControlClient(settings, store, RunnerMetrics(4))
            client_task = asyncio.create_task(client._connect_once())
            if invalid_action is not None:
                with pytest.raises(grpc.aio.AioRpcError) as failure:
                    await asyncio.wait_for(client_task, 10)
                assert failure.value.code() == grpc.StatusCode.INTERNAL
                assert f"Invalid enforcement action {invalid_action}" in failure.value.details()
                assert store.generation == 0 and not client.synchronized
            else:
                result = json.loads(await asyncio.wait_for(process.stdout.readline(), 15))
                assert result == {"type": "ack", "desiredGeneration": 1, "distributionStatus": "ready"}
                assert store.generation == 1 and client.synchronized
                assert store.observability_counts() == (1, 0, 0)
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
