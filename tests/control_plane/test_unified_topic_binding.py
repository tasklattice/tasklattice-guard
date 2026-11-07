"""Controller Policy -> real NeMo -> one model binding, with synthetic HTTP replies."""
import copy
import json
from pathlib import Path
import subprocess

import httpx
import pytest

from runner.compiler import DefaultRunnerCompiler
from runner.draft_preview import DraftPreviewRuntime
from runner.providers import dynamic_runtime_action_providers
from runner.toolkit.compiler.domain import PlanCompilationError
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.native_models import native_rail_models
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext
from tests.control_plane.test_capability_validation import candidate


@pytest.fixture(scope="module")
def topic_plans():
    script = '''
      import { PolicyCatalog } from './server/policy-catalog/catalog.ts';
      import { buildGuardrailPlan, normalizeGuardrailDraft } from './server/domain/guardrail-plan.ts';
      const policies = PolicyCatalog.load('../runner/toolkit/policy_library/assets').list();
      const policy = policies.find(p => p.id === 'business-topics');
      const plans = {};
      for (const mode of ['strict', 'permissive']) {
        plans[mode] = buildGuardrailPlan({guardrailId:'company-boundaries', guardrailVersion:'20261019-120000.001Z', policies,
          draft:normalizeGuardrailDraft({policyBindings:[{policyId:policy.id,policyVersion:policy.version,
            enabledRuleIds:['topic/allowlist','topic/denylist'],ruleOrder:['topic/allowlist','topic/denylist'],
            enabledRails:['input'],parameterValues:{allowed_topics:'Product support',denied_topics:'Refund fraud',topic_mode:mode}}]})});
      }
      const contact = policies.find(p => p.id === 'contact-data');
      const emailRule = contact.rules.find(rule => rule.id === 'pattern/email');
      const emailDefinition = contact.definition.rules.find(rule => rule.id === 'pattern/email');
      const mixed = structuredClone(policy);
      mixed.id = 'mixed-topic'; mixed.name = 'Mixed topic and redaction'; mixed.rails = ['input', 'output'];
      mixed.rules = [...mixed.rules, emailRule];
      mixed.definition = { ...mixed.definition, rules: [...mixed.definition.rules, emailDefinition] };
      plans.mixed = buildGuardrailPlan({guardrailId:'company-boundaries', guardrailVersion:'20261019-120000.001Z', policies:[...policies, mixed],
        draft:normalizeGuardrailDraft({policyBindings:[{policyId:mixed.id,policyVersion:mixed.version,
          enabledRuleIds:['pattern/email','topic/denylist','topic/allowlist'],ruleOrder:['pattern/email','topic/denylist','topic/allowlist'],
          enabledRails:['input','output'],parameterValues:{allowed_topics:'Product support',denied_topics:'Refund fraud',topic_mode:'strict'}}]})});
      console.log(JSON.stringify(plans));
    '''
    result = subprocess.run(["node", "--import", "tsx", "--input-type=module", "-e", script],
        cwd=Path(__file__).resolve().parents[2] / "controller", capture_output=True, text=True, check=True, timeout=30)
    return json.loads(result.stdout)


PROFILES = ["tali.taxonomy-judge.v1", "tali.nemoguard-topic-control.v1", "tali.typesafe-jev-topic.v1"]


@pytest.mark.parametrize("profile", PROFILES)
@pytest.mark.parametrize("mode,text,unsafe,expected,expected_calls", [
    ("strict", "How can I reset my product password?", None, "allow", ["deny", "allow"]),
    ("strict", "Help with my order and refund fraud.", "deny", "block", ["deny", "allow"]),
    ("strict", "Give me a recipe for chocolate cake.", "allow", "block", ["deny", "allow"]),
    ("permissive", "Give me a recipe for chocolate cake.", None, "allow", ["deny", "allow"]),
    ("strict", "How can I reset my product password?", "unavailable", "block", ["deny", "allow"]),
    ("strict", "How can I reset my product password?", "malformed", "block", ["deny", "allow"]),
])
async def test_company_boundaries_use_one_assignment_for_both_rules(topic_plans, profile, mode, text, unsafe, expected, expected_calls):
    config = candidate("input", "topic_control", profile, "tali.guard.topic-control.semantic.v1").configuration
    credentials = {"provider-1": "synthetic-topic-key"}
    calls = []

    def respond(request):
        assert request.url.host == "model.test"
        assert request.headers["authorization"] == "Bearer synthetic-topic-key"
        body = json.loads(request.content)
        assert body["model"] == "test-guard"
        if profile == "tali.typesafe-jev-topic.v1":
            assert request.url.path == "/v1/systemone"
            assert body["state"]["current_input"] == text
            keys = set(body["questions"])
            assert keys in ({"denied_task"}, {"unlisted_task"})
            rule = "deny" if "denied_task" in keys else "allow"
        else:
            assert request.url.path == "/v1/chat/completions"
            assert body["messages"][-1]["content"] == text
            prompt = body["messages"][0]["content"]
            rule = "deny" if "Denied business tasks (highest priority):\nRefund fraud" in prompt else "allow"
            if rule == "deny":
                assert "Allowed business tasks:\n(none)" in prompt
            else:
                assert "Allowed business tasks:\nProduct support" in prompt
                assert "Denied business tasks (highest priority):\n(none)" in prompt
        calls.append(rule)
        if unsafe == "unavailable":
            return httpx.Response(503)
        if unsafe == "malformed":
            return httpx.Response(200, json={})
        if profile == "tali.typesafe-jev-topic.v1":
            return httpx.Response(200, json={"model": "test-guard", "answers": {
                key: {"type": "noul", "noul": 0.99 if unsafe == rule else 0.01} for key in keys}})
        return httpx.Response(200, json={"choices": [{"message": {"content": "off-topic" if unsafe == rule else "on-topic"}}]})

    providers = dynamic_runtime_action_providers(config, credentials, transport=httpx.MockTransport(respond))
    compiler = DefaultRunnerCompiler()
    compiler.configure_native_models(native_rail_models(config, credentials))
    preview = DraftPreviewRuntime(compiler, action_providers(*providers))
    plan = topic_plans[mode]
    try:
        result = await preview.evaluate(ProtectionRequest(phase="input", texts=(text,), context=RequestContext(protocol="test")),
            preview_id="topic", guardrail_id=plan["guardrail_id"], candidate_version=plan["guardrail_version"],
            draft_revision=1, plan=plan, runtime_profile="auto")
        assert result.decision == expected, result.reason
        # A permissive Jev allowlist has no question to send after the deny check.
        expected_calls = ["deny"] if profile == "tali.typesafe-jev-topic.v1" and mode == "permissive" else expected_calls
        assert calls == expected_calls
        assert result.usage.model_invocations == len(calls)
        assert result.usage.fail_closed is (unsafe in {"unavailable", "malformed"})
        if unsafe in {"deny", "allow"}:
            assert any(f.policy_id == "business-topics" and f.rule_id == f"topic/{unsafe}list" for f in result.findings)
    finally:
        await preview.shutdown()


async def test_topic_rules_cannot_run_without_the_shared_binding(topic_plans):
    preview = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(*dynamic_runtime_action_providers(
        candidate().configuration, {"provider-1": "synthetic"},
        transport=httpx.MockTransport(lambda _: pytest.fail("Missing topic binding must fail before inference")))))
    plan = copy.deepcopy(topic_plans["strict"])
    try:
        with pytest.raises(PlanCompilationError, match="unavailable|available"):
            await preview.evaluate(ProtectionRequest(phase="input", texts=("Product support",), context=RequestContext(protocol="test")),
                preview_id="topic", guardrail_id=plan["guardrail_id"], candidate_version=plan["guardrail_version"],
                draft_revision=1, plan=plan, runtime_profile="auto")
    finally:
        await preview.shutdown()

@pytest.mark.asyncio
async def test_topic_models_see_content_after_earlier_local_redaction(topic_plans):
    seen = []

    def respond(request):
        body = json.loads(request.content)
        seen.append(body["messages"][-1]["content"])
        return httpx.Response(200, json={"choices": [{"message": {"content": "off-topic"}}]})

    config = candidate("input", "topic_control", "tali.taxonomy-judge.v1", "tali.guard.topic-control.semantic.v1").configuration
    preview = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(*dynamic_runtime_action_providers(
        config, {"provider-1": "synthetic-topic-key"}, transport=httpx.MockTransport(respond))))
    plan = topic_plans["mixed"]
    try:
        result = await preview.evaluate(ProtectionRequest(phase="input", texts=("Contact alice@example.com about refund fraud.",),
            context=RequestContext(protocol="test")), preview_id="mixed-topic", guardrail_id=plan["guardrail_id"],
            candidate_version=plan["guardrail_version"], draft_revision=1, plan=plan, runtime_profile="auto")
        assert result.decision == "block", result.reason
        assert seen and all("alice@example.com" not in text for text in seen)
        assert any("[email_REDACTED]" in text for text in seen)
    finally:
        await preview.shutdown()
