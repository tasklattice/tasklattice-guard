"""A released version is tested as it is: its signed Artifact, never compiled again."""
from types import SimpleNamespace

import pytest

from runner import generated as protocol
from runner.artifact_config import config_snapshot_from_artifact
from runner.compiler import DefaultRunnerCompiler
from runner.protocol_codec import plan_from_proto, plan_to_proto, validation_test_to_proto
from runner.serialization import plan_from_dict
from runner.validator import DefaultRunnerValidator
from tests.control_plane.test_custom_policy_dependencies import custom_plan

CHECK = 'flow check $text\n  await GuardRecordPolicyAction(flow_name="check", safe=True, text=$text)\n'


def _case(expected: str):
    return validation_test_to_proto({"id": "benign", "name": "Benign", "phase": "input",
                                     "content": "ordinary", "expectedDecision": expected, "required": True})


async def _released_artifact(plan) -> protocol.Artifact:
    """What publication stores: the candidate a passing draft run compiled."""
    outcome = await DefaultRunnerValidator(DefaultRunnerCompiler()).run(protocol.ValidationRequest(
        run_id="draft", guardrail_id=plan["guardrail_id"], candidate_version=plan["guardrail_version"],
        source_draft_revision=1, plan=plan_to_proto(plan), runtime_profile="auto", test_cases=[_case("allow")]))
    assert outcome.status == "passed", outcome.results
    return outcome.artifact


def _verifier(calls: list):
    def verify(artifact):
        calls.append(artifact.guardrail_version)
        return SimpleNamespace(plan=plan_from_dict(plan_from_proto(artifact.plan)), config=config_snapshot_from_artifact(artifact))
    return verify


@pytest.mark.parametrize(("expected", "status"), [("allow", "passed"), ("block", "failed")])
async def test_released_artifact_runs_its_suite_without_compiling(monkeypatch, expected, status):
    plan = custom_plan(CHECK, ["GuardRecordPolicyAction"])
    artifact = await _released_artifact(plan)
    calls: list[str] = []
    validator = DefaultRunnerValidator(DefaultRunnerCompiler(), verify_artifact=_verifier(calls))

    def never_compile(*_args, **_kwargs):
        raise AssertionError("A released version must not be compiled again.")

    monkeypatch.setattr(validator._compiler, "compile", never_compile)
    outcome = await validator.run(protocol.ValidationRequest(
        run_id="release-check", guardrail_id=plan["guardrail_id"], candidate_version=plan["guardrail_version"],
        runtime_profile="auto", artifact=artifact, test_cases=[_case(expected)]))
    assert calls == [plan["guardrail_version"]]
    # A behaviour other than the suite expects is a failed run, nothing more.
    assert outcome.status == status, outcome.results
    assert outcome.artifact == artifact


async def test_released_artifact_needs_a_verifier():
    plan = custom_plan(CHECK, ["GuardRecordPolicyAction"])
    artifact = await _released_artifact(plan)
    with pytest.raises(RuntimeError, match="cannot verify released Artifacts"):
        await DefaultRunnerValidator(DefaultRunnerCompiler()).run(protocol.ValidationRequest(
            run_id="release-check", guardrail_id=plan["guardrail_id"], candidate_version=plan["guardrail_version"],
            runtime_profile="auto", artifact=artifact, test_cases=[_case("allow")]))


async def test_signed_unsupported_released_artifact_is_rejected_before_cases_or_recompilation(tmp_path, monkeypatch):
    from runner.artifact_store import ArtifactStore
    from tests.test_runner_artifact_store import FIXTURE, unsupported_state
    artifact = unsupported_state().artifacts[0]
    store = ArtifactStore(FIXTURE / "public-key.pem", tmp_path)
    validator = DefaultRunnerValidator(DefaultRunnerCompiler(), verify_artifact=store.verify)
    def never_compile(*_args, **_kwargs):
        raise AssertionError("A signed unsupported version must not be silently recompiled.")
    monkeypatch.setattr(validator._compiler, "compile", never_compile)
    with pytest.raises(ValueError, match="artifact_recompile_required"):
        await validator.run(protocol.ValidationRequest(run_id="upgrade", guardrail_id=artifact.guardrail_id,
            candidate_version=artifact.guardrail_version, runtime_profile="auto", artifact=artifact,
            test_cases=[_case("allow")]))
