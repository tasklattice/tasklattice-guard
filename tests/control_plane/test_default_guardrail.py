from __future__ import annotations

import json
import base64
from pathlib import Path
import re
import subprocess

import pytest

from runner import generated as protocol
from runner.compiler import DefaultRunnerCompiler
from runner.draft_preview import DraftPreviewRuntime
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.actions import local_action_providers
from runner.toolkit.nemo.actions.content_filter import BuiltinContentFilter
from runner.toolkit.policy_library import policy as catalog_policy
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
        ("Passport: E12345678", "local-passport-formats", "pattern/passport_china", "Passport: [passport_china_REDACTED]"),
        ("Passport: A12345678", "local-passport-formats", "pattern/passport_us", "Passport: [passport_us_REDACTED]"),
        ("Passport: K1234567", "local-passport-formats", "pattern/passport_singapore", "Passport: [passport_singapore_REDACTED]"),
        ("Passport: 12AB12345", "local-passport-formats", "pattern/passport_france", "Passport: [passport_france_REDACTED]"),
        ("NRIC: S1234567D", "local-government-identifiers", "pattern/sg_nric", "NRIC: [sg_nric_REDACTED]"),
        ("Emirates ID: 784-1990-1234567-1", "local-government-identifiers", "pattern/uae_emirates_id", "Emirates ID: [uae_emirates_id_REDACTED]"),
        ("BSN: 123456789", "local-government-identifiers", "pattern/nl_bsn_contextual", "BSN: [nl_bsn_contextual_REDACTED]"),
        ("SIN: 123-456-782", "local-government-identifiers", "pattern/ca_sin", "SIN: [ca_sin_REDACTED]"),
        ("OHIP: 1234-567-890-AB", "local-government-identifiers", "pattern/ca_ohip", "OHIP: [ca_ohip_REDACTED]"),
        ("Driver licence: A1234-12345-12345", "local-government-identifiers", "pattern/ca_on_drivers_licence", "Driver licence: [ca_on_drivers_licence_REDACTED]"),
        ("Email: alice@example.com", "local-contact-data", "pattern/email", "Email: [email_REDACTED]"),
        ("Phone: +65 8123 4567", "local-regional-contact-formats", "pattern/sg_phone", "Phone: [sg_phone_REDACTED]"),
        ("Phone: +971 50 123 4567", "local-regional-contact-formats", "pattern/uae_phone", "Phone: [uae_phone_REDACTED]"),
        ("Card: 4111 1111 1111 1111", "local-payment-data", "financial-pii/credit_card", "Card: [credit_card_REDACTED]"),
        ("IBAN: GB82WEST12345698765432", "local-payment-data", "financial-pii/iban", "IBAN: [iban_REDACTED]"),
        ("Bank account: 123-123456-1", "local-bank-account-formats", "pattern/sg_bank_account", "Bank account: [sg_bank_account_REDACTED]"),
        ("Bank account: 12345-001-1234567", "local-bank-account-formats", "pattern/ca_bank_account", "Bank account: [ca_bank_account_REDACTED]"),
        ("Address: 123 Main Street", "local-regional-contact-formats", "pattern/street_address", "Address: [street_address_REDACTED]"),
        # Preserve the old Default's non-PII behavior through ordinary focused
        # Policies too; source collections remain unchanged in the library.
        ("Connect to 192.168.1.1", "local-network-addresses", "pattern/ipv4", "Connect to [ipv4_REDACTED]"),
        ("Read https://example.com/docs", "local-network-addresses", "pattern/url", "Read [url_REDACTED]"),
    ]
    try:
        for index, (text, expected_policy, rule_id, expected_output) in enumerate(samples):
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
            assert decision.texts == (expected_output,), (rule_id, decision.texts)
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
            assert [step.policy_id for step in decision.trace if step.kind == "action"] == [
                binding["policy_id"] for binding in default_plan["policy_bindings"] if phase in binding["enabled_rails"]
            ]
    finally:
        await previews.shutdown()


@pytest.mark.parametrize(("phase", "content", "expected_decision", "expected_text", "expected_policy"), [
    ("input", "TFN: 123 456 789", "transform", "TFN: [au_tfn_REDACTED]", "local-australian-tax-health-identifiers"),
    ("input", "TFN: 12 345 678", "transform", "TFN: [au_tfn_REDACTED]", "local-australian-tax-health-identifiers"),
    ("input", "AKIA0000000000000000", "block", None, "local-credentials"),
    ("input", "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "block", None, "local-credentials"),
    ("output", "AKIA0000000000000000", "block", None, "local-credentials"),
    ("output", "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "block", None, "local-credentials"),
    ("input", "Passport: E12345678", "transform", "Passport: [passport_china_REDACTED]", "local-passport-formats"),
    ("output", "Passport: E12345678", "transform", "Passport: [passport_china_REDACTED]", "local-passport-formats"),
])
async def test_focused_default_retains_tax_ids_credentials_and_passports(
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
            enabled_rules={case["policyId"]: case["coveredRuleIds"]} if case["coveredRuleIds"] else None,
        )
        actions = {f.recommended_action for f in result.findings}
        actual = "block" if "reject" in actions else "transform" if actions else "allow"
        assert actual == case["expectedDecision"], case["sourceCaseId"]
        if case["coveredRuleIds"]:
            assert set(case["coveredRuleIds"]) & {f.rule_id for f in result.findings}


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["input", "output"])
async def test_default_records_insults_and_still_enforces_later_policies(default_plan: dict, phase: str) -> None:
    previews = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(*local_action_providers()))
    try:
        for text, expected in (
            ("You should report any failure honestly.", "allow"),
            ("Please review this request: idiot.", "allow"),
            ("You should report any failure honestly. AKIA0000000000000000", "block"),
            ("You should report any failure honestly. Passport: E12345678", "transform"),
        ):
            result = await previews.evaluate(
                ProtectionRequest(phase=phase, texts=(text,), context=RequestContext(protocol="playground")),
                preview_id=f"default-observe-{phase}", guardrail_id="guardrail-default", draft_revision=1,
                candidate_version="20260904-010000.001Z", plan=default_plan, runtime_profile="auto",
            )
            assert result.decision == expected, result.reason
            observed = [f for f in result.findings if f.policy_id == "filter-denied-insults"]
            assert observed and all(f.recommended_action == "pass" for f in observed)
            assert observed[0].rule_id == "category/denied_insults"
            if expected == "allow":
                assert result.action == "pass" and result.texts == ()
            elif expected == "block":
                assert any(f.policy_id == "local-credentials" and f.recommended_action == "reject" for f in result.findings)
            else:
                assert result.texts == ("You should report any failure honestly. Passport: [passport_china_REDACTED]",)
            assert not result.usage.fail_closed and result.usage.model_invocations == 0
    finally:
        await previews.shutdown()


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
    assert metrics["total"] == len(cases) == 321
    assert metrics["passed"] == 321
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


@pytest.mark.asyncio
async def test_focused_default_replays_every_frozen_legacy_case(default_plan: dict) -> None:
    migration = json.loads((ROOT / "tests/fixtures/default-policy-migration.json").read_text())
    assert len(migration["cases"]) == 140
    assert len(migration["policyIds"]) == 18
    assert len({(case["policyId"], case["caseId"]) for case in migration["cases"]}) == 140
    source_engine = BuiltinContentFilter()
    previews = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(*local_action_providers()))
    try:
        for case in migration["cases"]:
            original = catalog_policy(case["policyId"])
            assert original is not None and original.version == migration["sourcePolicyVersion"]
            source = next(item for item in original.test_cases if item.id == case["caseId"])
            assert (source.content, source.phase) == (case["content"], case["phase"])
            expected_output = case.get("expectedOutputContent")
            if case["expectedDecision"] == "transform" and expected_output is None:
                # The unchanged legacy Rule, not the migrated composition, is
                # the reference when the old case had no composition override.
                isolated = source_engine.evaluate(text=source.content, phase=source.phase,
                    policies=[original.id], enabled_rules={original.id: source.covered_rule_ids})
                assert isolated.verdict != "error" and isolated.findings
                expected_output = isolated.content
            if expected_output is not None:
                # Consolidated card matching intentionally uses one generic
                # marker. Preserve every surrounding byte and redacted span.
                expected_output = re.sub(r"\[(visa|mastercard|amex|discover)_REDACTED\]", "[credit_card_REDACTED]", expected_output)
            result = await previews.evaluate(
                ProtectionRequest(phase=case["phase"], texts=(case["content"],),
                    context=RequestContext(protocol="playground")),
                preview_id="legacy-default-migration", guardrail_id="guardrail-default", draft_revision=1,
                candidate_version="20260904-010000.001Z", plan=default_plan, runtime_profile="auto",
            )
            identity = (case["policyId"], case["caseId"])
            # The frozen migration fixture remains unchanged; insults now has
            # an explicitly reviewed observation-only Default contract.
            expected_decision = "allow" if identity == ("filter-denied-insults", "accept/denied_insults") else case["expectedDecision"]
            assert result.decision == expected_decision, (identity, result)
            if result.decision == "transform":
                assert result.texts == (expected_output,), (identity, result.texts, expected_output)
            assert result.findings and all(finding.policy_id in {
                binding["policy_id"] for binding in default_plan["policy_bindings"]
            } for finding in result.findings), identity
            assert result.usage.model_invocations == 0 and not result.usage.fail_closed, identity
    finally:
        await previews.shutdown()
