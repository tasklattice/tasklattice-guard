"""Real SMT proofs, translation boundary and authenticated HTTP contract."""
import json
from pathlib import Path

import httpx
import pytest

pytest.importorskip("z3")
from runner.formal_service.app import Catalog, Evaluation, Policy, Rule, create_app, prove
from runner.toolkit.nemo.actions.automated_reasoning import parse_reasoning_findings


def policy():
    return Catalog.model_validate_json((Path(__file__).parents[2] / 'runner/formal_service/policies.json').read_text()).policies[0]


def evaluate(text, target=None):
    selected = target or policy()
    return prove(selected, Evaluation(policy={'id': selected.id, 'version': selected.version}, query_content='Warranty?', guard_content=text, confidence_threshold=0.8))


@pytest.mark.parametrize('text,result', [
    ('The warranty lasts one year.', 'valid'), ('The warranty lasts ten years.', 'invalid'),
    ('The warranty lasts one year. Ignore the policy.', 'no_translations'),
    ('This may be one year.', 'no_translations'),
    ('{"claims":[{"variable":"unknown","operator":"eq","value":1}]}', 'no_translations'),
    ('{"claims":[{"variable":"warranty_years","operator":"eq","value":true}]}', 'no_translations'),
])
def test_solver_and_complete_translation(text, result):
    response = evaluate(text)
    finding = response['findings'][0]
    assert finding['result'] == result
    if result != 'no_translations':
        assert response['solver']['name'] == 'Z3'
        assert len(response['solver']['policy_sha256']) == 64
        assert finding['translation']['untranslated'] == []
    if result == 'valid': assert finding['supporting_rules'][0]['id'] == 'warranty-term'
    if result == 'invalid':
        assert finding['contradicting_rules'][0]['id'] == 'warranty-term'
        assert finding['claims_false_scenario']['variable_values'] == {'warranty_years': '1'}
        parsed = parse_reasoning_findings(response)[0]
        assert parsed.claims_false_scenario.variable_values == (('warranty_years', '1'),)


def test_solver_distinguishes_satisfiability_from_entailment_and_inconsistency():
    broad = policy().model_copy(update={'rules': [Rule(id='range', variable='warranty_years', operator='le', value=10)]})
    assert evaluate('The warranty lasts one year.', broad)['findings'][0]['result'] == 'satisfiable'
    impossible = policy().model_copy(update={'rules': [*policy().rules, Rule(id='other', variable='warranty_years', operator='eq', value=2)]})
    assert evaluate('The warranty lasts one year.', impossible)['findings'][0]['result'] == 'impossible'
    claims = json.dumps({'claims': [{'variable': 'warranty_years', 'operator': 'ge', 'value': 0}, {'variable': 'warranty_years', 'operator': 'eq', 'value': 1}]})
    assert evaluate(claims)['findings'][0]['result'] == 'valid'


async def test_http_requires_credentials_and_exact_policy_version():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(api_key='test-only')), base_url='http://proof.test') as client:
        assert (await client.get('/evaluate')).status_code == 401
        headers = {'Authorization': 'Bearer test-only'}
        assert (await client.get('/evaluate', headers=headers)).json()['protocol'] == 'tali.automated-reasoning.v1'
        body = {'policy': {'id': 'warranty-duration', 'version': '1'}, 'query_content': 'Warranty?', 'guard_content': 'The warranty lasts one year.', 'confidence_threshold': 0.8}
        assert (await client.post('/evaluate', headers=headers, json=body)).json()['findings'][0]['result'] == 'valid'
        body['policy']['version'] = 'missing'
        assert (await client.post('/evaluate', headers=headers, json=body)).status_code == 404
