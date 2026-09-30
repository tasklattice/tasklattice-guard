"""Connection protocol, full-response transformations, pinning and failure cleanup."""
import asyncio
import json

import aiohttp
import httpx
import pytest

from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.actions import local_action_providers
from tests.data_plane.test_artifact_execution import _desired_state
from tests.stream_client import connection, exchange, released, runner


@pytest.mark.parametrize("parts,expected", [
    (["normal ", "answer"], "normal answer"),
    (["internal-", "name"], "public-name"),
    (["内部", "代号"], "公开名称"),
    (["confi", "dential"], None),
])
async def test_full_response_checks_once_and_never_releases_original_prefix(tmp_path, parts, expected):
    async with runner(tmp_path, "configured-phrases-v1") as (url, _, _, telemetry, _):
        async with connection(url) as (socket, ready):
            assert ready["mode"] == "full_buffered"
            await socket.send_json({"type": "delta", "sequence": 0, "text": parts[0]})
            assert (await socket.receive_json())["type"] == "ack"
            # No text can be emitted before an explicit normal end.
            with pytest.raises(TimeoutError): await socket.receive_json(timeout=0.02)
            await socket.send_json({"type": "delta", "sequence": 1, "text": parts[1]})
            assert (await socket.receive_json())["type"] == "ack"
            await socket.send_json({"type": "end", "sequence": 2})
            events = []
            while True:
                event = await socket.receive_json(timeout=5); events.append(event)
                if event["type"] in {"completed", "blocked", "error"}: break
            assert released(events) == (expected or "")
            assert events[-1]["type"] == ("blocked" if expected is None else "completed")
            assert events[-1]["checks"] == 1
        assert len(telemetry.events) == 1
        assert telemetry.events[0]["metadata"]["streamFinalCheck"] is True


@pytest.mark.parametrize("bad", [
    {"type": "delta", "sequence": 1, "text": "late"},
    {"type": "delta", "sequence": True, "text": "bad"},
    {"type": "delta", "sequence": 0, "text": 12},
    {"type": "delta", "sequence": 0, "text": "x", "mode": "interruptible"},
    {"type": "end", "sequence": 0, "text": "must not bypass checks"},
    {"type": "unknown", "sequence": 0},
])
async def test_invalid_frames_fail_without_delivery(tmp_path, bad):
    async with runner(tmp_path) as (url, _, _, _, _), connection(url) as (socket, _):
        await socket.send_json(bad)
        reply = await socket.receive_json(timeout=5)
        assert reply["type"] == "error" and reply["code"] == "invalid_stream"
        assert "text" not in reply


async def test_wrong_credentials_adapter_and_retired_http_protocol_are_rejected(tmp_path):
    async with runner(tmp_path) as (url, _, _, _, _):
        with pytest.raises(aiohttp.WSServerHandshakeError):
            async with connection(url, credential="incorrect"): pytest.fail("Unauthenticated connection accepted")
        async with connection(url, protocol="http") as (_, reply):
            assert reply["type"] == "error" and reply["code"] == "invalid_stream"
        async with httpx.AsyncClient() as client:
            response = await client.post(f"{url}/runtime/v1/endpoints/fixture-endpoint/guardrails/output-stream",
                headers={"x-api-key": "fixture-runtime-secret"}, json={"stream_id": "old", "text": "hello", "final": True})
            assert response.status_code in {404, 405}


async def test_release_and_model_revision_are_pinned_until_connection_finishes(tmp_path):
    async with runner(tmp_path) as (url, _, _, telemetry, store):
        async with connection(url) as (socket, ready):
            await socket.send_json({"type": "delta", "sequence": 0, "text": "safe"})
            assert (await socket.receive_json())["type"] == "ack"
            desired = _desired_state(); desired.generation = 2
            desired.model_configuration.revision_id = "new-model-revision"
            store.apply(desired, providers=action_providers(*local_action_providers()))
            await socket.send_json({"type": "end", "sequence": 1})
            events = []
            while True:
                event = await socket.receive_json(timeout=5); events.append(event)
                if event["type"] in {"completed", "blocked", "error"}: break
            assert events[-1]["type"] == "completed" and released(events) == "safe"
        async with connection(url) as (_, next_ready):
            assert next_ready["effective_release_id"] != ready["effective_release_id"]
            assert next_ready["model_revision_id"] == "new-model-revision"
        assert telemetry.events[0]["metadata"]["effectiveReleaseId"] == ready["effective_release_id"]


async def test_idle_stream_has_terminal_timeout_and_no_completion(tmp_path, monkeypatch):
    import runner.output_streaming as transport
    monkeypatch.setattr(transport, "MAX_SECONDS", 0.1)
    async with runner(tmp_path) as (url, _, registry, _, store), connection(url) as (socket, _):
        reply = await socket.receive_json(timeout=5)
        assert reply["type"] == "error" and reply["code"] == "timeout"
        assert registry.get(store.plan(*store.active_plan_keys()[0])).active_requests == 0


async def test_credit_overrun_terminates_and_cancels_a_pending_model_check(tmp_path):
    from tests.data_plane.test_stream_safety_artifact import safety_providers, classification
    entered, gate = asyncio.Event(), asyncio.Event()
    async def classify(_):
        entered.set()
        await gate.wait()
        return httpx.Response(200, json=classification("nvidia", False))
    providers = safety_providers("nvidia", transport=httpx.MockTransport(classify))
    async with runner(tmp_path, "stream-safety-window_buffered-v1", providers=providers) as (url, _, registry, _, store):
        async with connection(url) as (socket, _):
            for i in range(200):
                await socket.send_json({"type": "delta", "sequence": i, "text": "safe "})
                assert (await socket.receive_json())["type"] == "ack"
            await asyncio.wait_for(entered.wait(), 3)
            for i in range(200, 209):
                await socket.send_json({"type": "delta", "sequence": i, "text": "pending "})
            reply = await socket.receive_json(timeout=5)
            assert reply["type"] == "error" and reply["code"] == "invalid_stream"
            assert registry.get(store.plan(*store.active_plan_keys()[0])).active_requests == 0


async def test_reconnection_cannot_resume_buffered_text_on_another_replica(tmp_path):
    async with runner(tmp_path / "one") as (first, _, _, _, _), runner(tmp_path / "two") as (second, _, _, _, _):
        async with connection(first) as (socket, _):
            await socket.send_json({"type": "delta", "sequence": 0, "text": "private unfinished prefix"})
            assert (await socket.receive_json())["type"] == "ack"
        async with connection(second) as (socket, _):
            await socket.send_json({"type": "end", "sequence": 1})
            reply = await socket.receive_json(timeout=5)
            assert reply["type"] == "error" and "private" not in json.dumps(reply)


@pytest.mark.parametrize("protocol,adapter", [("http", "generic-http-guard"), ("a2a", "a2a-guard"),
                                             ("litellm", "litellm-generic-guardrail")])
async def test_stream_uses_normal_adapter_identity_mapping(tmp_path, monkeypatch, protocol, adapter):
    from runner.toolkit.runtime.context import CallContextStore
    contexts = CallContextStore()
    async with runner(tmp_path, contexts=contexts) as (url, engine, _, _, store):
        monkeypatch.setattr(store, "endpoint_adapter", lambda _: adapter)
        seen = []
        original = engine.output_stream_contract
        def contract(request):
            seen.append(request)
            return original(request)
        monkeypatch.setattr(engine, "output_stream_contract", contract)
        async with connection(url, protocol=protocol, stream_id="identity", model="chat-model",
                request_data={"user_api_key_team_id": "team-1"},
                request_headers={"x-api-key": "never-forward", "x-original-uri": "/chat/completions"}) as (socket, ready):
            assert ready["type"] == "ready"
            events = await exchange(socket, ["safe"])
            assert events[-1]["type"] == "completed"
        assert len(seen) == 1
        assert contexts.get("fixture-endpoint:identity") is not None
        context = seen[0].request_context
        assert context.protocol == protocol
        if protocol == "litellm":
            assert context.value("field", "litellm.team_id") == "team-1"
            assert context.value("field", "http.path") == "/chat/completions"
            assert context.value("header", "x-api-key") is None


async def test_unicode_delta_limit_counts_text_not_json_escaping(tmp_path):
    text = "界"*25_000
    async with runner(tmp_path, "configured-phrases-v1") as (url, _, _, _, _), connection(url) as (socket, _):
        events = await exchange(socket, [text])
        assert events[-1]["type"] == "completed" and released(events) == text
