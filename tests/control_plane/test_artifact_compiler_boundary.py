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
