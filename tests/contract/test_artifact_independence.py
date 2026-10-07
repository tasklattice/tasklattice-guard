"""Cold-process proof that build and execution need no Policy Library package."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests/fixtures/artifacts"


@pytest.fixture
def isolated_runner(tmp_path):
    shutil.copytree(ROOT / "runner", tmp_path / "runner",
                    ignore=shutil.ignore_patterns("policy_library", "__pycache__"))
    assert not (tmp_path / "runner/toolkit/policy_library").exists()
    return tmp_path


def run_isolated(directory, source, *args):
    script = directory / "check.py"
    script.write_text(source)
    environment = {key: value for key, value in os.environ.items() if not key.startswith("GUARD_")}
    result = subprocess.run([sys.executable, "-I", str(script), *map(str, args)], cwd=directory,
                            env=environment, capture_output=True, text=True, timeout=90)
    assert result.returncode == 0, result.stdout + result.stderr


BOOTSTRAP = '''
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import importlib.util
assert importlib.util.find_spec("runner.toolkit.policy_library") is None
'''


def test_offline_compilation_preserves_all_frozen_artifacts_without_library(isolated_runner):
    run_isolated(isolated_runner, BOOTSTRAP + '''
import base64
from runner import generated as protocol
from runner.toolkit.compiler.artifact import ArtifactCompiler
from runner.toolkit.nemo.builtin_policies import prompt_catalog_yaml
from runner.protocol_codec import artifact_content

for path in sorted(Path(sys.argv[1]).glob("*/desired-state.pb.b64")):
    state = protocol.DesiredState.FromString(base64.b64decode(path.read_bytes()))
    for expected in state.artifacts:
        models = tuple(d.name for d in expected.dependency_manifest if d.kind == "model")
        compiler = ArtifactCompiler(builtin_prompts_yaml=prompt_catalog_yaml(), model_types=models)
        actual = compiler.compile(protocol.CompileRequest(
            guardrail_id=expected.guardrail_id, guardrail_version=expected.guardrail_version,
            generation=expected.generation, plan=expected.plan, runtime_profile=expected.runtime_profile,
        ))
        assert actual.checksum == expected.checksum, str(path)
        assert artifact_content(actual) == artifact_content(expected), str(path)
        assert not actual.signature and not actual.artifact_id
assert not any(name.startswith("runner.toolkit.policy_library") for name in sys.modules)
''', FIXTURES)


@pytest.mark.parametrize("fixture", ["preset-common-baseline-v1", "configured-phrases-v1", "custom-symbol-ownership-v1"])
def test_runner_serves_frozen_artifacts_with_library_directory_removed(isolated_runner, fixture):
    cases = ({"preset-common-baseline-v1": [
        ("ordinary support request", "NONE"),
        ("Acceptance sample: A@A.AA", "GUARDRAIL_INTERVENED"),
    ], "configured-phrases-v1": [("internal-name", "GUARDRAIL_INTERVENED"), ("confidential", "BLOCKED")],
        "custom-symbol-ownership-v1": [("hello", "NONE")]}[fixture])
    run_isolated(isolated_runner, BOOTSTRAP + '''
import asyncio, base64, json, os
import httpx
fixture = Path(sys.argv[1])
os.environ.update(GUARD_CONTROLLER_TOKEN="test-token-000000000000000000000000",
    GUARD_ARTIFACT_PUBLIC_KEY_PATH=str(fixture / "public-key.pem"),
    GUARD_RUNNER_STATE_PATH=str(Path(__file__).parent / "state"),
    GUARD_RUNNER_COMPILER_CAPABLE="false")
from runner import generated as protocol
from runner.main import app
from runner.preparation import prepare

async def check():
    store = app.state.artifact_store
    state = protocol.DesiredState.FromString(base64.b64decode((fixture / "desired-state.pb.b64").read_bytes()))
    await prepare(store.apply, state)
    app.state.runner_control._synchronized.set()
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
            assert (await client.get("/health/live")).status_code == 200
            assert (await client.get("/health/ready")).status_code == 200
            for phase in ("request", "response"):
                for content, expected in json.loads(sys.argv[2]):
                    response = await client.post("/runtime/v1/endpoints/fixture-endpoint/beta/litellm_basic_guardrail_api",
                        headers={"x-api-key": "fixture-runtime-secret"},
                        json={"input_type": phase, "texts": [content], "request_data": {}})
                    assert response.status_code == 200, response.text
                    assert response.json()["action"] == expected, response.text
    finally:
        await store._registry.shutdown()
    assert not any(name.startswith("runner.toolkit.policy_library") for name in sys.modules)

asyncio.run(check())
''', FIXTURES / fixture, json.dumps(cases))
