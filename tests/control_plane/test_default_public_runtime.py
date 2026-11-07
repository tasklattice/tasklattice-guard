"""Check the evaluator's actual plan builder and history transport without models."""
from __future__ import annotations

import pytest

from runner.compiler import DefaultRunnerCompiler
from runner.draft_preview import DraftPreviewRuntime
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.actions import local_action_providers
from runner.toolkit.nemo.actions.content_filter import ContentFilterActionProvider
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext
from scripts.evaluate_default_public import build_default_plan, diagnostic_cases


@pytest.mark.asyncio
async def test_public_evaluator_current_default_transports_history():
    built = build_default_plan()
    plan = built["plan"]
    assert len(plan["policy_bindings"]) == 17
    assert built["draft"]["safetyLevel"] == "balanced"
    assert built["draft"]["outputDelivery"] == "full_buffered"
    seen = []

    class ObservedContentFilter(ContentFilterActionProvider):
        async def execute(self, request):
            seen.append((request.content, request.context_messages))
            return await super().execute(request)

    providers = (ObservedContentFilter(), *[p for p in local_action_providers()
                                          if not isinstance(p, ContentFilterActionProvider)])
    runtime = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(*providers))
    identity = dict(preview_id="public-history-test", guardrail_id=plan["guardrail_id"],
                    draft_revision=1, candidate_version=plan["guardrail_version"], plan=plan, runtime_profile="auto")
    cases = {c.id: c for c in diagnostic_cases()}
    try:
        decisions = []
        for scenario in ("harmful", "benign"):
            case = cases[f"diagnostic:history-{scenario}-messages:input"]
            seen.clear()
            result = await runtime.evaluate(ProtectionRequest(phase="input", texts=(case.text,),
                messages=case.messages, context=RequestContext(protocol="playground")), **identity)
            # This proves actual action requests carry history. It does not
            # assert that the lexical evaluator understands the history.
            assert seen
            assert all(history == case.messages for _, history in seen)
            assert result.usage.model_invocations == 0
            assert result.usage.fail_closed is False
            decisions.append(result.decision)
        assert decisions == ["allow", "allow"]
    finally:
        await runtime.shutdown()
