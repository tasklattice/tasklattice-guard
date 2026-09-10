from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from runner import generated as protocol
from runner.capability_validation import validate_capability


def candidate(phase="input", capability="content_safety", profile="tali.qwen3guard.v1", contract="tali.guard.content-safety.v1"):
    binding_id = f"{capability}.{phase}"
    return protocol.CapabilityValidationRequest(request_id="candidate-1", binding_id=binding_id,
        credential_lease_id="lease-1", configuration=protocol.DataPlaneModelConfiguration(
            runtimes=[protocol.ModelRuntime(id="candidate-model", model="test-guard", profile_ref=profile,
                base_url="https://model.test/v1", credential_ref="provider-1", timeout_seconds=5, max_tokens=128)],
            bindings=[protocol.CapabilityBinding(binding_id=binding_id, capability_ref=capability,
                rail_type=protocol.RAIL_TYPE_INPUT if phase == "input" else protocol.RAIL_TYPE_OUTPUT,
                model_ref="candidate-model", profile_ref=profile, contract_refs=[contract])]))


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["input", "output"])
@pytest.mark.parametrize("profile", ["tali.qwen3guard.v1", "tali.nemotron-safety-guard-v3.v1"])
async def test_candidate_executes_the_real_nemo_rail_with_both_verdicts(phase, profile):
    calls = []

    async def respond(request):
        body = json.loads(request.content)
        calls.append(body)
        unsafe = "build a bomb" in str(body["messages"])
        if profile == "tali.qwen3guard.v1":
            content = "Safety: Unsafe\nCategories: Violent" if unsafe else "Safety: Safe\nCategories: None"
        else:
            content = json.dumps({"User Safety" if phase == "input" else "Response Safety": "unsafe" if unsafe else "safe", "Safety Categories": "Violence" if unsafe else "None"})
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

    result = await validate_capability(candidate(phase, profile=profile), {"provider-1": "synthetic-secret"}, transport=httpx.MockTransport(respond))
    assert result.passed, result.message
    assert len(result.cases) == 2
    assert [item.actual_decision for item in result.cases] == ["allow", "block"]
    assert result.runtime_profile.startswith("llmrails")
    assert len(calls) == 2
    if phase == "output":
        if profile == "tali.qwen3guard.v1":
            assert any(message["role"] == "assistant" for message in calls[0]["messages"])
        else:
            assert "response: agent: Have a pleasant day." in calls[0]["messages"][0]["content"]


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["always-safe", "http-error", "malformed"])
async def test_connection_success_or_fail_closed_is_not_behavioral_evidence(failure):
    async def respond(_request):
        if failure == "http-error":
            return httpx.Response(503, text="unavailable")
        content = "Safety: Safe\nCategories: None" if failure == "always-safe" else "invalid"
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})
    result = await validate_capability(candidate(), {"provider-1": "synthetic-secret"}, transport=httpx.MockTransport(respond))
    assert not result.passed
    assert any(not item.passed for item in result.cases)
    failed = [item for item in result.cases if not item.passed]
    assert all(item.input_content for item in failed)
    assert all(item.expected_decision in ("allow", "block") for item in failed)
    if failure == "always-safe":
        assert failed[0].expected_decision == "block"
        assert failed[0].actual_decision == "allow"
        assert "build a bomb" in failed[0].input_content
        assert json.loads(failed[0].output_content)["decision"] == "allow"
    assert "synthetic-secret" not in result.message


@pytest.mark.asyncio
async def test_capability_requires_scoped_credentials_and_a_valid_phase():
    request = candidate()
    missing = await validate_capability(request, {})
    assert not missing.passed
    assert "credential lease" in missing.message
    request.configuration.bindings[0].rail_type = protocol.RAIL_TYPE_RETRIEVAL
    invalid = await validate_capability(request, {"provider-1": "synthetic-secret"})
    assert not invalid.passed
    assert "Input/Output" in invalid.message


@pytest.mark.asyncio
async def test_recorded_input_502_is_not_counted_as_successful_detection():
    fixture = Path(__file__).resolve().parents[1] / 'fixtures/model_responses/20260908-nvidia-smoke.json'
    cases = [case for case in json.loads(fixture.read_text())['cases'] if case['id'] in (2, 3)]
    calls = []

    def replay(request):
        body = json.loads(request.content)
        case = next(case for case in cases if case['request'] == body)
        calls.append(case['id'])
        return httpx.Response(case['status'], json=case['response'])

    request = candidate(profile='tali.nemotron-safety-guard-v3.v1')
    request.configuration.runtimes[0].model = cases[0]['request']['model']
    request.configuration.runtimes[0].max_tokens = 1024
    result = await validate_capability(request, {'provider-1': 'synthetic-recording-only'},
                                       transport=httpx.MockTransport(replay))
    assert calls == [2, 3]
    assert result.passed is False
    assert result.cases[0].passed is True
    assert result.cases[1].actual_decision == 'block'
    assert result.cases[1].passed is False
