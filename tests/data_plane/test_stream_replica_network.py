"""Input/output assignment crosses replicas; output connections never resume.

Optional Redis run uses only random test-owned keys, never FLUSHDB. The normal
run shares the same CallContextStore through two actual TCP Runner instances.
"""
import os
from urllib.parse import urlparse
from uuid import uuid4

import httpx
import pytest

from runner.call_context import RedisCallContextStore
from runner.toolkit.runtime.context import CallContextStore
from tests.stream_client import runner, connection, exchange, released


@pytest.mark.parametrize("backend", ["memory", "redis"])
@pytest.mark.parametrize("expired", [False, True])
async def test_input_assignment_survives_replica_shutdown_but_expired_pin_fails(tmp_path, backend, expired):
    call_id = str(uuid4())
    scoped = f"fixture-endpoint:{call_id}"
    if backend == "redis":
        url = os.environ.get("GUARD_TEST_REDIS_URL")
        if not url:
            pytest.skip("Set GUARD_TEST_REDIS_URL to dedicated loopback Redis")
        assert urlparse(url).hostname in {"127.0.0.1", "localhost", "::1"}
        contexts = [RedisCallContextStore(url) for _ in range(2)]
    else:
        contexts = [CallContextStore()]*2
    try:
        async with runner(tmp_path / "b", contexts=contexts[1]) as (second, _, _, _, _):
            async with runner(tmp_path / "a", contexts=contexts[0]) as (first, _, _, _, _):
                async with httpx.AsyncClient() as client:
                    response = await client.post(first + "/runtime/v1/endpoints/fixture-endpoint/beta/litellm_basic_guardrail_api",
                        headers={"x-api-key": "fixture-runtime-secret"}, json={"input_type": "request",
                            "litellm_call_id": call_id, "texts": ["Tell me a story"], "request_data": {}})
                    assert response.status_code == 200
                pin = contexts[1].get(scoped).resolution
            # The input replica and engine are now stopped.
            if expired:
                if backend == "redis": contexts[0]._redis.delete(contexts[0]._key(scoped))
                else: contexts[0]._items.pop(scoped)
            async with connection(second, call_id=call_id) as (socket, ready):
                if expired:
                    assert ready["type"] == "error" and ready["code"] == "routing_failed"
                    return
                assert ready["effective_release_id"] == pin.effective_release_id
                assert ready["model_revision_id"] == pin.model_revision_id
                events = await exchange(socket, ["ordinary ", "answer"])
                assert events[-1]["type"] == "completed" and released(events) == "ordinary answer"
    finally:
        if backend == "redis":
            contexts[0]._redis.delete(contexts[0]._key(scoped))
            for context in contexts: context._redis.close()
