import json
from dataclasses import replace

import httpx
import pytest

from runner.toolkit.nemo.evaluators.jev_content_safety import JevContentSafetyEvaluator, QUESTION_REVISION
from tests.data_plane.test_jev_jailbreak import jailbreak_request


@pytest.mark.parametrize("p,verdict", [(0, "not_matched"), (.1, "not_matched"), (.11, "unknown"), (.89, "unknown"), (.9, "matched"), (1, "matched")])
async def test_content_safety_uses_independent_question_and_retains_native_evidence(p, verdict):
    original = jailbreak_request()
    request = replace(original, capability="content_safety", content="Synthetic content safety fixture.",
                      binding=replace(original.binding, capability="content_safety", contract_ref="tali.guard.content-safety.v1"))

    def respond(wire):
        body = json.loads(wire.content)
        assert wire.url.path == "/v1/systemone"
        assert body["state"]["current_input"] == request.content
        assert set(body["questions"]) == {"unsafe_content"}
        question = body["questions"]["unsafe_content"]
        assert question["type"] == "noul"
        assert "without any jailbreak" in question["instructions"]["question"]
        categories = question["instructions"]["unsafe_content_categories"]
        assert len(categories.splitlines()) == 23 and "Malware" in categories and "Fraud/Deception" in categories
        return httpx.Response(200, json={"model": "jev-1.13.0", "answers": {"unsafe_content": {"type": "noul", "noul": p}}})

    evaluator = JevContentSafetyEvaluator(base_url="https://typesafe.test/v1", model="jev-1.13.0", api_key="synthetic",
                                        transport=httpx.MockTransport(respond))
    result = await evaluator.evaluate(request)
    assert result.verdict == verdict and result.usage.model_invocations == 1
    evidence = json.loads(result.trace[0].evidence)
    assert evidence["question_revision"] == QUESTION_REVISION
    assert evidence["judgments"]["unsafe_content"]["probability"] == p
    assert bool(result.findings) is (verdict == "matched")
    for invalid in [original, replace(request, rail_type="output")]:
        assert (await evaluator.evaluate(invalid)).verdict == "error"


async def test_content_safety_does_not_accept_jailbreak_answers():
    original = jailbreak_request()
    request = replace(original, capability="content_safety",
                      binding=replace(original.binding, capability="content_safety", contract_ref="tali.guard.content-safety.v1"))
    evaluator = JevContentSafetyEvaluator(base_url="https://typesafe.test/v1", model="jev-1.13.0", api_key="synthetic",
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"model": "jev-1.13.0", "answers": {"jailbreak_attempt": {"type": "noul", "noul": 0}}})))
    assert (await evaluator.evaluate(request)).verdict == "error"


async def test_jev_input_and_nvidia_output_are_routed_independently():
    from runner.providers import dynamic_runtime_action_providers
    from runner.toolkit.nemo.actions.evaluate import EvaluationActionProvider
    from tests.control_plane.test_capability_validation import candidate
    config = candidate("input", "content_safety", "tali.typesafe-jev.v1").configuration
    output = candidate("output", "content_safety", "tali.nemotron-safety-guard-v3.v1").configuration
    output.runtimes[0].id = "nvidia-output"
    output.bindings[0].model_ref = "nvidia-output"
    config.runtimes.extend(output.runtimes)
    config.bindings.extend(output.bindings)
    paths = []

    def respond(wire):
        paths.append(wire.url.path)
        if wire.url.path == "/v1/systemone":
            return httpx.Response(200, json={"model": "jev-1.13.0", "answers": {"unsafe_content": {"type": "noul", "noul": .01}}})
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


async def test_uncertainty_band_is_configurable_so_blocking_policies_stop_failing_shut():
    """0.5 is inside the wide default band and outside a narrowed one."""
    from runner.providers import dynamic_runtime_action_providers
    from runner.toolkit.nemo.actions.evaluate import EvaluationActionProvider
    from tests.control_plane.test_capability_validation import candidate

    def respond(wire):
        return httpx.Response(200, json={"model": "jev-1.13.0", "answers": {"unsafe_content": {"type": "noul", "noul": .5}}})

    config = candidate("input", "content_safety", "tali.typesafe-jev.v1").configuration
    original = jailbreak_request()
    request = replace(original, capability="content_safety", content="Synthetic content safety fixture.",
                      binding=replace(original.binding, capability="content_safety", contract_ref="tali.guard.content-safety.v1"))

    async def verdict(thresholds):
        providers = dynamic_runtime_action_providers(config, {"provider-1": "synthetic"},
            transport=httpx.MockTransport(respond), jev_thresholds=thresholds)
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
