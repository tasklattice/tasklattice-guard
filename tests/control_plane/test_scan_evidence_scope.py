"""Scan's HTTP flags must not change its deliberate full-evidence execution."""
import asyncio
import json

import httpx
import pytest

from runner.compiler import DefaultRunnerCompiler
from runner.draft_preview import DraftPreviewRuntime
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.actions.content_filter import ContentFilterActionProvider
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext
from tests.control_plane.test_schedule_invariance import _controller_plans
from tests.data_plane.test_scan import app_for, SCAN_URL


@pytest.fixture(scope="module")
def mixed_plan():
    return _controller_plans()["mix"]


class Recorder(ContentFilterActionProvider):
    def __init__(self):
        super().__init__()
        self.calls = []
        self.fail_rule = None

    async def execute(self, request):
        rules = [rule for ids in json.loads(dict(request.parameters)["enabled_rules_json"]).values() for rule in ids]
        self.calls.extend(rules)
        if self.fail_rule in rules:
            raise RuntimeError("later check failed")
        return await super().execute(request)


@pytest.mark.parametrize("direction", ["request", "response"])
@pytest.mark.parametrize("flag_only", [True, False])
@pytest.mark.parametrize("verbose", [True, False])
@pytest.mark.parametrize("later_error", [False, True])
async def test_scan_continues_after_block_without_changing_delivery_or_hiding_errors(
    mixed_plan, direction, flag_only, verbose, later_error,
):
    recorder = Recorder()
    previews = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(recorder))
    phase = "input" if direction == "request" else "output"
    decisions = []

    async def evaluate(request):
        return await previews.evaluate(request, preview_id="scan-evidence", guardrail_id="invariance",
            draft_revision=1, candidate_version=mixed_plan["guardrail_version"], plan=mixed_plan, runtime_profile="auto")

    class ScanRuntime:
        async def evaluate_standalone(self, request, *, on_resolved, validate_decision, timeout_seconds):
            async with asyncio.timeout(timeout_seconds):
                value = await evaluate(request)
            decisions.append(value)
            validate_decision(value)
            return value

    try:
        fast = await evaluate(ProtectionRequest(phase=phase, texts=("alpha beta",),
            evidence_scope="interventions", context=RequestContext(protocol="litellm")))
        assert fast.decision == "block" and not fast.usage.fail_closed
        assert recorder.calls == ["r-block"]
        recorder.calls.clear()
        recorder.fail_rule = "r-mask" if later_error else None
        app, _, _ = app_for(ScanRuntime())
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://runner") as client:
            result = await client.post(SCAN_URL, headers={"Authorization": "Bearer key"}, json={
                "input": "alpha beta", "scanDirection": direction, "flagOnly": flag_only, "verbose": verbose,
                "evidence_scope": "interventions",  # Unknown fields cannot change Scan's contract.
            })
        if later_error:
            assert result.status_code == 503, result.text
            assert result.json()["detail"]["code"] == "scan_execution_failed"
            assert recorder.calls[:2] == ["r-block", "r-mask"]
        else:
            assert result.status_code == 200, result.text
            assert result.json()["result"]["outcome"] == ("flagged" if flag_only else "blocked")
            assert result.json()["result"]["response"] is None
            assert len(result.json()["result"]["scannerResults"]) == int(verbose)
            assert recorder.calls == ["r-block", "r-mask", "r-observe"]
            assert {finding.rule_id for finding in decisions[-1].findings if finding.verdict == "matched"} == {
                "r-block", "r-mask", "r-observe",
            }
        # Full collection must retain the same concrete Block attribution as
        # the fast path, even after a sibling transform, observation or error.
        expected_block = "nemo:builtin_content_filter:mix:r-block:rules:block"
        assert [item.fragment_id for item in fast.interventions if item.kind == "block"] == [expected_block]
        assert [item.fragment_id for item in decisions[-1].interventions if item.kind == "block"] == [expected_block]
    finally:
        await previews.shutdown()
