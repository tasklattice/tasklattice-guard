"""Real compiled Guardrails must behave identically through both HTTP adapters."""
from contextlib import asynccontextmanager
import json

import httpx
import pytest
from fastapi import FastAPI
from runner.api import RunnerAPI
from tests.test_runner_api import Telemetry

from runner.compiler import DefaultRunnerCompiler
from runner.draft_preview import DraftPreviewRuntime
from runner.metrics import RunnerMetrics
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.actions.content_filter import ContentFilterActionProvider
from runner.toolkit.nemo.actions.contracts import ActionResult
from runner.toolkit.runtime.contracts import PlanResolution, ProtectionRequest, RequestContext
from runner.toolkit.runtime.service import GuardrailRuntimeService
from tests.control_plane.test_schedule_invariance import _controller_plans
from tests.data_plane.test_scan import Store, SCAN_URL, LITELLM_ENDPOINT_ID

LITE_URL = f"/runtime/v1/endpoints/{LITELLM_ENDPOINT_ID}/beta/litellm_basic_guardrail_api"


@pytest.fixture(scope="module")
def plans():
    return _controller_plans()


class Recorder(ContentFilterActionProvider):
    def __init__(self, fail_rule="r-mask", failure="exception"):
        super().__init__()
        self.calls = []
        self.fail_rule, self.failure = fail_rule, failure

    async def execute(self, request):
        rules = [rule for ids in json.loads(dict(request.parameters)["enabled_rules_json"]).values() for rule in ids]
        self.calls.extend(rules)
        if self.fail_rule in rules:
            if self.failure == "needs_context":
                return ActionResult("unknown", request.content, unknown_reason="missing_context")
            if self.failure == "timeout":
                raise TimeoutError()
            raise RuntimeError("synthetic detector failure")
        return await super().execute(request)


@asynccontextmanager
async def online_app(plan, *, capture="info", recorder=None, mode="enforce"):
    recorder = recorder or Recorder()
    previews = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(recorder))
    await previews.prepare(preview_id="parity", guardrail_id=plan["guardrail_id"], draft_revision=1,
        candidate_version=plan["guardrail_version"], plan=plan, runtime_profile="auto")
    entry = previews._items["parity"]
    snapshot = entry.service._resolver.resolve_guardrail(plan["guardrail_id"], plan["guardrail_version"]).plan

    class Resolver:
        def resolve(self, context):
            return PlanResolution(plan=snapshot, router_id="same-router", endpoint_id=context.endpoint_id)
        def protection_mode(self, _):
            return mode

    store = Store()
    store.logging_level = lambda _: capture
    service = GuardrailRuntimeService(entry.runtime, Resolver())
    metrics, telemetry, app = RunnerMetrics(8), Telemetry(), FastAPI()
    api = RunnerAPI(service, store, metrics, telemetry, "runner", "controller", runtime_log_encryption_key=b"k" * 32)
    app.include_router(api.router)
    app.state.guard_api = api
    try:
        yield app, service, recorder, telemetry
    finally:
        await previews.shutdown()


async def send(client, adapter, direction, text="alpha beta", **flags):
    headers = {"x-guard-evidence": "evaluations-v1"}
    if adapter == "scan":
        return await client.post(SCAN_URL, headers={**headers, "Authorization": "Bearer key"},
            json={"input": text, "scanDirection": direction, **flags,
                  "evidence_scope": "full", "execution_purpose": "validation"})
    return await client.post(LITE_URL, headers={**headers, "x-api-key": "lite-key"},
        json={"texts": [text], "input_type": direction, "litellm_call_id": "parity-call"})


@pytest.mark.parametrize("direction", ["request", "response"])
@pytest.mark.parametrize("flag_only,verbose", [(False, False), (False, True), (True, False), (True, True)])
@pytest.mark.parametrize("capture", ["info", "debug", "trace"])
@pytest.mark.parametrize("failure", ["exception", "timeout", "needs_context"])
async def test_both_adapters_stop_after_block_regardless_of_http_flags_or_snapshot(
    plans, direction, flag_only, verbose, capture, failure,
):
    async with online_app(plans["mix"], capture=capture, recorder=Recorder(failure=failure)) as (app, _, recorder, telemetry):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as client:
            scan = await send(client, "scan", direction, flagOnly=flag_only, verbose=verbose)
            lite = await send(client, "lite", direction)
        assert scan.status_code == lite.status_code == 200, (scan.text, lite.text)
        assert scan.json()["result"]["outcome"] == ("flagged" if flag_only else "blocked")
        assert len(scan.json()["result"]["scannerResults"]) == int(verbose)
        assert lite.json()["action"] == "BLOCKED"
        assert recorder.calls == ["r-block", "r-block"]
        for response in (scan, lite):
            assert json.loads(response.headers["x-guard-evaluation-evidence"])["execution"]["status"] == "complete"
        for event in telemetry.events:
            assert event["decision"] == "block"
            assert event["metadata"]["executionStatus"] == "complete"
            assert event["metadata"]["terminationReason"] == "policy_block"
            assert event["metadata"]["usage"]["fail_closed"] is False
        for protocol in ("scan", "litellm"):
            samples = [s for m in app.state.guard_api._metrics.registry.collect() for s in m.samples
                       if s.name == "guard_runner_guardrail_requests_total" and s.labels.get("protocol") == protocol]
            assert samples and all(s.labels["result"] == "success" for s in samples)



@pytest.mark.parametrize("direction", ["request", "response"])
@pytest.mark.parametrize("failure,status", [("exception", 503), ("timeout", 504), ("needs_context", 503)])
async def test_required_check_failure_is_an_execution_error_in_both_adapters(plans, direction, failure, status):
    async with online_app(plans["mix"], recorder=Recorder("r-block", failure)) as (app, _, _, telemetry):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as client:
            for adapter in ("scan", "lite"):
                response = await send(client, adapter, direction, flagOnly=False)
                assert response.status_code == status, response.text
                event = telemetry.events[-1]
                assert event["metadata"]["executionStatus"] == ("timeout" if status == 504 else "error")
                assert any(d["affectsResult"] for d in event["metadata"]["diagnostics"])
                assert event["metadata"]["terminationReason"] != "policy_block"


@pytest.mark.parametrize("mode", ["monitor", "bypass"])
async def test_resource_modes_belong_to_guardrails_for_both_adapters(plans, mode):
    async with online_app(plans["mix"], mode=mode) as (app, _, recorder, telemetry):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as client:
            scan = await send(client, "scan", "request", flagOnly=False, verbose=True)
            lite = await send(client, "lite", "request")
        assert scan.status_code == lite.status_code == 200
        assert scan.json()["result"]["outcome"] == "cleared"
        assert lite.json()["action"] == "NONE"
        assert all(e["metadata"]["protectionMode"] == mode for e in telemetry.events)
        if mode == "bypass":
            assert recorder.calls == []


async def test_terminal_block_stops_remaining_content_items(plans):
    async with online_app(plans["mix"]) as (_, service, recorder, _):
        result = await service.evaluate(ProtectionRequest(phase="input", texts=("alpha", "alpha"),
            context=RequestContext(protocol="litellm", endpoint_id=LITELLM_ENDPOINT_ID)))
        assert result.execution_status == "complete" and result.decision == "block"
        assert recorder.calls == ["r-block"]
        assert [r.evaluated for r in result.content_results] == [True, False]
        assert any(s.kind == "content" and s.status == "skipped" for s in result.trace)


@pytest.mark.parametrize("failure", ["buffer", "encrypt"])
async def test_snapshot_failure_does_not_change_guardrail_result(plans, monkeypatch, failure):
    async with online_app(plans["mix"], capture="debug") as (app, _, recorder, telemetry):
        if failure == "buffer":
            async def broken(*args, **kwargs):
                raise ConnectionError("snapshot storage unavailable")
            monkeypatch.setattr(app.state.guard_api._runtime_log_capture, "record", broken)
        else:
            def broken(*args, **kwargs):
                raise ValueError("snapshot encryption unavailable")
            monkeypatch.setattr("runner.api._encrypt_runtime_log_content", broken)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as client:
            for adapter in ("scan", "lite"):
                result = await send(client, adapter, "request", flagOnly=False)
                assert result.status_code == 200, result.text
        assert recorder.calls == ["r-block", "r-block"]
        assert all(e["decision"] == "block" and e["metadata"]["executionStatus"] == "complete" for e in telemetry.events)
        assert all(e["metadata"]["callCaptureIncomplete"] for e in telemetry.events)


@pytest.mark.parametrize("direction", ["request", "response"])
async def test_fail_open_binding_is_degraded_for_both_adapters(plans, direction):
    from copy import deepcopy
    plan = deepcopy(plans["mix"])
    for module in plan["modules"]:
        module["failure_mode"] = "fail_open"
    async with online_app(plan, recorder=Recorder("r-block")) as (app, _, _, telemetry):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as client:
            scan = await send(client, "scan", direction, flagOnly=False)
            lite = await send(client, "lite", direction)
        assert scan.status_code == lite.status_code == 200, (scan.text, lite.text)
        assert scan.json()["result"]["outcome"] == "redacted"
        assert lite.json()["action"] == "GUARDRAIL_INTERVENED"
        for event in telemetry.events:
            assert event["metadata"]["executionStatus"] == "degraded"
            assert event["metadata"]["terminationReason"] == "fail_open"
            assert not any(d["affectsResult"] for d in event["metadata"]["diagnostics"])
