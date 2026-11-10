"""Semantic PII through the Laya / JEV decision-model adapters."""
from __future__ import annotations

import json
import time

import httpx
import pytest

from runner import generated as protocol
from runner.capability_validation import validate_capability
from runner.compiler import DefaultRunnerCompiler
from runner.protocol_codec import plan_to_proto, validation_test_to_proto
from runner.providers import dynamic_runtime_action_providers
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.evaluation.contracts import CONTRACT_PII_SEMANTIC
from runner.toolkit.nemo.actions import EvaluationActionProvider
from runner.toolkit.nemo.evaluators.contracts import EvaluationRequest
from runner.toolkit.nemo.evaluators.jev_pii import JevPiiEvaluator
from runner.toolkit.nemo.evaluators.laya_pii import LayaPiiEvaluator
from runner.toolkit.runtime.contracts import GuardrailPlanSnapshot, NeMoActionBinding
from runner.validator import DefaultRunnerValidator
from tests.control_plane.test_capability_validation import candidate
from tests.test_pii_model_escalation import _case, _plan


def request(rail_type: str = "input", content: str = "My name is Alice Morgan.",
            action: str = "transform") -> EvaluationRequest:
    # Mirrors a published Guardrail: the plan carries the Policy-authored questions.
    definition = _policy_questions()
    plan = GuardrailPlanSnapshot(
        guardrail_id="decision-pii", guardrail_version="offline", compiler_version="offline-v1",
        safety_level="balanced", output_delivery="full_buffered", steps=())
    return EvaluationRequest(
        content=content, rail_type=rail_type, guardrail_id=plan.guardrail_id,
        guardrail_version=plan.guardrail_version, policy_id="pii-semantic", policy_version=1,
        trusted_context=(), content_blocks=(), deadline=time.monotonic() + 10, parameters=definition,
        capability="pii", proposed_action=action, plan=plan,
        binding=NeMoActionBinding(id="pii:semantic", capability="pii",
                                  contract_ref=CONTRACT_PII_SEMANTIC, phases=(rail_type,),
                                  on_unsafe=action),
        mode="enforce", evidence_scope="full", execution_purpose="online")


def laya_reply(body, **scores):
    answers = {name: {"type": "noul", "noul": scores.get(name, 0.01)} for name in body["questions"]}
    return httpx.Response(200, json={"model": "laya-test", "answers": answers,
                                     "usage": {"state_tokens": 8, "truncated": False}})


def jev_reply(body, score):
    return httpx.Response(200, json={"model": "jev-test", "answers": {
        "contains_pii": {"type": "noul", "noul": score}}})


async def test_laya_pii_match_transforms_the_complete_block():
    bodies = []

    def handler(wire):
        bodies.append(json.loads(wire.content))
        return laya_reply(bodies[-1], name=0.99, identifier=0.0, actual_identifier=0.0)

    evaluator = LayaPiiEvaluator(base_url="https://laya.test/v1", model="auto",
                                 api_key="synthetic", transport=httpx.MockTransport(handler))
    result = await evaluator.evaluate(request())

    assert result.verdict == "matched"
    assert result.content == "[PII_REDACTED]"
    assert result.findings[0].replacement == "[PII_REDACTED]"
    assert set(bodies[0]["questions"]) == {"name", "actual_identifier", "address", "dob"}
    assert bodies[0]["state"]["current_input"] == "My name is Alice Morgan."
    assert bodies[0]["state"]["context_messages"] == []


async def test_laya_pii_safe_and_unknown_keep_the_original_content():
    def handler(score):
        def respond(wire):
            return laya_reply(json.loads(wire.content), name=score)
        return respond

    safe = await LayaPiiEvaluator(base_url="https://laya.test/v1", model="auto", api_key="synthetic",
                                  transport=httpx.MockTransport(handler(0.01))).evaluate(request())
    unknown = await LayaPiiEvaluator(base_url="https://laya.test/v1", model="auto", api_key="synthetic",
                                     transport=httpx.MockTransport(handler(0.5))).evaluate(request())

    assert safe.verdict == "not_matched" and safe.content == "My name is Alice Morgan."
    assert unknown.verdict == "unknown" and unknown.content == "My name is Alice Morgan."


async def test_laya_pii_block_action_does_not_rewrite_content():
    def handler(wire):
        return laya_reply(json.loads(wire.content), name=0.99)

    result = await LayaPiiEvaluator(base_url="https://laya.test/v1", model="auto", api_key="synthetic",
                                    transport=httpx.MockTransport(handler)).evaluate(request(action="block"))
    assert result.verdict == "matched" and result.content == "My name is Alice Morgan."


async def test_jev_pii_output_state_and_transform():
    bodies = []

    def handler(wire):
        bodies.append(json.loads(wire.content))
        return jev_reply(bodies[-1], 0.99)

    evaluator = JevPiiEvaluator(base_url="https://jev.test/v1", model="jev-test",
                                api_key="synthetic", transport=httpx.MockTransport(handler))
    result = await evaluator.evaluate(request("output", "The customer is Alice Morgan."))

    assert result.verdict == "matched" and result.content == "[PII_REDACTED]"
    assert result.findings[0].replacement == "[PII_REDACTED]"
    assert bodies[0]["state"] == {"current_output": "The customer is Alice Morgan.",
                                  "context_messages": []}
    assert bodies[0]["questions"]["contains_pii"]["type"] == "noul"
    assert "personal_data_categories" in bodies[0]["questions"]["contains_pii"]["instructions"]


async def test_pii_output_is_allowed_for_laya_and_jev_but_other_output_checks_are_not():
    for profile in ("tali.laya.v1", "tali.typesafe-jev.v1"):
        configuration = candidate("output", "pii_semantic", profile, CONTRACT_PII_SEMANTIC).configuration
        providers = dynamic_runtime_action_providers(configuration, {"provider-1": "synthetic"},
                                                     transport=httpx.MockTransport(lambda wire: httpx.Response(500)))
        action = next(item for item in providers if isinstance(item, EvaluationActionProvider))
        assert ("pii", CONTRACT_PII_SEMANTIC, "output") in action.route_rail_keys
    with pytest.raises(ValueError, match="supports only"):
        dynamic_runtime_action_providers(
            candidate("output", "jailbreak", "tali.laya.v1", "tali.guard.jailbreak.v1").configuration,
            {"provider-1": "synthetic"})


@pytest.mark.parametrize("profile", ["tali.laya.v1", "tali.typesafe-jev.v1"])
async def test_pii_capability_probe_accepts_safe_and_unsafe_samples(profile):
    def respond(wire):
        body = json.loads(wire.content)
        text = body["state"]["current_input"] if isinstance(body["state"], dict) else body["state"]
        unsafe = "John Smith" in text
        if profile == "tali.laya.v1":
            scores = {key: (0.99 if unsafe else 0.01) for key in body["questions"]}
            return httpx.Response(200, json={"model": "laya-test", "answers": {
                key: {"type": "noul", "noul": score} for key, score in scores.items()}})
        return httpx.Response(200, json={"model": "jev-test", "answers": {
            "contains_pii": {"type": "noul", "noul": 0.98 if unsafe else 0.03}}})

    result = await validate_capability(
        candidate("input", "pii_semantic", profile, CONTRACT_PII_SEMANTIC),
        {"provider-1": "synthetic"}, transport=httpx.MockTransport(respond))
    assert result.passed, result.message
    assert [case.actual_decision for case in result.cases] == ["allow", "block"]
    unsafe = json.loads(result.cases[1].output_content)
    assert any(item["verdict"] == "matched" for item in unsafe["findings"])


async def test_laya_pii_plan_transforms_the_whole_block_after_local_redaction():
    configuration = candidate("input", "pii_semantic", "tali.laya.v1", CONTRACT_PII_SEMANTIC).configuration
    targets = []

    def respond(wire):
        body = json.loads(wire.content)
        text = body["state"]["current_input"]
        targets.append(text)
        return laya_reply(body, name=0.99 if "Alice Morgan" in text else 0.01)

    providers = action_providers(*dynamic_runtime_action_providers(
        configuration, {"provider-1": "synthetic"}, transport=httpx.MockTransport(respond)))
    plan = _plan()
    plan["steps"][1]["trigger"] = {"type": "always"}
    status, _, results = await DefaultRunnerValidator(DefaultRunnerCompiler(), providers).validate(
        protocol.ValidationRequest(
            run_id="laya-pii-plan", guardrail_id="laya-pii-plan",
            candidate_version="20261106-000000.001Z", source_draft_revision=1,
            plan=plan_to_proto(plan), runtime_profile="auto",
            test_cases=[
                validation_test_to_proto(_case(
                    "mixed", "My name is Alice Morgan and my email is alice@example.com.", "transform")),
                validation_test_to_proto(_case("benign", "Have a pleasant day.", "allow")),
            ]))
    assert status == "passed", results
    assert results[0]["outputContent"] == "[PII_REDACTED]"
    assert results[1]["outputContent"] == "Have a pleasant day."
    assert any("Alice Morgan" in text and "alice@example.com" not in text for text in targets)


# The semantic PII boundary is Policy content. The Runner adapter must submit
# exactly what the Policy package defines, and a published Guardrail may narrow
# or widen it per binding without a code change.

def _policy_questions() -> tuple[tuple[str, str], ...]:
    from tests.policy_fixtures import published_questions
    return published_questions("pii-semantic")


async def test_jev_pii_question_comes_from_the_policy_package():
    bodies = []

    def handler(wire):
        bodies.append(json.loads(wire.content))
        return jev_reply(bodies[-1], 0.99)

    evaluator = JevPiiEvaluator(base_url="https://jev.test/v1", model="jev-test",
                                api_key="synthetic", transport=httpx.MockTransport(handler))
    result = await evaluator.evaluate(request("input", "The customer is Alice Morgan."))

    import yaml as _yaml
    from tests.policy_fixtures import published_questions
    authored = {row["id"]: row for row in _yaml.safe_load(published_questions("pii-semantic")[0][1])}
    expected = authored["contains_pii"]
    question = bodies[0]["questions"]["contains_pii"]
    assert question["instructions"]["question"] == expected["instructions"]["question"].replace("{field}", "current_input")
    assert question["instructions"]["personal_data_categories"] == expected["instructions"]["personal_data_categories"]
    assert question["criteria"]["true"] == expected["criteria"]["true"].replace("{subject}", "current input")
    assert question["criteria"]["false"] == expected["criteria"]["false"].replace("{subject}", "current input")
    # Evidence records where the definition came from and its content fingerprint.
    import json as _json
    trace = json.loads(result.trace[-1].evidence)
    assert trace["definition_source"] == "published-guardrail"
    assert len(trace["definition_sha256"]) == 64 and trace["definition_revision"].startswith("pii:jev:")


async def test_guardrail_parameters_override_the_policy_definition():
    bodies = []

    def handler(wire):
        bodies.append(json.loads(wire.content))
        return jev_reply(bodies[-1], 0.2)

    evaluator = JevPiiEvaluator(base_url="https://jev.test/v1", model="jev-test",
                                api_key="synthetic", transport=httpx.MockTransport(handler))
    base = request("input", "Policy documents are attached.")
    import yaml as _yaml
    narrow = _yaml.safe_dump([{
        "id": "contains_pii",
        "providers": {"jev": "both"},
        "instructions": {"question": "Does state.{field} contain a home address?",
                         "personal_data_categories": "P1: home address"},
        "criteria": {"true": "The {subject} states where someone lives.",
                     "false": "The {subject} does not."},
    }], sort_keys=False)
    published = EvaluationRequest(**{
        **{name: getattr(base, name) for name in base.__slots__},
        "parameters": (("questions", narrow),),
    })
    await evaluator.evaluate(published)

    question = bodies[0]["questions"]["contains_pii"]
    assert question["instructions"]["question"] == "Does state.current_input contain a home address?"
    assert question["instructions"]["personal_data_categories"] == "P1: home address"
    assert question["criteria"]["true"] == "The current input states where someone lives."


async def test_online_traffic_uses_only_the_published_definition():
    """A Runner must never evaluate against questions the Guardrail did not publish."""
    from runner.toolkit.nemo.evaluators.policy_prompt import PromptDefinitionError, policy_questions
    # Online: no plan values, no catalog fallback.
    with pytest.raises(PromptDefinitionError, match="published Guardrail"):
        policy_questions("pii-semantic", "pii", ())
    # Validation: the probe has no published plan, so the Policy default applies.
    definition, source = policy_questions("pii-semantic", "pii", (), purpose="validation")
    assert source == "policy-default" and any(question.id == "contains_pii" for question in definition)
    # Published values win over the catalog, even during validation.
    published = (("questions", "- id: contains_pii\n  instructions: Published question."),)
    resolved, source = policy_questions("pii-semantic", "pii", published, purpose="validation")
    assert source == "published-guardrail" and resolved[0].instructions == "Published question."
    with pytest.raises(PromptDefinitionError):
        policy_questions("not-a-policy", "pii", (), purpose="validation")
