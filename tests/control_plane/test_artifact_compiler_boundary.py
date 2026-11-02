from __future__ import annotations

import base64
from pathlib import Path
import subprocess
import sys

from google.protobuf.json_format import MessageToJson
import pytest

from runner import generated as protocol
from runner.toolkit.compiler.artifact import ArtifactCompiler
from runner.toolkit.nemo.builtin_policies import prompt_catalog_yaml
from runner.toolkit.policy_runtime.snapshots import definitions_from_parameters


FIXTURE = Path(__file__).parents[1] / "fixtures/artifacts/configured-phrases-v1/desired-state.pb.b64"


def request():
    artifact = protocol.DesiredState.FromString(base64.b64decode(FIXTURE.read_bytes())).artifacts[0]
    return protocol.CompileRequest(guardrail_id=artifact.guardrail_id, guardrail_version=artifact.guardrail_version,
                                  generation=artifact.generation, plan=artifact.plan, runtime_profile=artifact.runtime_profile)


@pytest.mark.parametrize("missing", ["policy_definitions_json", "policy_versions_json"])
def test_compilation_rejects_catalog_references_without_frozen_content(missing):
    build = request()
    for step in build.plan.steps:
        if step.capability != "builtin_content_filter":
            continue
        kept = [pair for pair in step.parameters if pair.key != missing]
        del step.parameters[:]
        step.parameters.extend(kept)
    with pytest.raises(ValueError, match="all implementations must be embedded"):
        ArtifactCompiler(builtin_prompts_yaml=prompt_catalog_yaml()).compile(build)


def test_runtime_rejects_missing_policy_instead_of_resolving_the_catalog():
    with pytest.raises(ValueError, match="all implementations must be embedded"):
        definitions_from_parameters({"policy_ids": "configured-phrase-filter"})


def test_offline_cli_writes_the_same_unsigned_artifact(tmp_path):
    build = request()
    source, target = tmp_path / "request.json", tmp_path / "artifact.pb"
    source.write_text(MessageToJson(build))
    result = subprocess.run([sys.executable, "-m", "runner.toolkit.compiler", "--request", str(source),
                             "--output", str(target)], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    expected = ArtifactCompiler(builtin_prompts_yaml=prompt_catalog_yaml()).compile(build)
    assert protocol.Artifact.FromString(target.read_bytes()) == expected


def test_runner_offline_compiler_ignores_live_model_assignments(monkeypatch):
    from runner.compiler import DefaultRunnerCompiler
    from unittest.mock import Mock

    compiler = DefaultRunnerCompiler()
    compiler._compiler = Mock()
    compiler._compiler.compile.side_effect = AssertionError("Live compiler used")
    build = request()
    result = compiler.compile_offline(build)
    assert result.plan == build.plan
    assert result.guardrail_id == build.guardrail_id
    assert compiler.native_models == ()
    compiler._compiler.compile.assert_not_called()


@pytest.mark.asyncio
async def test_offline_compilation_returns_content_without_loading_or_leasing_models():
    import asyncio
    from runner.compiler import DefaultRunnerCompiler
    from tests.test_runner_control_client import _settings, Store, Metrics
    from runner.control_client import RunnerControlClient
    from unittest.mock import AsyncMock

    settings = _settings()
    settings.compiler_capable = True
    store = Store()
    client = RunnerControlClient(settings, store, Metrics(), compiler=DefaultRunnerCompiler())
    client._model_credentials = AsyncMock(side_effect=AssertionError("No credentials during compilation"))
    build = request()
    build.compile_id = "offline-1"
    await client._handle(protocol.ControllerMessage(artifact_compilation_request=build))
    reply = await asyncio.wait_for(client._outgoing.get(), timeout=10)
    assert reply.WhichOneof("body") == "artifact_compilation_result"
    assert reply.artifact_compilation_result.compile_id == "offline-1"
    assert reply.artifact_compilation_result.runner_id == "runner-0"
    assert reply.artifact_compilation_result.artifact.plan == build.plan
    assert reply.artifact_compilation_result.error == ""
    assert store.generation == 0
    client._model_credentials.assert_not_called()
    await asyncio.gather(*client._capability_tasks)
