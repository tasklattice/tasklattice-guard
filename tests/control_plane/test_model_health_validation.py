"""Validation assertions are independent of model protocol health."""
import base64

from runner import generated as protocol
from runner.compiler import DefaultRunnerCompiler
from runner.protocol_codec import validation_test_to_proto
from runner.toolkit.nemo.action_registry import action_providers
from runner.validator import DefaultRunnerValidator
from tests.data_plane.test_failure_attribution import FIXTURE, answer, providers


async def test_valid_but_wrong_classification_fails_assertions_not_model_health():
    desired = protocol.DesiredState.FromString(base64.b64decode((FIXTURE / "desired-state.pb.b64").read_bytes()))
    artifact = desired.artifacts[0]
    actions = providers(lambda _: answer())
    result = await DefaultRunnerValidator(DefaultRunnerCompiler(), action_providers(*actions)).run(protocol.ValidationRequest(
        run_id="wrong-judgment", guardrail_id=artifact.guardrail_id, candidate_version=artifact.guardrail_version,
        plan=artifact.plan, test_cases=[validation_test_to_proto({"id":"expected-block", "name":"Expected block",
            "phase":"output", "content":"unsafe according to test", "expectedDecision":"block", "required":True})]))
    case = result.results[0]
    assert case["passed"] is False and case["actualDecision"] == "allow"
    assert case["modelStatus"] == "ok" and case["actualFailure"] is None
    assert case["executionStatus"] == "complete" and case["assertionFailures"]
