"""Frozen signed preset releases: no Controller, compiler or Validator imports."""
from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from runner.api import RunnerAPI
from runner.metrics import RunnerMetrics
from runner.output_streaming import OutputStreamSessionStore
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext
from runner.toolkit.runtime.service import GuardrailRuntimeService
from tests.data_plane.test_artifact_execution import Telemetry, _runtime


FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "artifacts"
PRESETS = (
    "common-baseline", "banking-assistant", "securities-assistant",
    "internet-customer-support", "singapore-financial-assistant",
)

# Reviewed against the pinned Policy expressions and replacement strings, not
# generated from runtime results. In particular the passport rule replaces its
# context label too, while the US phone rule leaves the leading '+' untouched.
# Any new transform case must receive an explicit oracle before this suite passes.
EXACT_TRANSFORMS = {
    ("local-payment-data", "Acceptance sample: 4111 1111 1111 1111"): "Acceptance sample: [credit_card_REDACTED]",
    ("local-payment-data", "Acceptance sample: AA11AAAAAAAAAAA"): "Acceptance sample: [iban_REDACTED]",
    ("local-passports", "Passport: E12345678"): "[REDACTED]",
    ("local-passports", "护照号码：K1234567"): "[REDACTED]",
    ("local-passports", "Passport number: 12AB12345"): "[REDACTED]",
    ("local-contact-data", "Acceptance sample: A@A.AA"): "Acceptance sample: [email_REDACTED]",
    ("local-contact-data", "Acceptance sample: +1 (000) 000 0000"): "Acceptance sample: +[us_phone_REDACTED]",
    ("singapore-customer-identifiers", "Acceptance sample: S1111111A"): "Acceptance sample: [sg_nric_REDACTED]",
    ("singapore-customer-identifiers", "Acceptance sample: +65 6111 1111"): "Acceptance sample: [sg_phone_REDACTED]",
    ("singapore-customer-identifiers", "Acceptance sample: bank account 111-11111-1"): "Acceptance sample: bank account [sg_bank_account_REDACTED]",
}


def expected_text(case):
    if case["expectedDecision"] == "transform":
        return EXACT_TRANSFORMS[(case["sourcePolicyId"], case["content"])]
    assert case["expectedDecision"] == "allow"
    return case["content"]


def frozen(preset):
    directory = FIXTURES / f"preset-{preset}-v1"
    return directory, json.loads((directory / "manifest.json").read_text())


def test_every_pinned_transform_has_a_fixed_oracle_in_both_directions():
    covered = set()
    for preset in PRESETS:
        _, manifest = frozen(preset)
        cases = [case for case in manifest["regression_cases"] if case["expectedDecision"] == "transform"]
        for case in cases:
            key = (case["sourcePolicyId"], case["content"])
            assert expected_text(case) != case["content"]
            assert {other["phase"] for other in cases if (other["sourcePolicyId"], other["content"]) == key} == {"input", "output"}
            covered.add(key)
    assert covered == set(EXACT_TRANSFORMS)


@pytest.mark.asyncio
@pytest.mark.parametrize("preset", PRESETS)
async def test_signed_preset_cases_through_actual_adapter(tmp_path, preset):
    directory, manifest = frozen(preset)
    store, registry, engine = _runtime(tmp_path, directory)
    telemetry = Telemetry()
    app = FastAPI()
    app.include_router(RunnerAPI(
        GuardrailRuntimeService(engine, store), store, RunnerMetrics(4),
        telemetry, "fixture-runner", "controller-token",
    ).router)
    expected_action = {"allow": "NONE", "block": "BLOCKED", "transform": "GUARDRAIL_INTERVENED"}
    try:
        assert registry.readiness()["ready"]
        assert len(manifest["policy_ids"]) == len(set(manifest["policy_ids"]))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
            for case in manifest["regression_cases"]:
                response = await client.post(
                    "/runtime/v1/integrations/fixture-integration/beta/litellm_basic_guardrail_api",
                    headers={"x-api-key": "fixture-runtime-secret"},
                    json={"input_type": "request" if case["phase"] == "input" else "response",
                          "litellm_call_id": case["id"], "texts": [case["content"]], "request_data": {}},
                )
                assert response.status_code == 200, response.text
                result = response.json()
                assert result["action"] == expected_action[case["expectedDecision"]], (preset, case["name"], case["phase"], result)
                if case["expectedDecision"] == "transform":
                    assert result["texts"] == [expected_text(case)], (preset, case["id"], result)
                elif case["expectedDecision"] == "allow":
                    assert result.get("texts", [case["content"]]) == [case["content"]]
        assert len(telemetry.events) == len(manifest["regression_cases"])
    finally:
        await engine.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize("preset", PRESETS)
async def test_every_frozen_output_case_is_equivalent_when_split_across_stream_chunks(tmp_path, preset):
    directory, manifest = frozen(preset)
    store, _registry, engine = _runtime(tmp_path, directory)
    runtime = GuardrailRuntimeService(engine, store)
    streams = OutputStreamSessionStore(window_characters=8)
    context = RequestContext(protocol="litellm", integration_id="fixture-integration")
    try:
        for case in manifest["regression_cases"]:
            if case["phase"] != "output":
                continue
            request = ProtectionRequest(phase="output", texts=(case["content"],), call_id=case["id"], context=context)
            whole = await runtime.evaluate(request)
            assert whole.decision == case["expectedDecision"]
            assert whole.usage is not None and whole.usage.model_invocations == 0
            assert not whole.usage.fail_closed
            if whole.decision == "transform":
                assert whole.texts == (expected_text(case),)
            elif whole.decision == "allow":
                # A pass decision carries no replacement; the adapter/stream
                # must deliver the original text, checked below independently.
                assert whole.texts == ()
            assert runtime.output_delivery(request) == "full_buffered"
            # Force phrase, identity-number and injection-marker boundaries into
            # separate chunks. No prefix is released before the complete check.
            cut = max(1, len(case["content"]) // 2)
            first = await streams.process(stream_key=case["id"], sequence=0, text=case["content"][:cut], final=False,
                mode="full_buffered", request=replace(request, texts=("",)), evaluate=runtime.evaluate)
            assert first.released_text == "" and not first.terminate
            last = await streams.process(stream_key=case["id"], sequence=1, text=case["content"][cut:], final=True,
                mode="full_buffered", request=replace(request, texts=("",)), evaluate=runtime.evaluate)
            assert last.decision is not None
            assert last.decision.decision == whole.decision
            assert last.decision.effective_release_id == whole.effective_release_id
            if whole.decision == "block":
                assert last.terminate and last.released_text == ""
            else:
                assert last.released_text == expected_text(case)
    finally:
        await engine.shutdown()
