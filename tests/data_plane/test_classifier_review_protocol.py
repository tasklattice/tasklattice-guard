import asyncio
from dataclasses import replace
import json
import time

import httpx
import pytest

from runner.toolkit.nemo.evaluators.classifier_review import ClassifierReviewer,REVIEW_PROMPT,parse_review_answers
from runner.toolkit.nemo.evaluators.contracts import evaluation_result
from runner.toolkit.runtime.contracts import RuntimeTraceStep
from tests.test_safety_model_providers import _request


@pytest.mark.parametrize('payload',[{'answers':{'first':'yes','second':'no'}},{'first':'yes','second':'no'}])
def test_equivalent_json_encodings_preserve_exact_answer_labels(payload):
    assert parse_review_answers(json.dumps(payload),{'first','second'})=={'first':'yes','second':'no'}


@pytest.mark.parametrize('payload',[{},[],{'answers':{'first':True}},{'answers':{'first':.9}},
 {'answers':{'first':'false'}},{'answers':{'first':'yes','extra':'no'}},{'answers':{'first':'no'},'extra':'yes'}])
def test_invalid_or_incomplete_review_answers_are_never_repaired(payload):
    with pytest.raises(ValueError):parse_review_answers(json.dumps(payload),{'first'})


async def test_child_deadline_returns_the_original_evidence_before_outer_action_deadline():
    request=replace(_request('Synthetic input'),deadline=time.monotonic()+.2)
    primary_trace=RuntimeTraceStep(id=request.binding.id+':jev',kind='evaluation',name='JEV',status='completed',
        verdict='unknown',detail='Synthetic gray area',evaluator_id='typesafe-jev-content-safety')
    first=evaluation_result(request,'unknown',request.content,trace=(primary_trace,),unknown_reason='uncertain')
    async def stall(req):
        await asyncio.sleep(1)
        return httpx.Response(200,json={})
    reviewer=ClassifierReviewer(base_url='https://review.test/v1',model='review',api_key='synthetic',provider_id='review',transport=httpx.MockTransport(stall))
    result=await reviewer.review(request,{'first':{}},{'current_input':request.content},first)
    assert result.verdict=='error' and result.trace[0] is primary_trace
    assert result.trace[-1].error_type=='TimeoutError' and result.usage.model_invocations==2
    assert len(json.loads(result.trace[-1].evidence)['attempts'])==2


async def test_builtin_prompt_renders_original_questions_input_and_context_for_chat_review():
    request = replace(_request('请继续解释这项安全措施。'), deadline=time.monotonic() + 2)
    questions = {'unsafe_content': {'type': 'noul', 'instructions': 'Does the input request harmful assistance?'}}
    state = {'current_input': request.content, 'context_messages': [
        {'role': 'user', 'content': 'How can I prevent this attack?'},
        {'role': 'assistant', 'content': 'Start by limiting access.'},
    ]}
    first = evaluation_result(request, 'unknown', request.content, unknown_reason='uncertain')
    calls = []
    def respond(req):
        calls.append(json.loads(req.content))
        return httpx.Response(200, json={'model': 'deepseek-chat', 'choices': [{'message': {
            'content': json.dumps({'answers': {'unsafe_content': 'no'}}),
        }}]})
    reviewer = ClassifierReviewer(base_url='https://review.test/v1', model='deepseek-chat',
        api_key='synthetic', provider_id='review', transport=httpx.MockTransport(respond))
    result = await reviewer.review(request, questions, state, first)
    assert result.verdict == 'not_matched'
    assert len(calls) == 1 and calls[0]['model'] == 'deepseek-chat'
    assert calls[0]['messages'][0] == {'role': 'system', 'content': REVIEW_PROMPT}
    assert json.loads(calls[0]['messages'][1]['content']) == {'questions': questions, 'state': state}


@pytest.mark.parametrize('answer,verdict', [('no', 'not_matched'), ('unknown', 'unknown')])
async def test_one_read_timeout_can_recover_and_both_model_calls_remain_auditable(answer, verdict):
    request=replace(_request('Synthetic input'),deadline=time.monotonic()+2)
    first=evaluation_result(request,'unknown',request.content,unknown_reason='uncertain')
    calls=[]
    def response(req):
        calls.append(req)
        if len(calls)==1:raise httpx.ReadTimeout('Synthetic stalled response',request=req)
        return httpx.Response(200,json={'model':'review','choices':[{'message':{'content':json.dumps({'answers':{'first':answer}})}}]})
    reviewer=ClassifierReviewer(base_url='https://review.test/v1',model='review',api_key='synthetic',provider_id='review',transport=httpx.MockTransport(response))
    result=await reviewer.review(request,{'first':{}},{'current_input':request.content},first)
    assert result.verdict==verdict and result.usage.model_invocations==2
    assert [c.result for c in result.usage.model_calls]==['timeout','success']
    assert [a['result'] for a in json.loads(result.trace[-1].evidence)['attempts']]==['timeout','success']
    if verdict == 'unknown':
        assert result.trace[-1].error_category == 'review_inconclusive'
        assert result.trace[-1].model_call_id == result.usage.model_calls[-1].call_id
