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
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext


class UnexpectedSemanticCall:
    """Register the required model dependency, but prove exact hits never call it."""

    id = "must-not-call-semantic-model"
    version = "1.0.0"
    capabilities = frozenset({"pii"})
    contracts = frozenset({CONTRACT_PII_SEMANTIC})
    rails = frozenset({"input", "output"})

    async def evaluate(self, request):
        raise AssertionError("An exact PII hit must not invoke the semantic model.")


@pytest.fixture(scope="module")
def catalog_plans():
    source = """
      import { PolicyCatalog } from './server/policy-catalog/catalog.ts';
      import { buildGuardrailPlan } from './server/domain/guardrail-plan.ts';
      const policies = PolicyCatalog.load('../runner/toolkit/policy_library/assets').list();
      const pii = policies.find(p => p.id === 'builtin-pii');
      const contact = policies.find(p => p.id === 'local-contact-data');
      const binding = (policy, phase) => ({ policyId: policy.id, policyVersion: policy.version,
        action: 'reject', parameterValues: {}, enabledRuleIds: policy.rules.map(r => r.id),
        ruleActions: {}, enabledRails: [phase], reasoningPolicy: null });
      const entries = [];
      for (const phase of ['input', 'output']) for (const action of ['pass', 'redact', 'reject']) {
        const selected = binding(pii, phase);
        selected.action = action === 'reject' ? 'pass' : 'reject';
        selected.ruleActions = { [pii.rules[0].id]: action };
        const plan = buildGuardrailPlan({ guardrailId: 'catalog-override', guardrailVersion: '20260906-010000.001Z', policies,
          draft: { allowedTopics: [], restrictedTopics: [], policyBindings: [selected], safetyLevel: 'balanced', outputDelivery: 'full_buffered' } });
        entries.push([`${phase}:${action}`, plan]);
        if (action === 'pass') {
          const later = binding(contact, phase); later.action = 'redact';
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
@pytest.mark.parametrize("action", ["pass", "redact", "reject", "continue"])
async def test_catalog_rule_action_reaches_real_nemo_and_preserves_later_policies(catalog_plans, phase, action):
    providers = action_providers(*local_action_providers(), EvaluationActionProvider((
        EvaluationRoute("pii", CONTRACT_PII_EXACT, PiiEvaluator()),
        EvaluationRoute("pii", CONTRACT_PII_SEMANTIC, UnexpectedSemanticCall()),
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
        assert result.decision == {"pass": "allow", "redact": "transform", "reject": "block", "continue": "transform"}[action]
        if action == "pass":
            # Allow carries no replacement: endpoints forward the original.
            assert result.texts == ()
        elif action in {"redact", "continue"}:
            assert "alice@example.com" not in result.texts[0]
            assert result.texts[0].startswith("Contact ")
        if action == "continue":
            assert any(f.policy_id == "local-contact-data" for f in result.findings)
    finally:
        await preview.shutdown()
