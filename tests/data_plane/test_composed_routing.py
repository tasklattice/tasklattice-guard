from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import os
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

from runner import generated as protocol
from runner.call_context import RedisCallContextStore
from runner.protocol_codec import traffic_scope_to_proto, traffic_scope_from_proto
from runner.routing import RoutingError, condition_matches, select, validate_router
from runner.serialization import plan_from_dict
from runner.toolkit.runtime.context import CallContextStore
from runner.toolkit.runtime.contracts import PlanResolution, ProtectionDecision, ProtectionRequest, RequestContext
from runner.toolkit.runtime.service import GuardrailRuntimeService

FIXTURE = Path(__file__).parents[1] / 'fixtures/artifacts/local-secrets-v1'


def router():
    def route(identity, kind, weights):
        return protocol.ComposedRoute(route_id=identity, name=identity, kind=kind, enabled=True,
            all_endpoints=True, traffic_scope=traffic_scope_to_proto({'combinator': 'and', 'conditions': [] if kind == 'fallback' else [
                {'field': 'http.header', 'key': 'x-channel', 'requestSource': 'business_request', 'operator': 'equals', 'value': 'partner'}]}),
            targets=[protocol.WeightedTarget(target_id=f'{identity}-{i}', guardrail_id=f'g{i}', guardrail_version='v1', artifact_id=f'a{i}', weight_bps=w) for i, w in enumerate(weights)])
    return protocol.RouterRevision(router_id='router', revision=1, assignment_algorithm='hmac-sha256-v1', assignment_key_id='key1', assignment_key=b'k'*32,
        routes=[route('first', 'normal', [7000, 3000, 0]), route('second', 'normal', [10000]), route('fallback', 'fallback', [10000])])


def context(**kwargs):
    return RequestContext(protocol='http', endpoint_id='endpoint', business_request=(('x-channel', 'partner'),), **kwargs)


def artifacts():
    return {f'a{i}': SimpleNamespace(plan=SimpleNamespace(guardrail_id=f'g{i}', guardrail_version='v1')) for i in range(3)}


@pytest.mark.parametrize('operator,value,pairs,expected', [
    ('equals', '', (('X-Test', ''),), True),
    ('not_equals', 'a', (), False), ('not_exists', '', (), True),
    ('not_equals', 'a', (('x-test', 'a'), ('X-Test', 'b')), False),
    ('equals', 'b', (('x-test', 'a'), ('X-Test', 'b')), True),
    ('in', ['a', 'b'], (('x-test', 'b'),), True),
    ('not_in', ['a', 'b'], (('x-test', 'c'),), True),
    ('equals', 'a,b', (('x-test', 'a,b'),), True),
    ('equals', 'a', (('x-test', 'a,b'),), False),
    ('glob', r'a\*?', (('x-test', 'a*😀'),), True),
    ('glob', '[ab]', (('x-test', 'a'),), False),
    ('glob', 'a\\', (('x-test', 'a\\'),), True),
])
def test_selector_semantics_round_trip(operator, value, pairs, expected):
    expression = traffic_scope_from_proto(traffic_scope_to_proto({'combinator': 'and', 'conditions': [
        {'field': 'http.header', 'key': 'x-test', 'requestSource': 'business_request', 'operator': operator, 'value': value}]}))
    assert condition_matches(expression['conditions'][0], replace(context(), business_request=pairs)) is expected


def test_sources_ascii_case_and_missing_are_distinct():
    c = dict(field='http.header', key='x-test', requestSource='business_request', operator='not_exists')
    assert not condition_matches(c, replace(context(), business_request=None, endpoint_request=(('x-test', ''),)))
    c.update(operator='equals', value='abc', caseSensitive=False)
    assert condition_matches(c, replace(context(), business_request=(('x-test', 'ABC'),)))
    c['value'] = 'ä'
    assert not condition_matches(c, replace(context(), business_request=(('x-test', 'Ä'),)))


def test_first_match_weighted_stability_zero_weight_and_endpoint_scope():
    r = router()
    validate_router(r, artifacts())
    counts = {f'first-{i}': 0 for i in range(3)}
    for i in range(5000):
        c = context(call_id=f'call-{i}')
        target, assignment = select(r, c)
        assert assignment['routeId'] == 'first'
        assert select(r, c)[0].target_id == target.target_id
        counts[target.target_id] += 1
    assert 3300 < counts['first-0'] < 3700
    assert counts['first-2'] == 0
    r.routes[0].all_endpoints = False
    assert select(r, context())[1]['routeId'] == 'second'
    r.routes[1].enabled = False
    assert select(r, context())[1]['routeId'] == 'fallback'


@pytest.mark.parametrize('mutation', [
    lambda r: setattr(r.routes[0].traffic_scope.conditions[0], 'field', 'unknown'),
    lambda r: setattr(r.routes[0].targets[0], 'weight_bps', 6000),
    lambda r: setattr(r.routes[0].targets[0], 'guardrail_version', 'latest'),
    lambda r: setattr(r.routes[-1], 'enabled', False),
    lambda r: setattr(r.routes[0].traffic_scope.conditions[0], 'key', 'Authorization'),
    lambda r: setattr(r.routes[0].traffic_scope.conditions[0], 'request_source', ''),
])
def test_invalid_snapshot_rejected(mutation):
    r = router(); mutation(r)
    with pytest.raises(ValueError): validate_router(r, artifacts())


def test_bad_input_cannot_silently_fall_back():
    with pytest.raises(RoutingError, match='routing_input_error') as error:
        select(router(), replace(context(), business_request=(('x-channel', 'x'*2049),)))
    assert error.value.assignment['assignmentStatus'] == 'unassigned'


def resolution():
    from runner.protocol_codec import plan_from_proto
    state = protocol.DesiredState()
    state.ParseFromString(base64.b64decode((FIXTURE / 'desired-state.pb.b64').read_text()))
    return PlanResolution(plan=plan_from_dict(plan_from_proto(state.artifacts[0].plan)), router_id='router', endpoint_id='endpoint',
        route_assignment=select(router(), context())[1])


class Resolver:
    def __init__(self): self.selected = resolution(); self.calls = 0
    def composed_endpoint(self, _): return True
    def resolve(self, _): self.calls += 1; return self.selected


class Service(GuardrailRuntimeService):
    async def _evaluate_resolved(self, request, resolution, stored):
        return ProtectionDecision(decision='transform' if request.phase == 'input' else 'allow', action='pass', route_assignment=resolution.route_assignment)


@pytest.mark.asyncio
async def test_replicas_pin_inputs_outputs_and_deduplicate_completion():
    contexts = CallContextStore()
    resolvers = [Resolver(), Resolver()]
    services = [Service(None, r, contexts) for r in resolvers]
    events = []
    async def emit(e): events.append(e)
    for service in services: service.routing_event_sink = emit
    req = ProtectionRequest(phase='input', texts=('hello',), context=context(), call_id='endpoint:call')
    first = await services[0].evaluate(req)
    resolvers[1].selected = replace(resolvers[1].selected, route_assignment={**resolvers[1].selected.route_assignment, 'routerRevision': 2})
    await services[1].evaluate(replace(req, context=replace(context(), business_request=None)))
    output = replace(req, phase='output')
    last = await services[1].evaluate(output)
    await services[0].evaluate(output)
    assert first.route_assignment == last.route_assignment
    assert resolvers[1].calls == 0
    completions = [e for e in events if e['eventType'] == 'completion']
    assert len(completions) == 2 and completions[0] == completions[1]
    assert completions[0]['outcome'] == 'transform'
    assert len({e['decisionId'] for e in events}) == 1
    contexts._items[req.call_id].expires_at = 0
    with pytest.raises(RoutingError, match='call_context_expired'): await services[0].evaluate(output)


@pytest.mark.asyncio
async def test_standalone_stream_claims_once_and_requires_subsequent_context():
    resolver = Resolver(); service = Service(None, resolver)
    req = ProtectionRequest(phase='output', texts=('hello',), context=context(), call_id='endpoint:stream')
    with pytest.raises(RoutingError): service.output_delivery(req)
    service.output_delivery(req, allow_new_output=True)
    await service.evaluate(req)
    assert resolver.calls == 1
    with pytest.raises(RoutingError): service.output_delivery(replace(req, call_id='missing'), require_existing=True, allow_new_output=True)


def test_real_redis_atomic_assignment_and_outcome():
    url = os.environ.get('GUARD_TEST_REDIS_URL')
    if not url: pytest.skip('Set GUARD_TEST_REDIS_URL to isolated loopback Redis')
    from urllib.parse import urlparse
    assert urlparse(url).hostname in {'127.0.0.1', 'localhost', '::1'}
    stores = [RedisCallContextStore(url) for _ in range(2)]
    identity = f'composed-test-{uuid4()}'
    try:
        candidates = [resolution(), resolution()]
        with ThreadPoolExecutor(max_workers=2) as pool:
            claims = list(pool.map(lambda i: stores[i].claim(identity, (), candidates[i]), range(2)))
        assert claims[0].resolution == claims[1].resolution
        assert stores[0].record_outcome(identity, 'transform') == 'transform'
        assert stores[1].record_outcome(identity, 'allow') == 'transform'
        assert stores[1].get(identity).outcome == 'transform'
        assert stores[0].finish(identity, {'outcome': 'transform'}) == stores[1].finish(identity, {'outcome': 'allow'})
        assert stores[0]._redis.ttl(stores[0]._key(identity)) <= 300
        stores[0]._redis.delete(stores[0]._key(identity))
        assert stores[1].get(identity) is None
    finally:
        stores[0]._redis.delete(stores[0]._key(identity))
        for store in stores: store._redis.close()


@pytest.mark.asyncio
async def test_pinned_real_artifact_survives_removal_and_new_calls_fail(tmp_path):
    from tests.data_plane.test_artifact_execution import _runtime
    store, registry, engine = _runtime(tmp_path)
    state = protocol.DesiredState()
    state.ParseFromString(base64.b64decode((FIXTURE / 'desired-state.pb.b64').read_text()))
    artifact = state.artifacts[0]
    r = router()
    del r.routes[:2]
    t = r.routes[0].targets[0]
    t.guardrail_id, t.guardrail_version, t.artifact_id = artifact.guardrail_id, artifact.guardrail_version, artifact.artifact_id
    state.router_revisions.append(r)
    state.endpoints[0].router_id = r.router_id
    state.generation += 1
    store.apply(state)
    contexts = CallContextStore()
    services = [GuardrailRuntimeService(engine, store, contexts) for _ in range(2)]
    req = ProtectionRequest(phase='input', texts=('Hello',), call_id='retained-call', context=RequestContext(protocol='litellm', endpoint_id=state.endpoints[0].endpoint_id))
    try:
        first = await services[0].evaluate(req)
        old = contexts.get(req.call_id).resolution
        store.apply(protocol.DesiredState(generation=state.generation+1, disabled_guardrail_ids=[artifact.guardrail_id]))
        assert registry.acquire(old.plan, release_id=old.effective_release_id)[0].plan == old.plan
        output = await services[1].evaluate(replace(req, phase='output'))
        assert output.route_assignment == first.route_assignment
        with pytest.raises((RoutingError, LookupError)):
            await services[1].evaluate(replace(req, call_id='new-call'))
    finally:
        await engine.shutdown()
