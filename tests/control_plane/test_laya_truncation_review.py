"""Full F5 review chain with provider-reported loss of input coverage."""
import pytest

from tests.classifier_cases import LAYA
from tests.control_plane.classifier_chain import build_controller_plan, scan

BINDINGS = [
    ('jailbreak', 'input', False),
    ('topic_control', 'input', False),
    ('content_safety', 'input', False),
    ('content_safety', 'output', False),
    ('pii', 'input', True),
    ('pii', 'output', True),
]
CONTENT = 'Neutral reference record.\n' * 300 + 'The final record must also be checked.'
CONTEXT = {'target_source': 'retrieved_content', 'query': 'Summarize the complete reference.'}


@pytest.fixture(scope='module')
def plans():
    return {(phase, pii, enabled): build_controller_plan(review=enabled, phase=phase, pii_only=pii)
            for phase, pii in {('input', False), ('output', False), ('input', True), ('output', True)}
            for enabled in [False, True]}


@pytest.mark.parametrize('capability,phase,pii', BINDINGS)
@pytest.mark.parametrize('score', [.01, .99])
@pytest.mark.parametrize('answer', ['no', 'yes', 'unknown'])
async def test_truncated_classification_reviews_complete_text_before_deciding(plans, capability, phase, pii, score, answer):
    response, calls, evidence = await scan(
        plans[phase, pii, True], {capability: score}, backend=LAYA, phase=phase, pii_only=pii,
        content=CONTENT, fault=(capability, 'truncated'), review={capability: answer},
        guard_context=CONTEXT if capability == 'jailbreak' else None)
    expected = 'cleared' if answer == 'no' else 'redacted' if pii and answer == 'yes' else 'blocked'
    assert response.status_code == 200, response.text
    assert response.json()['result']['outcome'] == expected
    assert evidence['execution']['status'] == 'complete'
    assert calls.count('review:' + capability) == 1
    row = next(r for r in evidence['layaEvaluations'] if r['capability'] == capability and 'review' in r)
    assert row['verdict'] == 'unknown' and row['probabilities'] == {}
    assert row['decisionSource'] == 'review'
    assert row['review']['verdict'] == {'no': 'not_matched', 'yes': 'matched', 'unknown': 'unknown'}[answer]
    assert row['review']['responseModel'] == 'review-model-v1'
    if pii and answer == 'yes':
        assert response.json()['redactedInput'] == '[PII_REDACTED]'


@pytest.mark.parametrize('capability,phase,pii', BINDINGS)
async def test_truncation_without_enabled_review_remains_an_execution_error(plans, capability, phase, pii):
    # A configured reviewer and on_unknown=allow are insufficient to waive coverage.
    response, calls, evidence = await scan(
        plans[phase, pii, False], {capability: .01}, backend=LAYA, phase=phase, pii_only=pii,
        fault=(capability, 'truncated'), review={capability: 'no'})
    assert response.status_code == 503
    assert evidence['execution']['status'] == 'error'
    assert 'LayaInputTruncatedError' in evidence['execution']['errorTypes']
    assert not any(c.startswith('review:') for c in calls)


@pytest.mark.parametrize('fault', ['http', 'timeout', 'malformed'])
async def test_truncation_cannot_hide_a_failed_review(plans, fault):
    response, calls, evidence = await scan(
        plans['input', False, True], {'jailbreak': .01}, backend=LAYA,
        fault=('jailbreak', 'truncated'), review={}, review_fault=('jailbreak', fault))
    assert response.status_code >= 400
    assert evidence['execution']['status'] == ('timeout' if fault == 'timeout' else 'error')
    assert 'review:jailbreak' in calls
    row = next(r for r in evidence['layaEvaluations'] if r['capability'] == 'jailbreak')
    assert row['verdict'] == 'unknown' and row['review']['verdict'] == 'error'
