"""Detector matches are facts, independent of enforcement or native model labels."""
import json
from dataclasses import replace

import httpx
import pytest

from runner import generated as protocol
from runner.protocol_codec import action_bindings_from_proto, action_bindings_to_proto
from runner.toolkit.nemo.actions.content_filter import BuiltinContentFilter
from runner.toolkit.nemo.actions.automated_reasoning import ReasoningActionProvider
from runner.toolkit.nemo.actions.grounding import GroundingActionProvider
from runner.toolkit.nemo.actions.topic import TopicJudgeActionProvider
from runner.toolkit.nemo.evaluators.contracts import EvaluationResult, EvaluationUsage
from runner.toolkit.nemo.evaluators.safety_model import SafetyModelEvaluator
from runner.toolkit.runtime.contracts import (
    EVALUATOR_VERDICTS,
    AutomatedReasoningFinding,
    AutomatedReasoningPolicySnapshot,
    EvaluationTrigger,
    RiskFinding,
)
from runner.toolkit.safety.providers import build_safety_model_provider
from tests.control_plane.test_topic_allowlist import _request as topic_request
from tests.data_plane.test_grounding_context import request_with_context
from tests.test_safety_model_providers import _config, _request, _response


@pytest.mark.parametrize("verdict", sorted(EVALUATOR_VERDICTS))
def test_detector_result_and_wire_enum_share_the_four_values(verdict):
    assert EvaluationResult(verdict, "text").verdict == verdict
    assert EvaluationTrigger("on_result", "detector", (verdict,)).verdicts == (verdict,)
    name = f"EVALUATOR_VERDICT_{verdict.upper()}"
    assert protocol.EvaluatorVerdict.Name(protocol.EvaluatorVerdict.Value(name)) == name
    binding = {"id": "test", "trigger": {
        "type": "on_result", "step_ref": "detector", "verdicts": [verdict],
    }}
    message = action_bindings_to_proto([binding])[0]
    decoded = protocol.ActionBinding.FromString(message.SerializeToString())
    assert action_bindings_from_proto([decoded])[0]["trigger"] == binding["trigger"]


@pytest.mark.parametrize("verdict", ["safe", "unsafe", "uncertain", "allow", "block", "transform", ""])
def test_detector_boundary_rejects_legacy_labels_and_enforcement_decisions(verdict):
    with pytest.raises(ValueError, match="Detector result"):
        EvaluationResult(verdict, "text")
    with pytest.raises(ValueError, match="invalid detector result"):
        EvaluationTrigger("on_result", "detector", (verdict,))
    with pytest.raises(ValueError, match="invalid detector result"):
        RiskFinding("test", "test", verdict, None, "test", "allow")


@pytest.mark.parametrize("action", ["allow", "block", "transform"])
def test_a_rule_match_is_preserved_regardless_of_its_action(action):
    result = BuiltinContentFilter().evaluate(
        text="secret", phase="input", policies=(), custom_rules=({
            "id": "target", "phases": ["input"], "detector": "keyword",
            "keywords": ["secret"], "action": action, "replacement": "public",
        },),
    )
    assert result.verdict == "matched"
    assert result.findings[0].verdict == "matched"
    assert result.findings[0].recommended_action == action


@pytest.mark.parametrize("raw,expected", [
    ("Safety: Safe\nCategories: None", "not_matched"),
    ("Safety: Unsafe\nCategories: Violent", "matched"),
    ("Safety: Controversial\nCategories: Violent", "unknown"),
    ("not a classifier response", "error"),
])
async def test_native_safety_labels_are_normalized_at_the_detector_boundary(raw, expected):
    provider = build_safety_model_provider(
        _config("test", "qwen3guard", "test-model"),
        transport=httpx.MockTransport(lambda _: _response(raw)),
    )
    result = await SafetyModelEvaluator((provider,)).evaluate(_request("sample"))
    assert result.verdict == expected
    if expected == "matched":
        assert result.findings[0].provider_evidence[0].native_verdict == "unsafe"


@pytest.mark.parametrize("raw,expected", [
    ("on-topic", "not_matched"),
    ("off-topic", "matched"),
    (json.dumps({"verdict": "uncertain"}), "unknown"),
    ("{}", "error"),
    ("[]", "error"),
    (json.dumps({"verdict": "invalid"}), "error"),
])
async def test_topic_target_is_a_boundary_violation_and_invalid_responses_are_errors(raw, expected):
    provider = TopicJudgeActionProvider(
        base_url="http://topic.test/v1", model="topic", api_key_env_var=None,
        transport=httpx.MockTransport(lambda _: _response(raw)),
    )
    result = await provider.execute(topic_request("sample"))
    assert result.verdict == expected
    if expected == "error":
        assert result.findings == ()
        assert result.usage.model_calls[0].result == "invalid_response"


async def test_detector_timeout_is_error_not_unknown_or_a_match():
    def timeout(request):
        raise httpx.ReadTimeout("synthetic", request=request)
    provider = TopicJudgeActionProvider(
        base_url="http://topic.test/v1", model="topic", api_key_env_var=None,
        transport=httpx.MockTransport(timeout),
    )
    result = await provider.execute(topic_request("sample"))
    assert result.verdict == "error"
    assert result.findings == ()
    assert result.usage.model_calls[0].result == "timeout"


@pytest.mark.parametrize("support,score,expected", [
    ("supported", 1.0, "not_matched"),
    ("unsupported", 1.0, "matched"),
    ("uncertain", 1.0, "unknown"),
    ("uncertain", 0.1, "matched"),
    (None, 1.0, "error"),
])
async def test_grounding_distinguishes_missing_support_from_invalid_claims(support, score, expected):
    claim = {"claim": "The balance is 100.", "confidence": 0.9}
    if support is not None:
        claim["support"] = support
    raw = json.dumps({"grounding_score": score, "relevance_score": 1.0, "claims": [claim]})
    provider = GroundingActionProvider(
        base_url="http://grounding.test/v1", model="test", api_key="test-only",
        transport=httpx.MockTransport(lambda _: _response(raw)),
    )
    result = await provider.execute(request_with_context("What is the balance?", "The balance is 100."))
    assert result.verdict == expected
    if expected in {"matched", "unknown"}:
        assert result.findings[0].verdict == expected
        assert result.findings[0].claims[0].support == support


@pytest.mark.parametrize("outcomes,expected", [
    (("valid",), "not_matched"),
    (("invalid",), "matched"),
    (("satisfiable",), "unknown"),
    (("impossible",), "unknown"),
    (("translation_ambiguous",), "unknown"),
    (("too_complex",), "unknown"),
    (("no_translations",), "unknown"),
    (("valid", "satisfiable"), "unknown"),
    (("invalid", "too_complex"), "matched"),
    ((), "error"),
])
async def test_reasoning_distinguishes_proven_violation_from_inconclusive_proof(outcomes, expected):
    class Provider:
        async def evaluate(self, **kwargs):
            return tuple(AutomatedReasoningFinding(str(i), outcome, 0.9)
                         for i, outcome in enumerate(outcomes)), EvaluationUsage()

    request = request_with_context("What is the balance?", "The balance is 100.")
    snapshot = AutomatedReasoningPolicySnapshot("test", "test-policy", "1")
    request = replace(request, capability="automated_reasoning",
                      parameters=(("policy_snapshot_id", snapshot.id),),
                      plan=replace(request.plan, reasoning_policies=(snapshot,)))
    result = await ReasoningActionProvider(Provider()).execute(request)
    assert result.verdict == expected
    if expected in {"matched", "unknown"}:
        assert result.findings[0].verdict == expected
        assert {e.result for e in result.findings[0].reasoning} == set(outcomes)
