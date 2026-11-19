"""Production Controller HTTP client sends a signed historical version on demand."""
import asyncio
import json
from pathlib import Path

from fastapi import FastAPI

from runner import generated as protocol
from runner.api import RunnerAPI
from runner.metrics import RunnerMetrics
from runner.preparation import prepare
from runner.protocol_codec import artifact_content
from runner.toolkit.runtime.service import GuardrailRuntimeService
from tests.data_plane.test_artifact_execution import Telemetry, _desired_state, _runtime
from tests.tcp import tcp_server


async def test_controller_codec_and_playground_client_load_history_over_http(tmp_path):
    artifact = _desired_state().artifacts[0]
    store, registry, engine = _runtime(tmp_path)
    await prepare(store.apply, protocol.DesiredState(generation=store.generation + 1))
    telemetry = Telemetry()
    app = FastAPI()
    app.include_router(RunnerAPI(GuardrailRuntimeService(engine, store), store,
        RunnerMetrics(4), telemetry, "lazy-http", "test-controller-token").router)
    source = """
import { encodeArtifact } from './server/control-channel/artifact-codec.ts';
import { RunnerPlaygroundClient } from './server/playground/service.ts';
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString());
const runner = new RunnerPlaygroundClient({baseUrl: input.url, token: 'test-controller-token'});
const target = {kind: 'published', version: input.artifact.guardrailVersion,
  artifact: encodeArtifact(input.artifact, '../proto/tasklattice/guard/control/v1/runner_control.proto')};
const decisions = [];
for (const phase of ['input', 'output']) {
  decisions.push((await runner.evaluate({guardrailId: input.artifact.guardrailId, target,
    phase, text: 'Hello world', callId: 'playground:cross-language', history: []})).decision.decision);
}
console.log(JSON.stringify(decisions));
"""
    try:
        async with tcp_server(app) as url:
            process = await asyncio.create_subprocess_exec("node", "--import", "tsx", "--input-type=module", "-e", source,
                cwd=Path(__file__).resolve().parents[2] / "controller",
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            payload = {"url": url, "artifact": {"id": artifact.artifact_id, **artifact_content(artifact),
                "generation": int(artifact.generation), "checksum": artifact.checksum, "signature": artifact.signature}}
            try:
                stdout, stderr = await asyncio.wait_for(process.communicate(json.dumps(payload).encode()), 30)
                assert process.returncode == 0, stderr.decode()
                assert json.loads(stdout) == ["allow", "allow"]
            finally:
                if process.returncode is None:
                    process.kill()
                    await process.wait()
        assert store.observability_counts() == (0, 0, 0)
        assert not registry._current.prepared.candidates
        assert len(telemetry.events) == 2
    finally:
        await registry.shutdown()
