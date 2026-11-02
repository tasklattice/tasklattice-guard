from __future__ import annotations

import asyncio
import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest

from runner.capability_validation import validate_capability
from runner.model_validation_diagnostics import capture_validation_case, validation_http_hooks
from runner.toolkit.nemo.actions.strict_topic_safety import _StrictTopicControlModel
from runner.toolkit.nemo.native_models import NativeRailModel
from tests.control_plane.test_capability_validation import candidate


LOGGER = "uvicorn.error.tasklattice.model_validation"
SECRET = "synthetic-validation-secret"


def events(caplog):
    return [json.loads(record.message) for record in caplog.records if record.name == LOGGER]


def failed_exchanges(result):
    return [exchange for case in result.cases if not case.passed
            for exchange in json.loads(case.output_content)["model_exchanges"]]


@pytest.mark.parametrize("behavior", ["correct", "always-safe", "malformed", "http-error", "timeout"])
async def test_jev_logs_failed_cases_with_actual_systemone_payload_and_response(behavior, caplog):
    caplog.set_level(logging.WARNING, logger=LOGGER)

    def respond(request):
        body = json.loads(request.content)
        if behavior == "timeout":
            raise httpx.ReadTimeout("provider timeout", request=request)
        if behavior == "http-error":
            return httpx.Response(503, text=f"inference unavailable; credential={SECRET}", headers={"set-cookie": SECRET})
        if behavior == "malformed":
            return httpx.Response(200, text="not JSON")
        p = 0.99 if behavior == "correct" and "cake" in body["state"]["current_input"] else 0.01
        return httpx.Response(200, json={"model": "jev-1.13.0", "answers": {"unlisted_task": {"type": "noul", "noul": p}}})

    request = candidate("input", "topic_control", "tali.typesafe-jev-topic.v1", "tali.guard.topic-control.semantic.v1")
    result = await validate_capability(request, {"provider-1": SECRET}, transport=httpx.MockTransport(respond))
    assert result.passed is (behavior == "correct"), result.message
    logged = events(caplog)
    if behavior == "correct":
        assert logged == []
        assert all("model_exchanges" not in json.loads(case.output_content) for case in result.cases)
        return
    exchanges = failed_exchanges(result)
    assert exchanges
    assert len([item for item in logged if item["event"] == "rail_validation_model_exchange"]) == len(exchanges)
    assert all(item["validation_id"] == "candidate-1" and item["binding_id"] == "topic_control.input" for item in logged)
    wire_request = exchanges[-1]["request"]
    assert wire_request["url"] == "https://model.test/v1/systemone"
    assert wire_request["headers"]["authorization"] == "[REDACTED]"
    body = json.loads(wire_request["body"])
    assert body["questions"]["unlisted_task"]["instructions"]["allowed_topics"] == "Product support and password reset"
    assert "cake" in body["state"]["current_input"]
    if behavior == "timeout":
        assert exchanges[-1]["response"] is None
        assert exchanges[-1]["error"]["type"] == "ReadTimeout"
    else:
        assert exchanges[-1]["response"]["status"] == (503 if behavior == "http-error" else 200)
        if behavior == "always-safe":
            assert json.loads(exchanges[-1]["response"]["body"])["answers"]["unlisted_task"]["noul"] == 0.01
    assert SECRET not in json.dumps(logged)
    assert SECRET not in "".join(case.output_content for case in result.cases)


@pytest.mark.parametrize("behavior", ["correct", "always-safe", "malformed", "non-json", "http-error"])
async def test_native_nvidia_validation_captures_wire_parameters_and_raw_error_body(behavior, caplog, monkeypatch):
    caplog.set_level(logging.WARNING, logger=LOGGER)
    original_config = NativeRailModel.runtime_config

    def no_retries(self):
        config = original_config(self)
        config["parameters"]["max_attempts"] = 1
        return config

    monkeypatch.setattr(NativeRailModel, "runtime_config", no_retries)
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(body)
            label = "off-topic" if behavior == "correct" and "cake" in body["messages"][-1]["content"] else "on-topic"
            status = 500 if behavior == "http-error" else 200
            payload = (f"CUDA illegal memory access {SECRET}" if status == 500 else
                       "not a chat response" if behavior == "non-json" else
                       json.dumps({"choices": [{"message": {"content": "maybe" if behavior == "malformed" else label}}]})).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    request = candidate("input", "topic_control", "tali.nemoguard-topic-control.v1", "tali.guard.topic-control.semantic.v1")
    request.configuration.runtimes[0].base_url = f"http://127.0.0.1:{server.server_port}/v1"
    try:
        result = await validate_capability(request, {"provider-1": SECRET})
    finally:
        await asyncio.to_thread(server.shutdown)
        server.server_close()
        worker.join(timeout=5)

    assert len(requests) == 2
    assert result.passed is (behavior == "correct"), result.message
    if behavior == "correct":
        assert events(caplog) == []
        return
    exchanges = failed_exchanges(result)
    assert exchanges
    captured = json.loads(exchanges[-1]["request"]["body"])
    assert captured == requests[-1]
    assert captured["temperature"] == 0.01
    assert captured["max_tokens"] == 10
    assert "Product support and password reset" in captured["messages"][0]["content"]
    assert captured["messages"][0]["content"].endswith('You must respond with "on-topic" or "off-topic".')
    assert exchanges[-1]["response"]["status"] == (500 if behavior == "http-error" else 200)
    if behavior == "http-error":
        assert "CUDA illegal memory access" in exchanges[-1]["response"]["body"]
    if behavior == "non-json":
        assert exchanges[-1]["response"]["body"] == "not a chat response"
    assert SECRET not in json.dumps(events(caplog))
    assert SECRET not in "".join(case.output_content for case in result.cases)


async def test_llmrails_chat_adapter_captures_the_unparsed_response():
    from nemoguardrails.llm.clients.openai_compatible import OpenAICompatibleClient
    from nemoguardrails.llm.models.openai_chat import OpenAIChatModel

    def respond(_):
        return httpx.Response(200, json={"choices": [{"message": {"content": "maybe"}}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
        client = OpenAICompatibleClient("https://model.test/v1", api_key=SECRET, http_client=http)
        model = _StrictTopicControlModel(OpenAIChatModel(client, "topic-model"))
        with capture_validation_case(enabled=True, secrets=(SECRET,), case_id="malformed") as diagnostics:
            with pytest.raises(ValueError, match="response_schema.*InvalidTopicLabel"):
                await model.generate_async("cake", temperature=0.01, max_tokens=10)
        assert diagnostics.exchanges[0]["response"]["status"] == 200
        assert "maybe" in diagnostics.exchanges[0]["response"]["body"]
        assert diagnostics.exchanges[0]["error"]["type"] == "ModelResponseError"


async def test_diagnostics_are_scoped_redacted_and_bounded(caplog):
    caplog.set_level(logging.WARNING, logger=LOGGER)

    async def failed_case(identifier):
        with capture_validation_case(enabled=True, secrets=(SECRET,), case_id=identifier) as diagnostics:
            async with httpx.AsyncClient(event_hooks=validation_http_hooks(), transport=httpx.MockTransport(
                lambda _: httpx.Response(200, json={"echo": SECRET, "api_key": "another-secret", "content": identifier}))) as client:
                await asyncio.sleep(0)
                await client.post(f"https://user:{SECRET}@model.test/v1?api_key=another-secret", headers={"authorization": f"Bearer {SECRET}", "x-api-key": "another-secret"}, json={"content": identifier, "password": "another-secret"})
            diagnostics.failure(expected="block", actual="allow", reason="classification mismatch")
            huge = diagnostics.body("x" * 40_000 + SECRET)
            assert len(huge["body"]) == 32_768 and huge["body_truncated"]
        assert validation_http_hooks() == {}

    await asyncio.gather(failed_case("first"), failed_case("second"))
    for item in events(caplog):
        if item["event"] == "rail_validation_model_exchange":
            assert json.loads(item["request"]["body"])["content"] == item["case_id"]
            assert json.loads(item["response"]["body"])["content"] == item["case_id"]
    assert SECRET not in json.dumps(events(caplog))
    assert "another-secret" not in json.dumps(events(caplog))


async def test_outside_validation_no_body_capture_or_diagnostic_logs(caplog):
    caplog.set_level(logging.WARNING, logger=LOGGER)
    assert validation_http_hooks() == {}
    async with httpx.AsyncClient(event_hooks=validation_http_hooks(), transport=httpx.MockTransport(
            lambda _: httpx.Response(200, text="ordinary runtime response"))) as client:
        response = await client.post("https://model.test/v1", json={"content": "ordinary runtime request"})
    assert "tasklattice.validation_exchange" not in response.request.extensions
    assert events(caplog) == []
