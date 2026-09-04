from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from runner.toolkit.safety.jailbreak_detect import (
    jailbreak_detect_endpoint,
    parse_jailbreak_detect_response,
)
from runner.toolkit.safety.providers import SafetyModelProviderConfig, build_safety_model_provider

ENDPOINTS = json.loads((Path(__file__).parents[1] / "fixtures/jailbreak-detect-endpoints.json").read_text())


@pytest.mark.parametrize("base,expected", ENDPOINTS)
def test_endpoint_matches_controller_contract(base, expected):
    assert jailbreak_detect_endpoint(base) == expected


@pytest.mark.parametrize("base", ["https://user:secret@nim.test/v1", "https://nim.test/v1?token=secret", "https://nim.test/v1#fragment"])
def test_rejects_ambiguous_endpoint(base):
    with pytest.raises(ValueError):
        jailbreak_detect_endpoint(base)


@pytest.mark.parametrize("payload", [
    {}, [], {"jailbreak": "false", "score": 0.1}, {"jailbreak": 0, "score": 0.1},
    {"jailbreak": False}, {"jailbreak": False, "score": "0.1"},
    {"jailbreak": False, "score": True}, {"jailbreak": False, "score": float("nan")},
    {"jailbreak": False, "score": float("inf")}, {"jailbreak": True, "score": -1.1},
    {"jailbreak": True, "score": 1.1},
])
def test_malformed_responses_never_become_safe(payload):
    with pytest.raises(ValueError):
        parse_jailbreak_detect_response(payload)


def config(base="https://integrate.api.nvidia.com/v1"):
    return SafetyModelProviderConfig(
        id="detect", adapter="nemoguard_jailbreak_detect", base_url=base,
        model="nvidia/nemoguard-jailbreak-detect", api_key="leased-secret",
        contract_ref="tali.guard.jailbreak.v1", profile_ref="tali.nemoguard-jailbreak-detect.v1",
        transport="nemoguard_jailbreak_detect",
    )


@pytest.mark.parametrize("detected,score", [
    (False, -0.9935975138523108),
    (True, 0.9533652216609169),
])
async def test_native_classification_uses_raw_input_and_preserves_evidence(detected, score):
    def handler(request):
        assert str(request.url) == "https://ai.api.nvidia.com/v1/security/nvidia/nemoguard-jailbreak-detect"
        assert request.headers["authorization"] == "Bearer leased-secret"
        assert json.loads(request.content) == {"input": "actual user text"}
        return httpx.Response(200, json={"jailbreak": detected, "score": score})

    provider = build_safety_model_provider(config(), transport=httpx.MockTransport(handler))
    result = await provider.assess((
        {"role": "system", "content": "trusted system instructions"},
        {"role": "user", "content": "old user text"},
        {"role": "assistant", "content": "old response"},
        {"role": "user", "content": "actual user text"},
    ), scope="input")
    assert result.verdict == ("unsafe" if detected else "safe")
    assert result.categories == (("TALI-MODEL-SECURITY-JAILBREAK",) if detected else ())
    assert result.canonical_categories is True
    assert result.payload["jailbreak"] is detected
    assert "score" in result.raw_output
    assert provider.capabilities == frozenset({"jailbreak"})


@pytest.mark.parametrize("status", [401, 410, 500])
async def test_upstream_http_failure_does_not_produce_a_verdict(status):
    provider = build_safety_model_provider(config(), transport=httpx.MockTransport(lambda _: httpx.Response(status)))
    with pytest.raises(httpx.HTTPStatusError):
        await provider.assess(({"role": "user", "content": "test"},), scope="input")


async def test_rejects_unsupported_scope_without_a_request():
    calls = []
    provider = build_safety_model_provider(config(), transport=httpx.MockTransport(lambda request: calls.append(request)))
    with pytest.raises(ValueError, match="input detection only"):
        await provider.assess(({"role": "assistant", "content": "answer"},), scope="output")
    with pytest.raises(ValueError, match="user message"):
        await provider.assess(({"role": "system", "content": "instructions"},), scope="input")
    assert not calls


async def test_timeout_is_not_safe_and_retry_can_recover():
    attempts = []
    def handler(request):
        attempts.append(request)
        if len(attempts) == 1:
            raise httpx.ReadTimeout("timed out", request=request)
        return httpx.Response(200, json={"jailbreak": False, "score": 0.01})
    provider = build_safety_model_provider(config(), transport=httpx.MockTransport(handler))
    with pytest.raises(httpx.ReadTimeout):
        await provider.assess(({"role": "user", "content": "hello"},), scope="input")
    assert (await provider.assess(({"role": "user", "content": "hello"},), scope="input")).verdict == "safe"
