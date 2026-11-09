"""Studio DSL through Controller compilation and real NeMo; HTTP proof contract is simulated."""
import json
from pathlib import Path
import subprocess

import httpx
import pytest

from runner.compiler import DefaultRunnerCompiler
from runner.draft_preview import DraftPreviewRuntime
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.actions.automated_reasoning import HTTPAutomatedReasoningProvider, ReasoningActionProvider
from runner.toolkit.runtime.contracts import GuardContentBlock, ProtectionRequest, RequestContext


@pytest.fixture(scope="module")
def formal_plan():
    script = '''
      import { DeclarativeCompiler } from './server/policy-studio/declarative.ts';
      import { emptyPolicyDefinition } from './shared/policy-definition.ts';
      import { buildGuardrailPlan, normalizeGuardrailDraft } from './server/domain/guardrail-plan.ts';
      const definition = emptyPolicyDefinition();
      definition.metadata.id = 'studio-formal'; definition.metadata.name = 'Warranty'; definition.metadata.version = '1';
      definition.rules = [{id:'warranty-rule',name:'Warranty',description:'',stages:['output'],
        detector:{ref:'service/formal-verification',version:'1.0.0',parameters:{policy_id:'warranty',policy_version:'3',confidence_threshold:0.8}},
        on_match:{action:'block'},risk_level:'medium',metadata:{taxonomy_ids:['TALI-BUSINESS-POLICY']}}];
      const policy = new DeclarativeCompiler('../runner/toolkit/policy_library/assets').compile(definition);
      console.log(JSON.stringify(buildGuardrailPlan({guardrailId:'studio-formal',guardrailVersion:'20261012-020000.001Z',policies:[policy],
        draft:normalizeGuardrailDraft({policyBindings:[{policyId:policy.id,policyVersion:policy.version,enabledRuleIds:['warranty-rule'],enabledRails:['output']}]})})));
    '''
    result = subprocess.run(['node', '--import', 'tsx', '--input-type=module', '-e', script], cwd=Path(__file__).resolve().parents[2] / 'controller', capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


@pytest.mark.parametrize('proof,confidence,expected', [('valid', 1.0, 'allow'), ('invalid', 1.0, 'block'), ('translation_ambiguous', 1.0, 'block'), ('valid', 0.2, 'block'), ('http_error', 0.0, 'block')])
async def test_formal_rule_carries_context_and_retains_proof_evidence(formal_plan, proof, confidence, expected):
    calls = []
    def respond(request):
        body = json.loads(request.content); calls.append(body)
        assert body == {'policy': {'id': 'warranty', 'version': '3'}, 'query_content': 'Warranty duration?', 'guard_content': 'One year.', 'confidence_threshold': 0.8}
        if proof == 'http_error':
            return httpx.Response(404, json={'detail': 'Formal policy version is unavailable.'})
        return httpx.Response(200, json={'findings': [{'id': 'proof-1', 'result': proof, 'confidence': confidence}]})
    provider = ReasoningActionProvider(HTTPAutomatedReasoningProvider(endpoint_url='https://proof.test/evaluate', api_key='synthetic', transport=httpx.MockTransport(respond)))
    preview = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(provider))
    blocks = (GuardContentBlock(id='answer', text='One year.', role='model_output', trust='untrusted', source='response'),
              GuardContentBlock(id='query', text='Warranty duration?', role='query', trust='untrusted', source='request', qualifiers=('query',)))
    try:
        result = await preview.evaluate(ProtectionRequest(phase='output', texts=('One year.',), content_blocks=blocks, context=RequestContext(protocol='test'), evidence_scope='full'),
            preview_id='formal', guardrail_id='studio-formal', draft_revision=1, candidate_version=formal_plan['guardrail_version'], plan=formal_plan, runtime_profile='auto')
        assert result.decision == expected, result
        assert len(calls) == result.usage.model_invocations == 1
        if proof == 'http_error':
            assert not any(item.reasoning for item in result.findings)
            assert result.usage.fail_closed
            return
        finding = next(item for item in result.findings if item.reasoning)
        assert finding.policy_id == 'studio-formal'
        assert finding.rule_id == 'warranty-rule'
        assert finding.reasoning[0].result == proof
        assert finding.verdict == ('unknown' if confidence < 0.8 or proof == 'translation_ambiguous' else 'matched' if proof == 'invalid' else 'not_matched')
    finally:
        await preview.shutdown()
