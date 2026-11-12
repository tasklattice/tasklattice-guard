"""Shipped Policy -> Controller plan -> Jev/Laya -> real HTTP response evidence."""
from dataclasses import replace
import json
from pathlib import Path
import os
import subprocess

import httpx
from fastapi import FastAPI

from runner.api import RunnerAPI
from runner.toolkit.runtime.outcome import require_online_result
from runner.compiler import DefaultRunnerCompiler
from runner.draft_preview import DraftPreviewRuntime
from runner.providers import dynamic_runtime_action_providers
from runner.toolkit.nemo.action_registry import action_providers
from tests.control_plane.test_capability_validation import candidate
from tests.data_plane.test_scan import Store, SCAN_URL
from tests.test_runner_api import Metrics, Telemetry

ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = {"jailbreak": "tali.guard.jailbreak.v1", "content_safety": "tali.guard.content-safety.v1",
             "topic_control": "tali.guard.topic-control.semantic.v1"}


def build_controller_plan(*, phase="input", pii_only=False):
    source = """
      import { PolicyCatalog } from './server/policy-catalog/catalog.ts';
      import { DeclarativeCompiler } from './server/policy-studio/declarative.ts';
      import { buildGuardrailPlan } from './server/domain/guardrail-plan.ts';
      const compiler = new DeclarativeCompiler('../runner/toolkit/policy_library/assets');
      const policies = PolicyCatalog.load('../runner/toolkit/policy_library/assets').list().map(p => compiler.catalogView(p));
      const phase = process.env.GUARD_TEST_PHASE ?? 'input';
      const ids = process.env.GUARD_TEST_PII === 'true' ? ['pii-semantic'] : phase === 'output' ? ['content-safety-model'] : ['content-safety-model', 'prompt-instruction-attacks', 'business-topics',
                   'content-filters', 'regional-compliance-sg-pdpa'];
      const bindings = ids.map(id => {
        const p = policies.find(p => p.id === id);
        const rules = id === 'business-topics' ? ['topic/denylist'] : p.rules.map(r => r.id);
        return { policyId: id, policyVersion: p.version, action: null, enabledRails: [phase],
          enabledRuleIds: rules, ruleOrder: rules, ruleActions: {}, reasoningPolicy: null,
          parameterValues: id === 'content-filters' ? {blocked_words: 'CHAIN_BLOCK', brand_name: 'TaskLattice', competitors: 'Example', phrase_entries: JSON.stringify([{ id: 'x', phrase: 'CHAIN_BLOCK', action: 'block', replacement: '[REDACTED]' }])} :
            {on_unknown: 'allow', topic_mode: 'permissive', denied_topics: 'Synthetic forbidden task'} };
      });
      console.log(JSON.stringify(buildGuardrailPlan({guardrailId: 'classifier-chain',
        guardrailVersion: '20261029-000000.001Z', policies,
        draft: {allowedTopics: [], restrictedTopics: [], safetyLevel: 'balanced',
                outputDelivery: 'full_buffered', policyBindings: bindings}})));
    """
    result = subprocess.run(["node", "--import", "tsx", "--input-type=module", "-e", source],
                            cwd=ROOT / "controller", capture_output=True, text=True, check=True, timeout=60,
                            env={**os.environ, "GUARD_TEST_PHASE":phase,
                                 "GUARD_TEST_PII":"true" if pii_only else "false"})
    return json.loads(result.stdout)


async def scan(plan, probabilities, *, content="An ordinary synthetic request.", fault=None,
               backend, topic_profile=None, scope="full", review=None, review_fault=None, reviewer_binding=True,
               reviewer_profile="tali.classifier-review.v1", require_evidence=True, phase="input", reviewer_phase=None,
               pii_only=False, guard_context=None):
    topic_profile = topic_profile or backend.profile
    config = candidate("input", "jailbreak", backend.profile, CONTRACTS["jailbreak"]).configuration
    for capability in ("content_safety", "topic_control"):
        other = candidate("input", capability, backend.profile, CONTRACTS[capability]).configuration
        config.bindings.extend(other.bindings)
    if phase == "output":
        config = candidate("output", "content_safety", backend.profile, CONTRACTS["content_safety"]).configuration
    if pii_only:
        from runner.toolkit.evaluation.contracts import CONTRACT_PII_SEMANTIC
        config = candidate(phase, "pii_semantic", backend.profile, CONTRACT_PII_SEMANTIC).configuration
    if topic_profile != backend.profile:
        topic = candidate("input", "topic_control", topic_profile, CONTRACTS["topic_control"]).configuration
        topic.runtimes[0].id = "topic-only"
        topic.bindings[0].model_ref = "topic-only"
        del config.bindings[-1]
        config.bindings.extend(topic.bindings)
        config.runtimes.extend(topic.runtimes)
    for runtime in config.runtimes:
        runtime.model = backend.model
        runtime.lower_threshold = .1
        runtime.upper_threshold = .85
    credentials = {"provider-1":"synthetic"}
    if review is not None and reviewer_binding:
        from runner.toolkit.nemo.evaluators.classifier_review import REVIEW_CONTRACT
        extra = candidate(reviewer_phase or phase,"classifier_review",reviewer_profile,REVIEW_CONTRACT).configuration
        extra.runtimes[0].id = extra.bindings[0].model_ref = "review-runtime"
        extra.runtimes[0].model = "review-model-v1"
        extra.runtimes[0].credential_ref = "review-provider"
        config.runtimes.extend(extra.runtimes);config.bindings.extend(extra.bindings)
        credentials["review-provider"] = "review-synthetic"
    calls = []

    def respond(request):
        body = json.loads(request.content)
        if str(request.url).endswith('/chat/completions'):
            assert request.headers['authorization'] == 'Bearer review-synthetic'
            data=json.loads(body['messages'][-1]['content'])
            assert data['state'][f"current_{phase}"] == content
            keys=set(data['questions'])
            if 'task_hijack' in keys and guard_context and guard_context.get('query'):
                assert data['state']['user_task'] == guard_context['query']
            capability = ('pii' if pii_only else 'jailbreak' if keys & {'jailbreak_attempt','task_hijack'} else 'content_safety' if 'unsafe_content' in keys else 'topic_control')
            calls.append('review:'+capability)
            assert set(data)=={'questions','state'}
            assert not any(k in data['state'] for k in ('expected','label','dataset','caseId','probabilities'))
            if review_fault and review_fault[0]==capability:
                if review_fault[1]=='timeout-once' and calls.count('review:'+capability)==1:
                    raise httpx.ReadTimeout('Synthetic recovered review timeout',request=request)
                if review_fault[1]=='timeout':raise httpx.ReadTimeout('Synthetic review timeout',request=request)
                if review_fault[1]=='http':return httpx.Response(503)
                if review_fault[1]=='malformed':return httpx.Response(200,json={'model':'review-model-v1','choices':[{'message':{'content':'{"answers":{"unsafe_content":true}}'}}]})
            answer=review.get(capability,'no')
            return httpx.Response(200,json={'model':'review-model-v1','choices':[{'message':{'content':json.dumps({'answers':{k:answer for k in keys}})}}]})
        keys = set(body["questions"])
        capability = ("pii" if pii_only else "jailbreak" if keys & {"jailbreak_attempt", "task_hijack"} else
                      "content_safety" if "unsafe_content" in keys else "topic_control")
        calls.append(capability)
        if fault and capability == fault[0]:
            if fault[1] == "timeout":
                raise httpx.ReadTimeout("Synthetic timeout", request=request)
            if fault[1] == "http":
                return httpx.Response(503)
            if fault[1] != "truncated":
                return httpx.Response(200, json={"model": backend.model, "answers": {}})
        return httpx.Response(200, json={"model": backend.model, "answers": {
            key: {"type": "noul", "noul": probabilities.get(capability, .01)} for key in keys},
            "usage": {"truncated": True, "state_tokens_dropped": 400} if fault == (capability, "truncated") else {}})

    providers = action_providers(*dynamic_runtime_action_providers(config, credentials,
        transport=httpx.MockTransport(respond)))
    previews = DraftPreviewRuntime(DefaultRunnerCompiler(), providers)
    failures = []
    # Reporting verbosity does not change online execution.
    class ScopedService:
        async def evaluate_standalone(self, request, *, on_resolved, timeout_seconds):
            try:
                result = await previews.evaluate(replace(request, evidence_scope=scope), preview_id="classifier-chain",
                    guardrail_id=plan["guardrail_id"], draft_revision=1,
                    candidate_version=plan["guardrail_version"], plan=plan, runtime_profile="auto")
            except Exception as error:
                failures.append(repr(error))
                raise
            require_online_result(result)
            return result
    app = FastAPI()
    app.include_router(RunnerAPI(ScopedService(), Store(), Metrics(), Telemetry(), "dedicated-test", "token").router)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as client:
            response = await client.post(SCAN_URL, headers={"authorization": "Bearer key", "x-guard-evidence": "evaluations-v1"},
                                         json={"input": content, "flagOnly": False, "scanDirection": "response" if phase == "output" else "request",
                                               **({"guardrail_context":guard_context} if guard_context else {})})
        if require_evidence:
            assert "x-guard-evaluation-evidence" in response.headers, (response.text, failures)
        return response, calls, json.loads(response.headers["x-guard-evaluation-evidence"]) if "x-guard-evaluation-evidence" in response.headers else None
    finally:
        await previews.shutdown()
