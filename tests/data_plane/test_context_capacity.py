"""Capacity fallback preserves current-content checks, never masks other errors."""
from dataclasses import replace
import json
import os
from unittest.mock import Mock
from uuid import uuid4

from prometheus_client import CollectorRegistry, generate_latest
import pytest
from redis.exceptions import ConnectionError, OutOfMemoryError, ResponseError

from runner.call_context import RedisCallContextStore
from runner.evaluation_evidence import evaluation_evidence
from runner.runtime_log_capture import RuntimeLogCapture
from runner.toolkit.runtime.contracts import ProtectionDecision, ProtectionRequest
from runner.toolkit.runtime.service import GuardrailRuntimeService
from tests.data_plane.test_composed_routing import Resolver, context, resolution


def fake_store(*, enabled=True):
    store = RedisCallContextStore("redis://localhost:1", capacity_fallback=enabled,
                                 metrics_registry=CollectorRegistry())
    store._redis = Mock()
    store.capacity.redis = store._redis
    store._redis.get.return_value = None
    store._redis.info.return_value = {"maxmemory": 1000, "used_memory": 2000}
    store._redis.set.side_effect = OutOfMemoryError("command not allowed when used memory > maxmemory")
    return store


class Engine:
    def __init__(self): self.requests = []
    async def evaluate(self, request):
        self.requests.append(request)
        action = "block" if "private" in request.text else "allow"
        return ProtectionDecision(decision=action, action=action)


@pytest.mark.asyncio
@pytest.mark.parametrize("phase,text,decision", [("input", "private synthetic key", "block"),
    ("input", "hello", "allow"), ("output", "private synthetic key", "block"), ("output", "hello", "allow")])
async def test_full_redis_checks_current_content_and_exposes_context_degradation(phase, text, decision):
    store = fake_store(); engine = Engine(); service = GuardrailRuntimeService(engine, Resolver(), store)
    req = ProtectionRequest(phase=phase, texts=(text,), context=context(), call_id="endpoint:new")
    result = await service.evaluate(req)
    assert result.decision == decision
    assert engine.requests[0].text == text
    assert engine.requests[0].context_messages == ()
    evidence = json.loads(evaluation_evidence(result))
    assert evidence["context"]["reason"] == "redis_capacity"
    assert evidence["execution"]["status"] == "complete"
    store._redis.set.assert_not_called()
    assert store.capacity.events.labels(operation="lookup", reason="redis_capacity")._value.get() == 1


@pytest.mark.asyncio
async def test_capacity_recovery_does_not_treat_an_expired_context_as_capacity_failure():
    store = fake_store(); engine = Engine(); service = GuardrailRuntimeService(engine, Resolver(), store)
    req = ProtectionRequest(phase="output", texts=("hello",), context=context(), call_id="endpoint:missing")
    await service.evaluate(req)
    store._redis.info.return_value = {"maxmemory": 1000, "used_memory": 100}
    store.capacity._checked_at = 0
    with pytest.raises(Exception, match="call_context_expired"):
        await service.evaluate(req)
    assert store.degraded_reason() is None


def test_allocation_race_degrades_only_for_oom_and_preserves_current_messages():
    store = fake_store(); store._redis.info.return_value = {"maxmemory": 1000, "used_memory": 100}
    item = store.claim("new", ({"role": "user", "content": "current"},), resolution())
    assert item.messages[0]["content"] == "current"
    assert store.degraded_reason() == "redis_capacity"
    assert store.record_outcome("new", "block") == "block"
    assert store.finish("new", {"outcome": "block"}) == {"outcome": "block"}
    strict = fake_store(enabled=False)
    with pytest.raises(OutOfMemoryError): strict.claim("new", (), resolution())


@pytest.mark.parametrize("error", [ConnectionError("offline"), ResponseError("NOPERM")])
def test_non_capacity_failures_are_not_silently_ignored(error):
    store = fake_store(); store._redis.get.side_effect = error
    with pytest.raises(type(error)): store.get("new")
    assert store.degraded_reason() is None


def test_metrics_expose_capacity_and_unreachable_without_payloads():
    from runner.context_capacity import ContextCapacity
    registry = CollectorRegistry(); redis = Mock()
    redis.info.return_value = {"maxmemory": 4000, "used_memory": 2000}
    capacity = ContextCapacity(redis, registry=registry)
    metrics = generate_latest(registry).decode()
    assert "guard_runner_context_redis_maxmemory_bytes 4000.0" in metrics
    assert "guard_runner_context_redis_up 1.0" in metrics
    redis.info.side_effect = ConnectionError("offline")
    assert "guard_runner_context_redis_up 0.0" in generate_latest(registry).decode()


@pytest.mark.asyncio
async def test_real_redis_oom_keeps_existing_pin_checks_new_output_and_skips_log_history():
    url = os.environ.get("GUARD_TEST_REDIS_URL")
    if not url: pytest.skip("requires an isolated disposable Redis")
    from urllib.parse import urlparse
    assert urlparse(url).hostname in {"127.0.0.1", "localhost", "::1"}
    store = RedisCallContextStore(url, compress_plans=True, capacity_fallback=True)
    original = store._redis.config_get("maxmemory")["maxmemory"]
    identity = "capacity-test-" + str(uuid4()); missing = identity + "-new"
    logs = RuntimeLogCapture(url, on_capacity=Mock())
    try:
        pinned = store.claim(identity, ({"role": "user", "content": "prior input"},), resolution())
        store.record_outcome(identity, "block")
        ttl = store._redis.pttl(store._key(identity))
        store._redis.config_set("maxmemory", 1)
        store.begin_request()
        assert store.get(identity).resolution == pinned.resolution
        # EVAL writes may be rejected even for existing keys. Keep the previous
        # stronger outcome when an update cannot be stored.
        assert store.record_outcome(identity, "allow") == "block"
        assert 0 < store._redis.pttl(store._key(identity)) <= ttl
        service = GuardrailRuntimeService(Engine(), Resolver(), store)
        result = await service.evaluate(ProtectionRequest(phase="output", texts=("private key",),
            context=context(), call_id=missing))
        assert result.decision == "block"
        assert json.loads(evaluation_evidence(result))["context"]["status"] == "degraded"
        assert store._redis.get(store._key(missing)) is None
        with pytest.raises(OutOfMemoryError): await logs.level(missing, "debug")
        logs._on_capacity.assert_called_once()
        assert logs._items == {}
    finally:
        store._redis.config_set("maxmemory", original)
        store._redis.delete(store._key(identity), missing)
        store._redis.close()
        await logs.close()
