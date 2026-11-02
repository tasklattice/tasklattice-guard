"""Controller catalog bindings must drive real NeMo actions, not just audit DTOs."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess

import pytest

from runner.compiler import DefaultRunnerCompiler
from runner.draft_preview import DraftPreviewRuntime
from runner.toolkit.evaluation.contracts import CONTRACT_PII_EXACT, CONTRACT_PII_SEMANTIC
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.actions import EvaluationActionProvider, EvaluationRoute, local_action_providers
from runner.toolkit.nemo.evaluators.pii import PiiEvaluator
from runner.toolkit.nemo.evaluators.contracts import evaluation_result
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext


class RemainingPiiReview:
    """Deterministic semantic result for the Rule-action override tests."""

    id = "remaining-pii-review"
    version = "1.0.0"
    capabilities = frozenset({"pii"})
    contracts = frozenset({CONTRACT_PII_SEMANTIC})
    rails = frozenset({"input", "output"})

    async def evaluate(self, request):
        return evaluation_result(request, "not_matched", request.content)


@pytest.fixture(scope="module")
def catalog_plans():
    source = """
      import { PolicyCatalog } from './server/policy-catalog/catalog.ts';
      import { buildGuardrailPlan } from './server/domain/guardrail-plan.ts';
      const policies = PolicyCatalog.load('../runner/toolkit/policy_library/assets').list();
      const pii = policies.find(p => p.id === 'builtin-pii');
      const contact = policies.find(p => p.id === 'local-contact-data');
      const binding = (policy, phase) => ({ policyId: policy.id, policyVersion: policy.version,
        action: 'block', parameterValues: {}, enabledRuleIds: policy.rules.map(r => r.id),
        ruleActions: {}, enabledRails: [phase], reasoningPolicy: null });
      const entries = [];
      for (const phase of ['input', 'output']) for (const action of ['allow', 'transform', 'block']) {
        const selected = binding(pii, phase);
        selected.action = action === 'block' ? 'allow' : 'block';
        selected.ruleActions = { [pii.rules[0].id]: action };
        const plan = buildGuardrailPlan({ guardrailId: 'catalog-override', guardrailVersion: '20260906-010000.001Z', policies,
          draft: { allowedTopics: [], restrictedTopics: [], policyBindings: [selected], safetyLevel: 'balanced', outputDelivery: 'full_buffered' } });
        entries.push([`${phase}:${action}`, plan]);
        if (action === 'allow') {
          const later = binding(contact, phase); later.action = 'transform';
          entries.push([`${phase}:continue`, buildGuardrailPlan({ guardrailId: 'catalog-override', guardrailVersion: '20260906-010000.001Z', policies,
            draft: { allowedTopics: [], restrictedTopics: [], policyBindings: [selected, later], safetyLevel: 'balanced', outputDelivery: 'full_buffered' } })]);
        }
      }
      console.log(JSON.stringify(Object.fromEntries(entries)));
    """
    result = subprocess.run(
        ["node", "--import", "tsx", "--input-type=module", "-e", source],
        cwd=Path(__file__).resolve().parents[2] / "controller",
        text=True, capture_output=True, check=True, timeout=30,
    )
    return json.loads(result.stdout)


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["input", "output"])
@pytest.mark.parametrize("action", ["allow", "transform", "block", "continue"])
async def test_catalog_rule_action_reaches_real_nemo_and_preserves_later_policies(catalog_plans, phase, action):
    providers = action_providers(*local_action_providers(), EvaluationActionProvider((
        EvaluationRoute("pii", CONTRACT_PII_EXACT, PiiEvaluator()),
        EvaluationRoute("pii", CONTRACT_PII_SEMANTIC, RemainingPiiReview()),
    )))
    preview = DraftPreviewRuntime(DefaultRunnerCompiler(), providers)
    text = "Contact alice@example.com"
    try:
        result = await preview.evaluate(
            ProtectionRequest(phase=phase, texts=(text,), context=RequestContext(protocol="playground")),
            preview_id=f"{phase}-{action}", guardrail_id="catalog-override", draft_revision=1,
            candidate_version="20260906-010000.001Z", plan=catalog_plans[f"{phase}:{action}"], runtime_profile="auto",
        )
        assert not result.usage.fail_closed, result.reason
        assert result.usage.model_invocations == 0
        pii_findings = [finding for finding in result.findings if finding.policy_id == "builtin-pii"]
        if action == "continue":
            # The contact Rule consumes the email and the later PII observer still
            # runs. A read-only observer declares the phase input as its view, so
            # another Policy's redaction cannot silently erase its evidence.
            assert result.decision == "transform"
            assert [finding for finding in pii_findings if finding.recommended_action == "allow"]
            assert all(finding.verdict == "matched" for finding in pii_findings)
            assert result.texts == ("Contact [email_REDACTED]",)
            assert any(f.policy_id == "local-contact-data" and f.rule_id == "pattern/email" for f in result.findings)
            action_policies = [step.policy_id for step in result.trace if step.kind == "action"]
            assert "builtin-pii" in action_policies
            assert action_policies.index("local-contact-data") < action_policies.index("builtin-pii")
            continue_steps = [step for step in catalog_plans[f"{phase}:continue"]["steps"] if dict(step["parameters"]).get("policy_id") == "builtin-pii"]
            assert continue_steps and all(step["on_unsafe"] == "allow" for step in continue_steps)
            return
        assert pii_findings
        # Confidence and reject/redact/pass overrides cannot change Rule risk.
        assert all(finding.risk_severity == "medium" for finding in pii_findings)
        fragment_findings = [finding for assessment in result.assessments for fragment in assessment.fragments for finding in fragment.findings if finding.policy_id == "builtin-pii"]
        assert fragment_findings
        assert all(finding.risk_severity == "medium" for finding in fragment_findings)
        assert all(finding.policy_version == catalog_plans[f"{phase}:{action}"]["policy_bindings"][0]["policy_version"] for finding in pii_findings)
        assert result.decision == {"allow": "allow", "transform": "transform", "block": "block", "continue": "transform"}[action]
        if action == "allow":
            # Allow carries no replacement: endpoints forward the original.
            assert result.texts == ()
        elif action == "transform":
            assert "alice@example.com" not in result.texts[0]
            assert result.texts[0].startswith("Contact ")
    finally:
        await preview.shutdown()
