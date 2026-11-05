"""Explicit opt-in model composition; production Default remains entirely local."""
import json
from pathlib import Path
import subprocess


def model_enabled_guardrail(insert_at: int = 2):
    source = """
      import { defaultGuardrailDraft, DEFAULT_GUARDRAIL_ID } from './server/domain/defaults.ts';
      import { buildGuardrailPlan } from './server/domain/guardrail-plan.ts';
      import { PolicyCatalog } from './server/policy-catalog/catalog.ts';
      import { generatedTestCases, applyValidationOverrides } from './server/domain/validation.ts';
      const policies = PolicyCatalog.load('../runner/toolkit/policy_library/assets').list();
      const draft = defaultGuardrailDraft(policies);
      draft.policyBindings.splice(__INSERT_AT__, 0, ...['builtin-jailbreak', 'builtin-content-safety'].map(id => {
        const policy = policies.find(p => p.id === id);
        return { policyId: id, policyVersion: policy.version, action: null, parameterValues: {},
          enabledRuleIds: policy.rules.map(r => r.id), ruleOrder: policy.rules.map(r => r.id),
          ruleActions: {}, enabledRails: [...policy.rails], reasoningPolicy: null, testCaseOverrides: {} };
      }));
      const plan = buildGuardrailPlan({guardrailId: DEFAULT_GUARDRAIL_ID,
        guardrailVersion: '20261020-090915.265Z', draft, policies});
      console.log(JSON.stringify({plan, cases: applyValidationOverrides(generatedTestCases(DEFAULT_GUARDRAIL_ID, draft, policies), draft)}));
    """
    source = source.replace("__INSERT_AT__", str(insert_at))
    return json.loads(subprocess.run(["node", "--import", "tsx", "--input-type=module", "-e", source],
        cwd=Path(__file__).resolve().parents[1] / "controller", check=True, capture_output=True,
        text=True, timeout=30).stdout)
