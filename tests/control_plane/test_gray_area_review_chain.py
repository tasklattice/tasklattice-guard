"""Actual Controller -> signed parameter -> NeMo -> two transports -> F5 evidence."""
import json

import httpx
import pytest

from runner.capability_validation import validate_capability
from runner.providers import dynamic_runtime_action_providers
from runner.toolkit.nemo.evaluators.classifier_review import REVIEW_CONTRACT, REVIEW_PROFILE
from tests.control_plane.test_capability_validation import candidate
from tests.control_plane.classifier_chain import CONTRACTS, build_controller_plan, scan


@pytest.fixture(scope="module")
def plan():
    result=build_controller_plan(review=True)
    assert all(dict(step['parameters']).get('review_unknown')=='true' for step in result['steps'] if step['capability'] in CONTRACTS)
    return result


@pytest.mark.parametrize('capability',CONTRACTS)
@pytest.mark.parametrize('reviewer_profile', [REVIEW_PROFILE, 'generic-chat'])
@pytest.mark.parametrize('answer,outcome,verdict,action',[('yes','blocked','matched','block'),('no','cleared','not_matched','allow')])
async def test_only_gray_item_is_reviewed_and_original_scores_remain(classifier_backend, plan,capability,reviewer_profile,answer,outcome,verdict,action):
    response,calls,evidence=await scan(plan,{capability:.5},review={capability:answer}, reviewer_profile=reviewer_profile, backend=classifier_backend)
    assert response.status_code==200,response.text
    assert response.json()['result']['outcome']==outcome
    assert calls.count('review:'+capability)==1 and len(calls)==4
    assert evidence['execution']['status']=='complete'
    row=next(e for e in evidence[classifier_backend.evidence_key] if e['capability']==capability)
    assert row['verdict']=='unknown' and set(row['probabilities'].values())=={.5}
    assert row['thresholds']=={'lower':.1,'upper':.85}
    assert row['policyAction']=='allow' and row['enforcedAction'] is None
    assert row['decisionSource']=='review' and row['finalPolicyAction']==action
    assert row['review']['verdict']==verdict and row['review']['policyAction']==action
    assert row['review']['model']==row['review']['responseModel']=='review-model-v1'
    assert row['review']['revision']=='classifier-review.v2'
    assert row['review']['enforcedAction']==('block' if action=='block' else None)


@pytest.mark.parametrize('capability',CONTRACTS)
@pytest.mark.parametrize('score,outcome',[(.1,'cleared'),(.85,'blocked')])
async def test_clear_negative_and_exact_positive_boundary_never_call_review(classifier_backend, plan,capability,score,outcome):
    response,calls,evidence=await scan(plan,{capability:score},review={capability:'yes'}, backend=classifier_backend)
    assert response.status_code==200 and response.json()['result']['outcome']==outcome
    assert len(calls)==3 and not any('review' in c for c in calls)
    assert all('review' not in r for r in evidence[classifier_backend.evidence_key])


@pytest.mark.parametrize('capability',CONTRACTS)
@pytest.mark.parametrize('fault',['timeout','http','malformed'])
async def test_review_failure_keeps_primary_unknown_and_is_an_execution_error(classifier_backend, plan,capability,fault):
    response,calls,evidence=await scan(plan,{capability:.5},review={},review_fault=(capability,fault), backend=classifier_backend)
    assert response.status_code>=400,response.text
    assert evidence['execution']['status']==('timeout' if fault=='timeout' else 'error')
    row=next(e for e in evidence[classifier_backend.evidence_key] if e['capability']==capability)
    assert row['verdict']=='unknown' and row['thresholds']['upper']==.85
    assert row['review']['verdict']=='error' and row['review']['answers']=={}


@pytest.mark.parametrize('capability',CONTRACTS)
async def test_primary_errors_do_not_start_review(classifier_backend, plan,capability):
    response,calls,evidence=await scan(plan,{},review={},fault=(capability,'http'), backend=classifier_backend)
    assert response.status_code>=400 and evidence['execution']['status']=='error'
    assert not any('review' in c for c in calls)


@pytest.mark.parametrize('blocker',['local','content_safety','jailbreak','topic_control'])
async def test_review_allow_cannot_suppress_another_policy_block(classifier_backend, plan,blocker):
    gray='content_safety' if blocker!='content_safety' else 'jailbreak'
    scores={gray:.5}
    if blocker!='local':scores[blocker]=.9
    response,calls,evidence=await scan(plan,scores,review={},content='CHAIN_BLOCK' if blocker=='local' else 'An ordinary request.', backend=classifier_backend)
    assert response.status_code==200 and response.json()['result']['outcome']=='blocked'
    if blocker == 'local':
        # Rank Mode executes the authored Policy order. A local Block is
        # authoritative, but earlier model Policies may already have run.
        return
    row=next(e for e in evidence[classifier_backend.evidence_key] if e['capability']==gray)
    assert row['review']['verdict']=='not_matched' and row['review']['policyAction']=='allow'


@pytest.mark.parametrize('capability', CONTRACTS)
async def test_unresolved_review_blocks_without_relabeling_uncertainty_as_a_match_or_error(classifier_backend, plan, capability):
    # This plan deliberately has on_unknown=allow for the primary model.
    response,calls,evidence=await scan(plan,{capability:.5},review={capability:'unknown'}, backend=classifier_backend)
    assert response.status_code==200, response.text
    assert response.json()['result']['outcome']=='blocked'
    assert evidence['execution']['status']=='complete'
    row=next(r for r in evidence[classifier_backend.evidence_key] if r['capability']==capability)
    assert row['verdict']==row['review']['verdict']=='unknown'
    assert row['finalPolicyAction']==row['review']['enforcedAction']=='block'
    assert row['review']['errorType'] is None


async def test_missing_review_binding_prevents_readiness_and_makes_no_model_calls(classifier_backend, plan):
    response,calls,evidence=await scan(plan,{'content_safety':.5},review={},reviewer_binding=False,require_evidence=False, backend=classifier_backend)
    assert response.status_code>=400 and not calls


async def test_disabling_review_preserves_configured_unknown_handling_even_with_a_review_model(classifier_backend):
    response,calls,evidence=await scan(build_controller_plan(),{'content_safety':.5},review={'content_safety':'yes'}, backend=classifier_backend)
    assert response.status_code==200 and response.json()['result']['outcome']=='cleared'
    assert len(calls)==3 and not any('review' in r for r in evidence[classifier_backend.evidence_key])


@pytest.mark.parametrize('behavior',['correct','always-safe','always-unsafe','malformed'])
@pytest.mark.parametrize('profile', [REVIEW_PROFILE, 'generic-chat'])
@pytest.mark.parametrize('rail', ['input', 'output'])
async def test_review_model_binding_requires_actual_two_sided_runtime_probes(behavior, profile, rail):
    request=candidate(rail,'classifier_review',profile,REVIEW_CONTRACT)
    def respond(req):
        data=json.loads(json.loads(req.content)['messages'][-1]['content'])
        unsafe=behavior=='always-unsafe' or behavior=='correct' and 'build a bomb' in data['state'][f'current_{rail}']
        body={'answers':{'unsafe_content':'yes' if unsafe else 'no'}} if behavior!='malformed' else {'answers':{}}
        return httpx.Response(200,json={'model':'review-model-v1','choices':[{'message':{'content':json.dumps(body)}}]})
    result=await validate_capability(request,{'provider-1':'synthetic'},transport=httpx.MockTransport(respond))
    assert ['build a bomb' in case.input_content for case in result.cases] == [False, True]
    assert result.passed is (behavior=='correct'),result.message
    assert len(result.cases)==2


@pytest.mark.parametrize('invalid', ['output', 'capability', 'binding', 'contract', 'profile', 'runtime-profile'])
def test_generic_chat_review_still_requires_matching_rail_binding_and_contract(invalid):
    configuration = candidate('input', 'classifier_review', 'generic-chat', REVIEW_CONTRACT).configuration
    binding = configuration.bindings[0]
    if invalid == 'output': binding.rail_type = 2
    elif invalid == 'capability': binding.capability_ref = 'content_safety'
    elif invalid == 'binding': binding.binding_id = 'content_safety.input'
    elif invalid == 'contract': binding.contract_refs[:] = ['tali.guard.content-safety.v1']
    elif invalid == 'profile': binding.profile_ref = 'tali.qwen3guard.v1'
    else: configuration.runtimes[0].profile_ref = REVIEW_PROFILE
    with pytest.raises(ValueError, match='matching Rail binding'):
        dynamic_runtime_action_providers(configuration, {'provider-1': 'synthetic'})


@pytest.fixture(scope="module")
def output_plan():
    return build_controller_plan(review=True, phase="output")


@pytest.mark.parametrize("score,answer,outcome,expected_calls", [
    (.01, "yes", "cleared", 1), (.9, "no", "blocked", 1),
    (.5, "yes", "blocked", 2), (.5, "no", "cleared", 2),
    (.5, "unknown", "blocked", 2),
])
async def test_output_classifier_uses_its_own_review_binding_and_preserves_evidence(classifier_backend, output_plan, score, answer, outcome, expected_calls):
    response, calls, evidence = await scan(output_plan, {"content_safety": score},
        backend=classifier_backend, phase="output", review={"content_safety": answer})
    assert response.status_code == 200, response.text
    assert response.json()["result"]["outcome"] == outcome
    assert len(calls) == expected_calls
    row = evidence[classifier_backend.evidence_key][0]
    assert row["questionRevision"] == ("laya-content-safety-output.v3" if classifier_backend.name == "laya" else "content-safety-output.v1")
    if expected_calls == 2:
        assert row["verdict"] == "unknown" and row["decisionSource"] == "review"
        assert row["review"]["revision"] == "classifier-review-output.v2"
    else:
        assert "review" not in row


async def test_output_cannot_borrow_an_input_reviewer(classifier_backend, output_plan):
    response, calls, _ = await scan(output_plan, {"content_safety": .5}, backend=classifier_backend,
        phase="output", review={}, reviewer_phase="input", require_evidence=False)
    assert response.status_code >= 400 and not calls


@pytest.mark.parametrize("fault", ["http", "malformed", "timeout"])
async def test_output_review_errors_retain_unknown_primary_evidence(classifier_backend, output_plan, fault):
    response, _, evidence = await scan(output_plan, {"content_safety": .5}, backend=classifier_backend,
        phase="output", review={}, review_fault=("content_safety", fault))
    assert response.status_code >= 400
    assert evidence["execution"]["status"] in {"error", "timeout"}
    assert evidence[classifier_backend.evidence_key][0]["verdict"] == "unknown"
    assert evidence[classifier_backend.evidence_key][0]["review"]["verdict"] == "error"
