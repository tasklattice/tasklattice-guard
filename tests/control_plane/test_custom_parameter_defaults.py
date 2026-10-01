"""Controller default resolution must reach actual NeMo execution unchanged."""
import json
from pathlib import Path
import subprocess

import pytest

from runner.compiler import DefaultRunnerCompiler
from runner.draft_preview import DraftPreviewRuntime
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext


@pytest.fixture(scope="module")
def plans():
    script = r'''
      import { buildGuardrailPlan } from './server/domain/guardrail-plan.ts';
      import { programmablePolicyDraftSchema } from './server/policy-studio/model.ts';
      const snapshot = {
        ...programmablePolicyDraftSchema.parse({
          guardrail_category: 'content_safety',
          sources: [{path: 'checks.co', content: ['input', 'output'].map(phase =>
            `flow check_${phase} $text\n  $marker = "\${marker}"\n  $safe = $text != $marker\n  $r = await GuardRecordPolicyAction(flow_name="check_${phase}", safe=$safe, text=$text)\n`).join('\n')}],
          parameter_schema: [{name: 'marker', kind: 'string', required: true, default: 'banking'}],
          rail_bindings: ['input', 'output'].map(phase => ({rail_type: phase, flow_name: `check_${phase}`, execution_mode: 'detect', on_unsafe: 'block'})),
          action_references: [{name: 'GuardRecordPolicyAction', version: '1.0.0'}],
        }), policy_id: 'parameters', version: '1', name: 'Parameters', description: '',
        source: 'custom', owner: 'test', checksum: 'pinned', published_at: '2026-09-06',
      };
      const newer = structuredClone(snapshot);
      newer.version = '2'; newer.parameter_schema[0].default = 'newer-default';
      console.log(JSON.stringify([{}, {marker: 'securities'}].map(parameterValues => buildGuardrailPlan({
        guardrailId: 'parameters', guardrailVersion: '20260906-010000.001Z', programmablePolicies: [snapshot, newer],
        draft: {allowedTopics: [], restrictedTopics: [], safetyLevel: 'balanced', outputDelivery: 'full_buffered',
          policyBindings: [{policyId: 'parameters', policyVersion: '1', parameterValues, action: null,
            enabledRuleIds: ['flow/input/check_input', 'flow/output/check_output'], enabledRails: ['input', 'output'],
            ruleActions: {}, reasoningPolicy: null}]},
      }))));
    '''
    result = subprocess.run(["node", "--import", "tsx", "--input-type=module", "-e", script],
        cwd=Path(__file__).resolve().parents[2] / "controller", capture_output=True, text=True, check=True, timeout=30)
    return json.loads(result.stdout)


@pytest.mark.parametrize("phase", ["input", "output"])
@pytest.mark.parametrize("index,marker", [(0, "banking"), (1, "securities")])
async def test_controller_defaults_and_overrides_execute_on_pinned_policy(plans, phase, index, marker):
    plan = plans[index]
    assert plan["policy_bindings"][0]["parameter_values"] == [["marker", marker]]
    runtime = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers())
    try:
        for content, expected in [(marker, "block"), ("newer-default", "allow")]:
            result = await runtime.evaluate(ProtectionRequest(phase=phase, texts=(content,),
                context=RequestContext(protocol="test")), preview_id=f"parameters-{index}",
                guardrail_id=plan["guardrail_id"], draft_revision=1,
                candidate_version=plan["guardrail_version"], plan=plan, runtime_profile="auto")
            assert result.decision == expected
            assert not result.usage.fail_closed and result.usage.model_invocations == 0
    finally:
        await runtime.shutdown()
