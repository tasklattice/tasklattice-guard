"""Shipped Policy -> Controller plan -> Laya -> real HTTP response evidence."""
from dataclasses import replace
import json
from pathlib import Path
import os
import subprocess
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from runner.api import RunnerAPI
from runner.compiler import DefaultRunnerCompiler
from runner.draft_preview import DraftPreviewRuntime
from runner.providers import dynamic_runtime_action_providers
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.evaluators.laya import LAYA_PROFILE, LAYA_TOPIC_PROFILE
from runner.toolkit.nemo.runtime import _runtime_action
from tests.control_plane.test_capability_validation import candidate
from tests.data_plane.test_scan import Store, SCAN_URL
from tests.test_runner_api import Metrics, Telemetry

ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = {"jailbreak": "tali.guard.jailbreak.v1", "content_safety": "tali.guard.content-safety.v1",
             "topic_control": "tali.guard.topic-control.semantic.v1"}


@pytest.fixture(scope="module")
def controller_plan():
    return build_controller_plan()


def build_controller_plan(*, review=False):
    source = """
      import { PolicyCatalog } from './server/policy-catalog/catalog.ts';
      import { DeclarativeCompiler } from './server/policy-studio/declarative.ts';
      import { buildGuardrailPlan } from './server/domain/guardrail-plan.ts';
      const compiler = new DeclarativeCompiler('../runner/toolkit/policy_library/assets');
      const policies = PolicyCatalog.load('../runner/toolkit/policy_library/assets').list().map(p => compiler.catalogView(p));
      const ids = ['builtin-content-safety', 'builtin-jailbreak-strict', 'builtin-topic-safety',
                   'keyword-blocking', 'local-data-use-boundaries'];
      const bindings = ids.map(id => {
        const p = policies.find(p => p.id === id);
        const rules = id === 'builtin-topic-safety' ? ['topic/denylist'] : p.rules.map(r => r.id);
        return { policyId: id, policyVersion: p.version, action: null, enabledRails: ['input'],
          enabledRuleIds: rules, ruleOrder: rules, ruleActions: {}, reasoningPolicy: null,
          parameterValues: id === 'keyword-blocking' ? {blocked_words: 'CHAIN_BLOCK'} :
            {on_unknown: 'allow', review_unknown: process.env.GUARD_TEST_REVIEW ?? 'false', topic_mode: 'permissive', denied_topics: 'Synthetic forbidden task'} };
      });
      console.log(JSON.stringify(buildGuardrailPlan({guardrailId: 'classifier-chain',
        guardrailVersion: '20261029-000000.001Z', policies,
        draft: {allowedTopics: [], restrictedTopics: [], safetyLevel: 'balanced',
                outputDelivery: 'full_buffered', policyBindings: bindings}})));
    """
    result = subprocess.run(["node", "--import", "tsx", "--input-type=module", "-e", source],
                            cwd=ROOT / "controller", capture_output=True, text=True, check=True, timeout=60,
                            env={**os.environ,"GUARD_TEST_REVIEW":"true" if review else "false"})
    return json.loads(result.stdout)


async def scan(plan, probabilities, *, content="An ordinary synthetic request.", fault=None,
               topic_profile=LAYA_PROFILE, scope="full", review=None, review_fault=None, reviewer_binding=True, require_evidence=True):
    config = candidate("input", "jailbreak", LAYA_PROFILE, CONTRACTS["jailbreak"]).configuration
    for capability in ("content_safety", "topic_control"):
        other = candidate("input", capability, LAYA_PROFILE, CONTRACTS[capability]).configuration
        config.bindings.extend(other.bindings)
    if topic_profile != LAYA_PROFILE:
        topic = candidate("input", "topic_control", topic_profile, CONTRACTS["topic_control"]).configuration
        topic.runtimes[0].id = "topic-only"
        topic.bindings[0].model_ref = "topic-only"
        del config.bindings[-1]
        config.bindings.extend(topic.bindings)
        config.runtimes.extend(topic.runtimes)
    for runtime in config.runtimes:
        runtime.model = "laya"
    credentials = {"provider-1":"synthetic"}
    if review is not None and reviewer_binding:
        from runner.toolkit.nemo.evaluators.classifier_review import REVIEW_PROFILE, REVIEW_CONTRACT
        extra = candidate("input","classifier_review",REVIEW_PROFILE,REVIEW_CONTRACT).configuration
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
            keys=set(data['questions'])
            capability = ('jailbreak' if 'jailbreak_attempt' in keys else 'content_safety' if 'unsafe_content' in keys else 'topic_control')
            calls.append('review:'+capability)
            assert set(data)=={'questions','state'}
            assert not any(k in data['state'] for k in ('expected','label','dataset','caseId','probabilities'))
            if review_fault and review_fault[0]==capability:
                if review_fault[1]=='timeout':raise httpx.ReadTimeout('Synthetic review timeout',request=request)
                if review_fault[1]=='http':return httpx.Response(503)
                if review_fault[1]=='malformed':return httpx.Response(200,json={'model':'review-model-v1','choices':[{'message':{'content':'{"answers":{"unsafe_content":true}}'}}]})
            answer=review.get(capability,'no')
            return httpx.Response(200,json={'model':'review-model-v1','choices':[{'message':{'content':json.dumps({'answers':{k:answer for k in keys}})}}]})
        keys = set(body["questions"])
        capability = ("jailbreak" if "jailbreak_attempt" in keys else
                      "content_safety" if "unsafe_content" in keys else "topic_control")
        calls.append(capability)
        if fault and capability == fault[0]:
            if fault[1] == "timeout":
                raise httpx.ReadTimeout("Synthetic timeout", request=request)
            if fault[1] == "http":
                return httpx.Response(503)
            return httpx.Response(200, json={"model": "laya", "answers": {}})
        return httpx.Response(200, json={"model": "laya", "answers": {
            key: {"type": "noul", "noul": probabilities.get(capability, .01)} for key in keys}})

    providers = action_providers(*dynamic_runtime_action_providers(config, credentials,
        laya_thresholds=(.1, .85), transport=httpx.MockTransport(respond)))
    previews = DraftPreviewRuntime(DefaultRunnerCompiler(), providers)
    failures = []
    # LiteLLM normally requests intervention evidence and F5 requests full evidence.
    class ScopedService:
        async def evaluate_standalone(self, request, *, on_resolved, validate_decision, timeout_seconds):
            try:
                result = await previews.evaluate(replace(request, evidence_scope=scope), preview_id="classifier-chain",
                    guardrail_id=plan["guardrail_id"], draft_revision=1,
                    candidate_version=plan["guardrail_version"], plan=plan, runtime_profile="auto")
            except Exception as error:
                failures.append(repr(error))
                raise
            validate_decision(result)
            return result
    app = FastAPI()
    app.include_router(RunnerAPI(ScopedService(), Store(), Metrics(), Telemetry(), "dedicated-test", "token").router)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as client:
            response = await client.post(SCAN_URL, headers={"authorization": "Bearer key", "x-guard-evidence": "evaluations-v1"},
                                         json={"input": content, "flagOnly": False})
        if require_evidence:
            assert "x-guard-evaluation-evidence" in response.headers, (response.text, failures)
        return response, calls, json.loads(response.headers["x-guard-evaluation-evidence"]) if "x-guard-evaluation-evidence" in response.headers else None
    finally:
        await previews.shutdown()


@pytest.mark.parametrize("capability", CONTRACTS)
@pytest.mark.parametrize("probability,verdict,action", [
    (.1, "not_matched", "allow"), (.100001, "unknown", "allow"),
    (.849999, "unknown", "allow"), (.85, "matched", "block"), (.850001, "matched", "block"),
])
async def test_custom_threshold_boundaries_survive_every_layer(controller_plan, capability, probability, verdict, action):
    response, calls, evidence = await scan(controller_plan, {capability: probability})
    assert response.status_code == 200, response.text
    assert response.json()["result"]["outcome"] == ("blocked" if action == "block" else "cleared")
    assert set(calls) == set(CONTRACTS)
    assert evidence["guardrailVersion"] == controller_plan["guardrail_version"]
    assert evidence["execution"]["status"] == "complete"
    assert len(evidence["layaEvaluations"]) == 3
    for row in evidence["layaEvaluations"]:
        assert row["thresholds"] == {"lower": .1, "upper": .85}
        assert row["model"] == row["requestedModel"] == row["responseModel"] == "laya"
        assert row["policyVersion"]
        if row["capability"] == capability:
            assert row["verdict"] == verdict and row["policyAction"] == action
            assert set(row["probabilities"].values()) == {probability}
            assert row["enforcedAction"] == ("block" if action == "block" else None)


@pytest.mark.parametrize("scope", ["full", "interventions"])
@pytest.mark.parametrize("blocking", [*CONTRACTS, "local", "none"])
async def test_allow_unknown_never_skips_another_block(controller_plan, blocking, scope):
    probabilities = dict.fromkeys(CONTRACTS, .5)
    if blocking in CONTRACTS:
        probabilities[blocking] = .85
    response, calls, evidence = await scan(controller_plan, probabilities, scope=scope,
        content="An ordinary request. CHAIN_BLOCK" if blocking == "local" else "An ordinary request.")
    assert response.status_code == 200, response.text
    assert response.json()["result"]["outcome"] == ("cleared" if blocking == "none" else "blocked")
    if blocking != "local":
        assert set(calls) == set(CONTRACTS)
    for row in evidence.get("layaEvaluations", []):
        if row["verdict"] == "unknown":
            assert row["policyAction"] == "allow" and row["enforcedAction"] is None


@pytest.mark.parametrize("capability", CONTRACTS)
@pytest.mark.parametrize("failure", ["timeout", "http", "parse"])
async def test_unknown_allow_keeps_execution_errors_and_their_operating_point(controller_plan, capability, failure):
    response, _, evidence = await scan(controller_plan, dict.fromkeys(CONTRACTS, .5), fault=(capability, failure))
    assert response.status_code == 503 and response.json()["detail"]["code"] == "scan_execution_failed"
    assert evidence["execution"]["status"] == "error"
    row = next(r for r in evidence["layaEvaluations"] if r["capability"] == capability)
    assert row["verdict"] == "error" and row["policyAction"] == "block"
    assert row["thresholds"]["upper"] == .85 and row["probabilities"] == {}
    assert row["responseModel"] is None


async def test_topic_only_profile_receives_custom_thresholds(controller_plan):
    response, _, evidence = await scan(controller_plan, {"topic_control": .85}, topic_profile=LAYA_TOPIC_PROFILE)
    assert response.status_code == 200 and response.json()["result"]["outcome"] == "blocked"
    topic = next(r for r in evidence["layaEvaluations"] if r["capability"] == "topic_control")
    assert topic["verdict"] == "matched" and topic["thresholds"]["upper"] == .85


@pytest.mark.parametrize("capability", CONTRACTS)
def test_unknown_allow_does_not_waive_missing_context(capability):
    binding = SimpleNamespace(on_unsafe="block", capability=capability, parameter=lambda _: "allow")
    assert _runtime_action(SimpleNamespace(binding=binding, result=SimpleNamespace(verdict="unknown", unknown_reason="needs_context"))) == "block"


@pytest.mark.parametrize("content,outcome", [
    ("Explain how to access the electronic health records of a family member.", "cleared"),
    ("How can a caregiver access health records with written patient consent?", "cleared"),
    ("Explain how to access health records without consent.", "blocked"),
    ("Retrieve the treatment records for another patient.", "blocked"),
])
async def test_phi_repair_is_independent_of_model_uncertainty(controller_plan, content, outcome):
    response, _, _ = await scan(controller_plan, dict.fromkeys(CONTRACTS, .5), content=content)
    assert response.status_code == 200 and response.json()["result"]["outcome"] == outcome
