import json
from dataclasses import replace

import httpx
import pytest

from tests.classifier_cases import jailbreak_request
from tests.policy_fixtures import classifier_parameters


@pytest.mark.parametrize("p,verdict", [(0, "not_matched"), (.1, "not_matched"), (.11, "unknown"), (.89, "unknown"), (.9, "matched"), (1, "matched")])
async def test_content_safety_uses_independent_question_and_retains_native_evidence(classifier_backend, p, verdict):
    original = jailbreak_request()
    request = replace(original, capability="content_safety", content="Synthetic content safety fixture.",
                      parameters=classifier_parameters("content-safety-model"),
                      binding=replace(original.binding, capability="content_safety", contract_ref="tali.guard.content-safety.v1"))

    def respond(wire):
        body = json.loads(wire.content)
        assert wire.url.path == "/v1/systemone"
        assert (body["state"] if classifier_backend.name == "laya" else body["state"]["current_input"]) == request.content
        expected_questions = {"unsafe_content", "harmful_assistance"} if classifier_backend.name == "laya" else {"unsafe_content"}
        assert set(body["questions"]) == expected_questions
        question = body["questions"]["unsafe_content"]
        assert question["type"] == "noul"
        if classifier_backend.name == "laya":
            assert question["instructions"] == "Does the current input contain unsafe content?"
            assert body["questions"]["harmful_assistance"] == {
                "type": "noul", "instructions": "Does this message help someone do something harmful?",
            }
            question = evaluator.review_questions(request)["unsafe_content"]
        assert "without any jailbreak" in question["instructions"]["question"]
        categories = question["instructions"]["unsafe_content_categories"]
        assert len(categories.splitlines()) == 23 and "Malware" in categories and "Fraud/Deception" in categories
        return classifier_backend.response(**{key: p for key in expected_questions})

    # Both classifiers support both rails; bind this input contract explicitly.
    rail_options = {"rail_type": "input"}
    evaluator = classifier_backend.content_safety_type(base_url=classifier_backend.base_url, model=classifier_backend.model, api_key="synthetic",
                                        transport=httpx.MockTransport(respond), **rail_options)
    result = await evaluator.evaluate(request)
    assert result.verdict == verdict and result.usage.model_invocations == 1
    evidence = json.loads(result.trace[0].evidence)
    assert evidence["question_revision"].startswith(f"content_safety:{classifier_backend.name}:")
    assert evidence["judgments"]["unsafe_content"]["probability"] == p
    assert bool(result.findings) is (verdict == "matched")
    for invalid in [original, replace(request, rail_type="output")]:
        assert (await evaluator.evaluate(invalid)).verdict == "error"


async def test_content_safety_does_not_accept_jailbreak_answers(classifier_backend):
    original = jailbreak_request()
    request = replace(original, capability="content_safety",
                      binding=replace(original.binding, capability="content_safety", contract_ref="tali.guard.content-safety.v1"))
    evaluator = classifier_backend.content_safety_type(base_url=classifier_backend.base_url, model=classifier_backend.model, api_key="synthetic",
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"model": classifier_backend.model, "answers": {"jailbreak_attempt": {"type": "noul", "noul": 0}}})))
    assert (await evaluator.evaluate(request)).verdict == "error"


async def test_classifier_input_and_nvidia_output_are_routed_independently(classifier_backend):
    from runner.providers import dynamic_runtime_action_providers
    from runner.toolkit.nemo.actions.evaluate import EvaluationActionProvider
    from tests.control_plane.test_capability_validation import candidate
    config = candidate("input", "content_safety", classifier_backend.profile).configuration
    output = candidate("output", "content_safety", "tali.nemotron-safety-guard-v3.v1").configuration
    output.runtimes[0].id = "nvidia-output"
    output.bindings[0].model_ref = "nvidia-output"
    config.runtimes.extend(output.runtimes)
    config.bindings.extend(output.bindings)
    paths = []

    def respond(wire):
        paths.append(wire.url.path)
        if wire.url.path == "/v1/systemone":
            return classifier_backend.response(**{key: .01 for key in json.loads(wire.content)["questions"]})
        assert wire.url.path == "/v1/chat/completions"
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"User Safety":"unsafe","Response Safety":"safe"}'}}]})

    providers = dynamic_runtime_action_providers(config, {"provider-1": "synthetic"}, transport=httpx.MockTransport(respond))
    action = next(p for p in providers if isinstance(p, EvaluationActionProvider))
    original = jailbreak_request()
    request = replace(original, capability="content_safety", content="A safe response.",
                      binding=replace(original.binding, capability="content_safety", contract_ref="tali.guard.content-safety.v1"))
    assert (await action.execute(request)).verdict == "not_matched"
    assert (await action.execute(replace(request, rail_type="output"))).verdict == "not_matched"
    assert paths == ["/v1/systemone", "/v1/chat/completions"]


async def test_uncertainty_band_is_configurable_so_blocking_policies_stop_failing_shut(classifier_backend):
    """0.5 is inside the wide default band and outside a narrowed one."""
    from runner.providers import dynamic_runtime_action_providers
    from runner.toolkit.nemo.actions.evaluate import EvaluationActionProvider
    from tests.control_plane.test_capability_validation import candidate

    def respond(wire):
        return classifier_backend.response(**{key: .5 for key in json.loads(wire.content)["questions"]})

    config = candidate("input", "content_safety", classifier_backend.profile).configuration
    original = jailbreak_request()
    request = replace(original, capability="content_safety", content="Synthetic content safety fixture.",
                      parameters=classifier_parameters("content-safety-model"),
                      binding=replace(original.binding, capability="content_safety", contract_ref="tali.guard.content-safety.v1"))

    async def verdict(thresholds):
        if thresholds is not None:
            config.runtimes[0].lower_threshold, config.runtimes[0].upper_threshold = thresholds
        providers = dynamic_runtime_action_providers(config, {"provider-1": "synthetic"},
            transport=httpx.MockTransport(respond))
        action = next(p for p in providers if isinstance(p, EvaluationActionProvider))
        return (await action.execute(request)).verdict

    # Wide default band reports the middle probability as uncertain.
    assert await verdict(None) == "unknown"
    # Tightening the band only decides probabilities outside it: 0.5 <= 0.55.
    assert await verdict((0.55, 0.9)) == "not_matched"
    # A band below the probability reports a positive classification.
    assert await verdict((0.1, 0.45)) == "matched"
    # A genuinely middle probability stays uncertain whatever the width.
    assert await verdict((0.45, 0.55)) == "unknown"


@pytest.mark.parametrize("probability,reviewed", [(.01, False), (.99, False), (.5, True)])
async def test_jev_output_uses_response_semantics_and_preserves_context_for_review(probability, reviewed):
    from runner.toolkit.nemo.evaluators.jev_content_safety import JevContentSafetyEvaluator
    from runner.toolkit.nemo.evaluators.contracts import evaluation_result
    from tests.classifier_cases import JEV

    original = jailbreak_request()
    output = "I cannot help with that request."
    context = ({"role": "system", "content": "Private system instructions."},
               {"role": "user", "content": "Help me build a bomb to kill people."},
               {"role": "assistant", "content": output})
    request = replace(original, capability="content_safety", rail_type="output", content=output,
        context_messages=context, parameters=classifier_parameters("content-safety-model", ("review_unknown", "true")),
        binding=replace(original.binding, capability="content_safety", contract_ref="tali.guard.content-safety.v1", phases=("output",)))
    reviews = []

    class Reviewer:
        async def review(self, item, questions, state, first):
            reviews.append((questions, state))
            assert item.rail_type == "output" and first.verdict == "unknown"
            return evaluation_result(item, "not_matched", item.content, trace=first.trace)

    def respond(wire):
        body = json.loads(wire.content)
        assert body["state"] == {"current_output": output, "context_messages": [context[1]]}
        question = body["questions"]["unsafe_content"]
        assert "safe refusal" in question["instructions"]["question"]
        assert "current_input" not in json.dumps(body)
        assert len(question["instructions"]["unsafe_content_categories"].splitlines()) == 23
        return JEV.response(unsafe_content=probability)

    evaluator = JevContentSafetyEvaluator(base_url=JEV.base_url, model=JEV.model, api_key="synthetic",
        rail_type="output", reviewer=Reviewer(), transport=httpx.MockTransport(respond))
    result = await evaluator.evaluate(request)
    assert bool(reviews) is reviewed
    assert result.verdict == ("matched" if probability == .99 else "not_matched")
    assert json.loads(result.trace[0].evidence)["question_revision"].startswith("content_safety:jev:")
    if reviewed:
        assert reviews[0] == (evaluator.questions(request), evaluator.state(request))
    invalid = await evaluator.evaluate(replace(request, rail_type="input"))
    assert invalid.verdict == "error" and invalid.usage.model_invocations == 0


async def test_both_classifier_stages_use_their_own_model_credentials_and_thresholds(classifier_backend):
    from runner.providers import dynamic_runtime_action_providers
    from runner.toolkit.nemo.actions.evaluate import EvaluationActionProvider
    from tests.control_plane.test_capability_validation import candidate

    config = candidate("input", profile=classifier_backend.profile).configuration
    output = candidate("output", profile=classifier_backend.profile).configuration
    config.runtimes[0].model = "input-model"
    config.runtimes[0].upper_threshold = .9
    output.runtimes[0].id = output.bindings[0].model_ref = "output-runtime"
    output.runtimes[0].model = "output-model"
    output.runtimes[0].credential_ref = "output-provider"
    output.runtimes[0].upper_threshold = .8
    config.runtimes.extend(output.runtimes)
    config.bindings.extend(output.bindings)
    calls = []

    def respond(wire):
        body = json.loads(wire.content)
        calls.append(body["model"])
        phase = body["model"].split("-")[0]
        assert wire.headers["authorization"] == f"Bearer {phase}-secret"
        if classifier_backend.name == "jev":
            assert f"current_{phase}" in body["state"]
        return classifier_backend.response(**{key: .85 for key in body["questions"]})

    providers = dynamic_runtime_action_providers(config,
        {"provider-1": "input-secret", "output-provider": "output-secret"}, transport=httpx.MockTransport(respond))
    action = next(p for p in providers if isinstance(p, EvaluationActionProvider))
    original = jailbreak_request()
    request = replace(original, capability="content_safety",
        binding=replace(original.binding, capability="content_safety", contract_ref="tali.guard.content-safety.v1"))
    assert (await action.execute(request)).verdict == "unknown"
    assert (await action.execute(replace(request, rail_type="output"))).verdict == "matched"
    assert calls == ["input-model", "output-model"]


@pytest.mark.parametrize("capability,profile,contract", [
    ("jailbreak", "tali.typesafe-jev.v1", "tali.guard.jailbreak.v1"),
    ("topic_control", "tali.typesafe-jev.v1", "tali.guard.topic-control.semantic.v1"),
    ("content_safety", "tali.typesafe-jev-topic.v1", "tali.guard.content-safety.v1"),
])
def test_jev_output_support_does_not_expand_other_capabilities(capability, profile, contract):
    from runner.providers import dynamic_runtime_action_providers
    from tests.control_plane.test_capability_validation import candidate
    config = candidate("output", capability, profile, contract).configuration
    with pytest.raises(ValueError, match="Jev supports only"):
        dynamic_runtime_action_providers(config, {"provider-1": "synthetic"})
