"""Actual Controller -> signed parameter -> NeMo -> two transports -> F5 evidence."""
import json

import httpx
import pytest

from runner.capability_validation import validate_capability
from runner.toolkit.nemo.evaluators.classifier_review import REVIEW_CONTRACT, REVIEW_PROFILE
from tests.control_plane.test_capability_validation import candidate
from tests.control_plane.test_classifier_decision_chain import CONTRACTS, build_controller_plan, scan


@pytest.fixture(scope="module")
def plan():
    result=build_controller_plan(review=True)
    assert all(dict(step['parameters']).get('review_unknown')=='true' for step in result['steps'] if step['capability'] in CONTRACTS)
    return result


@pytest.mark.parametrize('capability',CONTRACTS)
@pytest.mark.parametrize('answer,outcome,verdict,action',[('yes','blocked','matched','block'),('no','cleared','not_matched','allow')])
async def test_only_gray_item_is_reviewed_and_original_scores_remain(plan,capability,answer,outcome,verdict,action):
    response,calls,evidence=await scan(plan,{capability:.5},review={capability:answer})
    assert response.status_code==200,response.text
    assert response.json()['result']['outcome']==outcome
    assert calls.count('review:'+capability)==1 and len(calls)==4
    assert evidence['execution']['status']=='complete'
    row=next(e for e in evidence['evaluations'] if e['capability']==capability)
    assert row['verdict']=='unknown' and set(row['probabilities'].values())=={.5}
    assert row['thresholds']=={'lower':.1,'upper':.85}
    assert row['policyAction']=='allow' and row['enforcedAction'] is None
    assert row['decisionSource']=='review' and row['finalPolicyAction']==action
    assert row['review']['verdict']==verdict and row['review']['policyAction']==action
    assert row['review']['model']==row['review']['responseModel']=='review-model-v1'
    assert row['review']['revision']=='classifier-review.v1'
    assert row['review']['enforcedAction']==('block' if action=='block' else None)


@pytest.mark.parametrize('capability',CONTRACTS)
@pytest.mark.parametrize('score,outcome',[(.1,'cleared'),(.85,'blocked')])
async def test_clear_negative_and_exact_positive_boundary_never_call_review(plan,capability,score,outcome):
    response,calls,evidence=await scan(plan,{capability:score},review={capability:'yes'})
    assert response.status_code==200 and response.json()['result']['outcome']==outcome
    assert len(calls)==3 and not any('review' in c for c in calls)
    assert all('review' not in r for r in evidence['evaluations'])


@pytest.mark.parametrize('capability',CONTRACTS)
@pytest.mark.parametrize('fault',['timeout','http','malformed'])
async def test_review_failure_keeps_primary_unknown_and_is_an_execution_error(plan,capability,fault):
    response,calls,evidence=await scan(plan,{capability:.5},review={},review_fault=(capability,fault))
    assert response.status_code>=400,response.text
    assert evidence['execution']['status']=='error'
    row=next(e for e in evidence['evaluations'] if e['capability']==capability)
    assert row['verdict']=='unknown' and row['thresholds']['upper']==.85
    assert row['review']['verdict']=='error' and row['review']['answers']=={}


@pytest.mark.parametrize('capability',CONTRACTS)
async def test_primary_errors_do_not_start_review(plan,capability):
    response,calls,evidence=await scan(plan,{},review={},fault=(capability,'http'))
    assert response.status_code>=400 and evidence['execution']['status']=='error'
    assert not any('review' in c for c in calls)


@pytest.mark.parametrize('blocker',['local','content_safety','jailbreak','topic_control'])
async def test_review_allow_cannot_suppress_another_policy_block(plan,blocker):
    gray='content_safety' if blocker!='content_safety' else 'jailbreak'
    scores={gray:.5}
    if blocker!='local':scores[blocker]=.9
    response,calls,evidence=await scan(plan,scores,review={},content='CHAIN_BLOCK' if blocker=='local' else 'An ordinary request.')
    assert response.status_code==200 and response.json()['result']['outcome']=='blocked'
    row=next(e for e in evidence['evaluations'] if e['capability']==gray)
    assert row['review']['verdict']=='not_matched' and row['review']['policyAction']=='allow'


async def test_unresolved_review_is_coverage_failure_not_safe_or_a_successful_detection(plan):
    response,calls,evidence=await scan(plan,{'content_safety':.5},review={'content_safety':'unknown'})
    assert response.status_code>=400
    assert evidence['execution']['status']=='error'
    assert next(r for r in evidence['evaluations'] if r['capability']=='content_safety')['review']['verdict']=='unknown'


async def test_missing_review_binding_prevents_readiness_and_makes_no_model_calls(plan):
    response,calls,evidence=await scan(plan,{'content_safety':.5},review={},reviewer_binding=False,require_evidence=False)
    assert response.status_code>=400 and not calls


async def test_disabling_review_preserves_legacy_unknown_handling_even_with_a_review_model():
    response,calls,evidence=await scan(build_controller_plan(),{'content_safety':.5},review={'content_safety':'yes'})
    assert response.status_code==200 and response.json()['result']['outcome']=='cleared'
    assert len(calls)==3 and not any('review' in r for r in evidence['evaluations'])


@pytest.mark.parametrize('behavior',['correct','always-safe','always-unsafe','malformed'])
async def test_review_model_binding_requires_actual_two_sided_runtime_probes(behavior):
    request=candidate('input','classifier_review',REVIEW_PROFILE,REVIEW_CONTRACT)
    def respond(req):
        data=json.loads(json.loads(req.content)['messages'][-1]['content'])
        unsafe=behavior=='always-unsafe' or behavior=='correct' and 'build a bomb' in data['state']['current_input']
        body={'answers':{'unsafe_content':'yes' if unsafe else 'no'}} if behavior!='malformed' else {'answers':{}}
        return httpx.Response(200,json={'model':'review-model-v1','choices':[{'message':{'content':json.dumps(body)}}]})
    result=await validate_capability(request,{'provider-1':'synthetic'},transport=httpx.MockTransport(respond))
    assert result.passed is (behavior=='correct'),result.message
    assert len(result.cases)==2
