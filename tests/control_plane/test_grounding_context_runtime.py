"""Controller-authored grounding Policy through compilation and real NeMo."""
import json
from pathlib import Path
import subprocess

import httpx
import pytest

from runner.compiler import DefaultRunnerCompiler
from runner.draft_preview import DraftPreviewRuntime
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.actions.grounding import GroundingActionProvider
from runner.toolkit.runtime.contracts import GuardContentBlock, ProtectionRequest, RequestContext


@pytest.fixture(scope="module")
def grounding_plan():
    source = """
      import { PolicyCatalog } from './server/policy-catalog/catalog.ts';
      import { buildGuardrailPlan } from './server/domain/guardrail-plan.ts';
      const policies = PolicyCatalog.load('../runner/toolkit/policy_library/assets').list();
      const policy = policies.find(p => p.id === 'builtin-contextual-grounding');
      const plan = buildGuardrailPlan({guardrailId:'grounding-context', guardrailVersion:'20260907-010000.001Z', policies,
        draft:{allowedTopics:[],restrictedTopics:[],safetyLevel:'balanced',outputDelivery:'full_buffered',policyBindings:[{
          policyId:policy.id,policyVersion:policy.version,action:'block',parameterValues:{},enabledRails:['output'],
          enabledRuleIds:policy.rules.map(r=>r.id),ruleActions:{},reasoningPolicy:null
        }]}});
      console.log(JSON.stringify(plan));
    """
    result = subprocess.run(["node", "--import", "tsx", "--input-type=module", "-e", source],
        cwd=Path(__file__).resolve().parents[2] / "controller", text=True, capture_output=True, check=True, timeout=30)
    return json.loads(result.stdout)


@pytest.mark.parametrize("context_text", [None, "", " \n", "Account balance: 100."])
async def test_grounding_missing_context_cannot_release_output(grounding_plan, context_text):
    calls = []
    def respond(request):
        calls.append(request)
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({
            "grounding_score": 1.0, "relevance_score": 1.0, "claims": [], "reason": "Grounded"})}}]})
    provider = GroundingActionProvider(base_url="https://grounding.test/v1", model="test-grounding",
        api_key="test-only", transport=httpx.MockTransport(respond))
    preview = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(provider))
    blocks = [GuardContentBlock(id="answer", text="The account balance is 100.", role="model_output",
        trust="untrusted", source="response"),
        GuardContentBlock(id="query", text="What is the balance?", role="user_input",
            trust="untrusted", source="request", qualifiers=("query",))]
    if context_text is not None:
        blocks.append(GuardContentBlock(id="source", text=context_text, role="user_input",
            trust="untrusted", source="request", qualifiers=("grounding_source",)))
    try:
        result = await preview.evaluate(ProtectionRequest(phase="output", texts=(blocks[0].text,),
            content_blocks=tuple(blocks), context=RequestContext(protocol="test")),
            preview_id="grounding-context", guardrail_id=grounding_plan["guardrail_id"], draft_revision=1,
            candidate_version=grounding_plan["guardrail_version"], plan=grounding_plan, runtime_profile="auto")
        if context_text and context_text.strip():
            assert result.decision == "allow", result
            assert len(calls) == result.usage.model_invocations == 1
        else:
            # Missing evidence blocks this answer; the application owns any follow-up.
            assert result.decision == "block", result
            assert result.action == "block"
            assert not result.texts
            assert calls == []
            assert result.usage.model_invocations == 0
            assert "grounding source" in result.reason.lower()
    finally:
        await preview.shutdown()
