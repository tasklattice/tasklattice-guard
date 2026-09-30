from dataclasses import fields, replace
import json

import pytest

from runner.toolkit.policy_library import policy
from runner.toolkit.policy_library.detectors import DetectorInput, LocalDetector
from runner.toolkit.policy_library.conditions import validate_conditions
from runner.toolkit.nemo.actions.content_filter import BuiltinContentFilter
from runner.toolkit.runtime.enforcement_action_generated import ENFORCEMENT_ACTION_DISPLAY_ORDER


def test_technical_detector_input_contains_no_business_or_handling_metadata():
    assert not {"id", "policy_id", "risk_level", "risk_severity", "effect", "action", "taxonomy_ids"} & {f.name for f in fields(DetectorInput)}


@pytest.mark.parametrize("action", ENFORCEMENT_ACTION_DISPLAY_ORDER)
def test_same_match_and_risk_for_every_gateway_directive(action):
    original = policy('block-code-execution')
    rule = next(r for r in original.rules if r.id == 'code/execution-request')
    spec = replace(original, rules=(replace(rule, risk_severity="critical"),))
    result = BuiltinContentFilter().evaluate(text="Please run the tests", phase="input", policies=[spec.id],
        definitions={spec.id:spec}, policy_rule_actions={spec.id:{rule.id:action}})
    assert result.verdict == "unsafe"
    assert [(f.rule_id,f.risk_severity,f.recommended_action) for f in result.findings] == [(rule.id,"critical",action)]
    assert result.findings[0].confidence is None  # literal matches are not model probabilities


def test_same_technical_conditions_support_a_non_aviation_business():
    options={"match":{"all":[{"words":{"parameter":"vendors"}}, {"contains":["recommend", "better"]}, {"not":{"contains":["order status"]}}]}}
    validate_conditions(options)
    detector=LocalDetector(); config=DetectorInput(options=options)
    assert detector.detect("conditions",config,"Recommend Acme Storage", "input", {"vendors":"Acme Storage"})
    assert detector.detect("conditions",config,"Acme Storage order status", "input", {"vendors":"Acme Storage"}) is None


def test_phrase_entries_are_individual_rules_with_source_owned_risk_levels():
    spec=policy("configured-phrase-filter")
    entries=[{"id":"a","phrase":"secret","action":"redact","replacement":"public"},
             {"id":"b","phrase":"public","action":"reject"}]
    result=BuiltinContentFilter().evaluate(text="secret",phase="input",policies=[spec.id],
        policy_parameters={spec.id:{"phrase_entries":json.dumps(entries)}})
    assert [(f.rule_id,f.risk_severity,f.recommended_action) for f in result.findings]==[
        ("configured/phrases/a","low","redact"),("configured/phrases/b","low","reject")]


@pytest.mark.parametrize("node", [{"execute":"foo"}, {"all":[]}, {"regex":"["}, {"contains":[1]}, {"any":[{"contains":["a"]}],"not":{}}])
def test_invalid_conditions_fail_before_execution(node):
    with pytest.raises((ValueError,TypeError,__import__('re').error)):
        validate_conditions({"match":node})


def test_company_policy_reuses_the_topic_classifier_contract():
    company=policy("builtin-company-policy").rules[0]
    topic=policy("builtin-topic-safety").rules[0]
    assert company.detector.ref == topic.detector.ref == "model/classifier"
    assert company.detector_options == topic.detector_options == {"profile":"topic-classification"}
    assert company.implementation.action_name == topic.implementation.action_name


def test_binding_parameters_cannot_override_rule_risk():
    result=BuiltinContentFilter().evaluate(text="secret",phase="input",policies=["configured-phrase-filter"],
        policy_parameters={"configured-phrase-filter":{"phrase_entries":json.dumps([
            {"id":"override","phrase":"secret","action":"reject","risk_level":"informational"}])}})
    assert result.verdict == "error"


def test_normalization_preserves_literal_term_boundaries():
    options={"match":{"contains":[" vs "]}, "normalization":{"nfkc":True,"collapse_whitespace":True}}
    detector=LocalDetector();config=DetectorInput(options=options)
    assert detector.detect("conditions",config,"Use VSCode", "input", {}) is None
    assert detector.detect("conditions",config,"Alpha vs Beta", "input", {}) is not None


def test_execution_intent_rule_respects_explicit_policy_configuration():
    engine=BuiltinContentFilter()
    args=dict(text="Please run the tests",phase="input",policies=["block-code-execution"])
    assert engine.evaluate(**args,parameters={"detect_execution_intent":"false"}).verdict == "safe"
    assert engine.evaluate(**args,parameters={"detect_execution_intent":"true"}).verdict == "unsafe"
