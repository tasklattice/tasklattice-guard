from __future__ import annotations

import json
import base64
from pathlib import Path
import subprocess

import pytest

from runner import generated as protocol
from runner.compiler import DefaultRunnerCompiler
from runner.draft_preview import DraftPreviewRuntime
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.actions import local_action_providers
from runner.toolkit.nemo.actions.content_filter import BuiltinContentFilter
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext
from runner.validator import DefaultRunnerValidator


ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def default_baseline() -> dict:
    # Exercise the actual Controller selection and plan builder, not a second
    # hand-written copy of the Default policy list. Draft compilation/validation
    # belongs to the control-plane suite; Runner-only tests still use artifacts.
    source = """
        import { defaultGuardrailDraft, DEFAULT_GUARDRAIL_ID } from './server/domain/defaults.ts';
        import { buildGuardrailPlan } from './server/domain/guardrail-plan.ts';
        import { PolicyCatalog } from './server/policy-catalog/catalog.ts';
        import { generatedTestCases, applyValidationOverrides } from './server/domain/validation.ts';
        import { planToWire, validationTestToWire } from './server/control-channel/protocol-codec.ts';
        import { loadSync } from '@grpc/proto-loader';
        import { loadPackageDefinition } from '@grpc/grpc-js';
        const policies = PolicyCatalog.load('../runner/toolkit/policy_library/assets').list();
        const draft = defaultGuardrailDraft(policies);
        const buildPlan = (bindings) => buildGuardrailPlan({
            guardrailId: DEFAULT_GUARDRAIL_ID,
            guardrailVersion: "20260904-010000.001Z",
            purpose: 'Default complete local Policy baseline',
            draft: { ...draft, policyBindings: bindings },
            policies,
        });
        const plan = buildPlan(draft.policyBindings);
        const cases = applyValidationOverrides(generatedTestCases(DEFAULT_GUARDRAIL_ID, draft, policies), draft);
        const definition = loadSync('../proto/tasklattice/guard/control/v1/runner_control.proto', {
            includeDirs: ['../proto/tasklattice/guard/control/v1'], longs: String, enums: String, defaults: true, oneofs: true,
        });
        const connect = loadPackageDefinition(definition).tasklattice.guard.control.v1.RunnerControl.service.Connect;
        const binary = connect.responseSerialize({ validationRequest: {
            runId: 'default-composition', guardrailId: DEFAULT_GUARDRAIL_ID,
            candidateVersion: "20260904-010000.001Z", sourceDraftRevision: 1, runtimeProfile: 'auto',
            plan: planToWire(plan), testCases: cases.map(validationTestToWire),
        }});
        console.log(JSON.stringify({plan, cases, wireRequest: binary.toString('base64')}));
    """
    result = subprocess.run(
        ["node", "--import", "tsx", "--input-type=module", "-e", source],
        cwd=ROOT / "controller",
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    return json.loads(result.stdout)


@pytest.fixture(scope="module")
def default_plan(default_baseline: dict) -> dict:
    return default_baseline["plan"]


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["input", "output"])
async def test_default_complete_policies_compile_and_run_without_models(
    default_plan: dict, phase: str, monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in (
        "OPENAI_API_KEY", "NVIDIA_API_KEY", "DEEPSEEK_API_KEY",
        "QWEN_GUARD_API_KEY", "QWEN_CONTROL_API_KEY", "LLAMA_GUARD_API_KEY",
    ):
        monkeypatch.delenv(name, raising=False)
    previews = DraftPreviewRuntime(
        DefaultRunnerCompiler(),
        action_providers(*local_action_providers()),
    )
    identity = {
        "preview_id": f"default-local-{phase}",
        "guardrail_id": "guardrail-default",
        "draft_revision": 1,
        "candidate_version": "20260904-010000.001Z",
        "plan": default_plan,
        "runtime_profile": "auto",
    }
    samples = [
        ("Passport: E12345678", "E12345678", "pattern/passport_china"),
        ("Passport: A12345678", "A12345678", "pattern/passport_us"),
        ("Passport: K1234567", "K1234567", "pattern/passport_singapore"),
        ("Passport: 12AB12345", "12AB12345", "pattern/passport_france"),
        ("NRIC: S1234567D", "S1234567D", "pattern/sg_nric"),
        ("Emirates ID: 784-1990-1234567-1", "784-1990-1234567-1", "pattern/uae_emirates_id"),
        ("BSN: 123456789", "123456789", "pattern/nl_bsn_contextual"),
        ("SIN: 123-456-782", "123-456-782", "pattern/ca_sin"),
        ("OHIP: 1234-567-890-AB", "1234-567-890-AB", "pattern/ca_ohip"),
        ("Driver licence: A1234-12345-12345", "A1234-12345-12345", "pattern/ca_on_drivers_licence"),
        ("Email: alice@example.com", "alice@example.com", "pattern/email"),
        ("Phone: +65 8123 4567", "8123 4567", "pattern/sg_phone"),
        ("Phone: +971 50 123 4567", "50 123 4567", "pattern/uae_phone"),
        ("Card: 4111 1111 1111 1111", "4111 1111 1111 1111", "pattern/visa"),
        ("IBAN: GB82WEST12345698765432", "GB82WEST12345698765432", "pattern/iban"),
        ("Bank account: 123-123456-1", "123-123456-1", "pattern/sg_bank_account"),
        ("Bank account: 12345-001-1234567", "12345-001-1234567", "pattern/ca_bank_account"),
        ("Address: 123 Main Street", "123 Main Street", "pattern/street_address"),
        # Complete Policies retain their non-PII behavior too. Default must not
        # silently omit these Rules from the selected Pattern Matching Policy.
        ("Connect to 192.168.1.1", "192.168.1.1", "pattern/ipv4"),
        ("Read https://example.com/docs", "https://example.com/docs", "pattern/url"),
    ]
    try:
        for index, (text, sensitive_value, rule_id) in enumerate(samples):
            decision = await previews.evaluate(
                ProtectionRequest(
                    phase=phase,
                    texts=(text,),
                    context=RequestContext(protocol="playground"),
                    call_id=f"default-pii-{phase}-{index}",
                ),
                **identity,
            )
            assert decision.decision == "transform", (rule_id, decision.reason)
            assert sensitive_value not in " ".join(decision.texts)
            expected_policy = "pattern-matching"
            if phase == "input" and rule_id in {"pattern/visa", "pattern/iban"}:
                expected_policy = "baseline-pii-protection"
                rule_id = rule_id.replace("pattern/", "financial-pii/")
            assert (expected_policy, rule_id) in {
                (finding.policy_id, finding.rule_id) for finding in decision.findings
            }
            assert decision.usage is not None
            assert decision.usage.model_invocations == 0
            assert decision.usage.fail_closed is False

        for index, text in enumerate((
            "How do I renew my passport?",
            "Explain how to redact personal information.",
            "Explain how this application works.",
        )):
            decision = await previews.evaluate(
                ProtectionRequest(
                    phase=phase,
                    texts=(text,),
                    context=RequestContext(protocol="playground"),
                    call_id=f"default-benign-{phase}-{index}",
                ),
                **identity,
            )
            assert decision.decision == "allow", decision.reason
            assert decision.action == "pass"
            # The runtime returns replacement texts only for transformations.
            assert decision.texts == ()
            assert decision.usage is not None
            assert decision.usage.model_invocations == 0
    finally:
        await previews.shutdown()


@pytest.mark.parametrize(("phase", "content", "expected_decision", "expected_text", "expected_policy"), [
    ("input", "TFN: 123 456 789", "transform", "TFN: [au_tfn_REDACTED]", "baseline-pii-protection"),
    ("input", "TFN: 12 345 678", "transform", "TFN: [au_tfn_REDACTED]", "baseline-pii-protection"),
    ("input", "AKIA0000000000000000", "block", None, "baseline-pii-protection"),
    ("input", "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "block", None, "baseline-pii-protection"),
    ("input", "Passport: E12345678", "transform", "Passport: [passport_china_REDACTED]", "pattern-matching"),
    ("output", "Passport: E12345678", "transform", "Passport: [passport_china_REDACTED]", "pattern-matching"),
])
async def test_reduced_default_retains_tax_ids_credentials_and_passports(
    default_plan: dict, phase: str, content: str, expected_decision: str,
    expected_text: str | None, expected_policy: str,
) -> None:
    # Guard the approved Policy-selection change without rewriting any source
    # Policy acceptance case or relaxing the Validator's source-Rule contract.
    assert "advanced-au-pii-protection" not in {
        binding["policy_id"] for binding in default_plan["policy_bindings"]
    }
    previews = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(*local_action_providers()))
    try:
        result = await previews.evaluate(
            ProtectionRequest(phase=phase, texts=(content,), context=RequestContext(protocol="playground")),
            preview_id="reduced-default", guardrail_id="guardrail-default",
            draft_revision=1, candidate_version="20260904-010000.001Z", plan=default_plan, runtime_profile="auto",
        )
        assert result.decision == expected_decision, result.reason
        if expected_text is not None:
            assert result.texts == (expected_text,)
        assert expected_policy in {finding.policy_id for finding in result.findings}
        assert result.usage.model_invocations == 0
        assert result.usage.fail_closed is False
    finally:
        await previews.shutdown()


def test_inherited_rule_acceptance_is_independent_of_composition(default_baseline: dict) -> None:
    # Test each original detector/action in isolation, with the source contract
    # unchanged. The separate full-chain test below exercises composition.
    engine = BuiltinContentFilter()
    for case in default_baseline["cases"]:
        result = engine.evaluate(
            text=case["content"], phase=case["phase"], policies=[case["policyId"]],
            enabled_rules={case["policyId"]: case["coveredRuleIds"]},
        )
        actions = {f.recommended_action for f in result.findings}
        actual = "block" if "reject" in actions else "transform" if actions else "allow"
        assert actual == case["expectedDecision"], case["sourceCaseId"]
        assert set(case["coveredRuleIds"]) & {f.rule_id for f in result.findings}


@pytest.mark.asyncio
async def test_default_validation_passes_all_reviewed_composition_cases(default_baseline: dict) -> None:
    cases = default_baseline["cases"]
    # Exercise the real TS codec -> Protobuf bytes -> Python codec boundary,
    # including nested expectations, before running the entire candidate.
    envelope = protocol.ControllerMessage.FromString(base64.b64decode(default_baseline["wireRequest"]))
    status, metrics, results = await DefaultRunnerValidator(
        DefaultRunnerCompiler(), action_providers(*local_action_providers()),
    ).validate(envelope.validation_request)
    conflicts = [item for item in results if not item["passed"]]
    assert status == "passed", conflicts
    assert metrics["total"] == len(cases) == 140
    assert metrics["passed"] == 140
    assert not conflicts
    assert all(case["required"] for case in cases)
    cases_by_id = {case["id"]: case for case in cases}
    for item in results:
        source = cases_by_id[item["caseId"]]
        if "expectationOverride" in source:
            assert item["templateExpectedDecision"] == source["expectedDecision"]
            assert item["expectationOverride"] == source["expectationOverride"]
        else:
            assert item["expectedDecision"] == source["expectedDecision"]
        assert item["coveredRuleIds"] == cases_by_id[item["caseId"]]["coveredRuleIds"]
    assert all(item["modelInvocations"] == 0 and item["actualFailure"] is None for item in results)
