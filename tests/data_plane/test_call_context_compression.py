"""Lossless plan storage: preserve shared call pinning, outcome ordering and TTL."""
import base64
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, replace
import json
import os
from urllib.parse import urlparse
from uuid import uuid4
import zlib

import pytest

from runner.call_context import RedisCallContextStore, _decode_plan, _encode_plan
from tests.data_plane.test_composed_routing import resolution


def large_resolution():
    item = resolution()
    first, *rest = item.plan.steps
    first = replace(first, parameters=(*first.parameters, ("synthetic-patterns", "abc[0-9]{32}|" * 20_000)))
    return replace(item, plan=replace(item.plan, steps=(first, *rest)),
                   effective_release_id="release-before-rollout", model_revision_id="models-before-rollout")


def test_large_plan_round_trip_is_lossless_and_materially_smaller():
    plan = asdict(large_resolution().plan)
    encoded = _encode_plan(plan, True)
    assert encoded["plan_encoding"] == "zlib-base64-v1"
    assert len(json.dumps(encoded)) < len(json.dumps(plan)) / 10
    # JSON canonicalization changes tuples to lists; the actual plan codec restores them.
    assert _decode_plan(encoded) == json.loads(json.dumps(plan))
    assert _decode_plan(_encode_plan(plan, False)) == plan
    assert _encode_plan({"steps": []}, True) == {"plan": {"steps": []}}


@pytest.mark.parametrize("payload", [
    {"plan_encoding": "unknown", "plan_encoded": ""},
    {"plan_encoding": "zlib-base64-v1", "plan": {}, "plan_encoded": ""},
    {"plan_encoding": "zlib-base64-v1", "plan_encoded": "not-base64!"},
    {"plan_encoding": "zlib-base64-v1", "plan_encoded": base64.b64encode(b"not-zlib").decode()},
    {"plan_encoding": "zlib-base64-v1", "plan_encoded": base64.b64encode(zlib.compress(b"[]")).decode()},
    {"plan_encoding": "zlib-base64-v1", "plan_encoded": base64.b64encode(zlib.compress(b"{}")[:-1]).decode()},
    {"plan_encoding": "zlib-base64-v1", "plan_encoded": base64.b64encode(zlib.compress(b"{}") + b"trailing").decode()},
])
def test_invalid_compressed_plan_is_rejected_instead_of_using_another_plan(payload):
    with pytest.raises((ValueError, zlib.error)):
        _decode_plan(payload)


def test_decompression_is_bounded(monkeypatch):
    import runner.call_context as module
    monkeypatch.setattr(module, "_MAX_COMPRESSED_PLAN_BYTES", 4096)
    encoded = base64.b64encode(zlib.compress(b'{"text":"' + b'a' * 100_000 + b'"}')).decode()
    with pytest.raises(ValueError, match="oversized"):
        _decode_plan({"plan_encoding": "zlib-base64-v1", "plan_encoded": encoded})


@pytest.mark.parametrize("compressed", [False, True])
def test_real_redis_preserves_atomic_pin_ttl_and_completion(compressed):
    url = os.environ.get("GUARD_TEST_REDIS_URL")
    if not url:
        pytest.skip("Set GUARD_TEST_REDIS_URL to isolated loopback Redis")
    assert urlparse(url).hostname in {"127.0.0.1", "localhost", "::1"}
    writers = [RedisCallContextStore(url, ttl_seconds=60, compress_plans=compressed),
               RedisCallContextStore(url, ttl_seconds=60, compress_plans=not compressed)]
    identity = "compressed-context-test-" + str(uuid4())
    chosen = large_resolution()
    changed = replace(chosen, plan=replace(chosen.plan, guardrail_version="new-version"))
    try:
        writers[0].claim(identity, ({"role": "user", "content": "synthetic text"},), chosen)
        ttl = writers[0]._redis.pttl(writers[0]._key(identity))
        with ThreadPoolExecutor(max_workers=2) as pool:
            claims = list(pool.map(lambda i: writers[i].claim(identity, (), changed), range(2)))
        assert all(c.resolution == chosen for c in claims)
        assert all(c.messages == ({"role": "user", "content": "synthetic text"},) for c in claims)
        raw = writers[0]._redis.get(writers[0]._key(identity))
        assert ("plan_encoding" in json.loads(raw)["resolution"]) is compressed
        assert writers[0].record_outcome(identity, "block") == "block"
        assert writers[1].record_outcome(identity, "allow") == "block"
        assert writers[1].get(identity).resolution == chosen
        first = writers[0].finish(identity, {"outcome": "block", "id": "first"})
        assert writers[1].finish(identity, {"outcome": "allow", "id": "later"}) == first
        assert writers[1].get(identity).completion == first
        assert 0 < writers[0]._redis.pttl(writers[0]._key(identity)) <= ttl
        writers[0]._redis.delete(writers[0]._key(identity))
        assert writers[1].get(identity) is None
    finally:
        writers[0]._redis.delete(writers[0]._key(identity))
        for store in writers:
            store._redis.close()
