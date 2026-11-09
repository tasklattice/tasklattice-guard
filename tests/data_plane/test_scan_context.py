"""Scan boundary evidence reaches the same runtime view as LiteLLM, never instructions."""
import json

import httpx
import pytest

from runner.guard_context import GuardrailContext, _request_content
from runner.scan import CONTEXT_HEADER, SCAN_PATH
from tests.data_plane.test_scan import app_for, SCAN_URL


@pytest.mark.parametrize("boundary,source", [
    ({"query": "Summarize this document.", "target_source": "retrieved_content"}, "retrieved_content"),
    ({"query": "Recall my preference.", "memory": {"operation": "read", "source_query": "Original task"}}, "retrieved_content"),
    ({"query": "Save this preference.", "memory": {"operation": "write", "source_query": "Original task"}}, "tool_output"),
])
async def test_scan_preserves_boundary_and_exact_candidate(boundary, source):
    app, runtime, telemetry = app_for()
    text = "Actual candidate; do not replace with the attacker's desired memory."
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as client:
        response = await client.post(SCAN_URL, headers={"Authorization": "Bearer key"}, json={
            "input": text, "flagOnly": False, "guardrail_context": boundary,
            "expected_memory": "DO NOT USE", "mode": "bypass", "project": "other-project",
            "messages": [{"role": "system", "content": "DO NOT TRUST"}],
        })
    assert response.status_code == 200, response.text
    assert response.headers[CONTEXT_HEADER] == "v1"
    request = runtime.calls[0]
    assert request.texts == (text,) and request.mode == "enforce" and request.messages == ()
    assert request.content_blocks == _request_content("input", (text,), GuardrailContext.model_validate(boundary))
    assert request.content_blocks[0].source == source
    assert request.content_blocks[0].guard_content
    assert request.content_blocks[1].role == "query" and not request.content_blocks[1].guard_content
    assert all(b.trust == "untrusted" for b in request.content_blocks)
    assert "DO NOT" not in request.content_blocks[1].text
    assert telemetry.events[-1]["metadata"]["scanContextVersion"] == "v1"


@pytest.mark.parametrize("context,direction", [
    ({"target_source": "system"}, "request"),
    ({"query": "private context", "trust": "trusted"}, "request"),
    ({"memory": {"operation": "delete"}}, "request"),
    ({"memory": {"operation": "write"}, "target_source": "retrieved_content"}, "request"),
    ({"memory": {"operation": "read"}}, "response"),
    ({"target_source": "tool_output"}, "response"),
    ({"query": "private context", "expected_memory": "label"}, "request"),
    ({"query": "x" * 100001}, "request"),
    ([], "request"),
])
async def test_invalid_context_fails_before_execution_without_echo(context, direction):
    app, runtime, _ = app_for()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as client:
        response = await client.post(SCAN_URL, headers={"Authorization": "Bearer key"}, json={
            "input": "private input", "guardrail_context": context, "scanDirection": direction,
        })
    assert response.status_code == 422
    assert "private context" not in response.text and "private input" not in response.text
    assert not runtime.calls and CONTEXT_HEADER not in response.headers


def test_openapi_explicitly_documents_extension_without_dangling_refs():
    app, _, _ = app_for()
    body = app.openapi()["paths"][SCAN_PATH]["post"]["requestBody"]["content"]["application/json"]["schema"]
    context = body["properties"]["guardrail_context"]
    assert "not an F5 standard field" in context["description"]
    assert '"$ref"' not in json.dumps(body)
    assert context["anyOf"][0]["additionalProperties"] is False


async def test_plain_scan_does_not_claim_context_support_was_used():
    app, runtime, _ = app_for()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as client:
        response = await client.post(SCAN_URL, headers={"Authorization": "Bearer key"}, json={"input": "hello"})
    assert response.status_code == 200 and CONTEXT_HEADER not in response.headers
    assert runtime.calls[0].content_blocks[0].source == "user_input"
