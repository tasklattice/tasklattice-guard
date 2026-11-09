import asyncio

import pytest

from runner.compiler import DefaultRunnerCompiler
from runner.draft_preview import DraftPreviewRuntime
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext
from tests.control_plane.test_ordered_execution import RecordingSecrets, chain_plan


class SlowBlocking(RecordingSecrets):
    async def execute(self, request):
        if request.binding.id == "lower":
            await asyncio.sleep(0.05)
        return await super().execute(request)


@pytest.mark.asyncio
async def test_parallel_group_waits_for_smaller_rank_block():
    steps = [("lower", "alpha", "unused", "block"),
             ("higher", "alpha", "unused", "block"),
             ("later", "alpha", "[L]", "transform")]
    plan = chain_plan(steps, "input")
    for index, step in enumerate(plan["steps"][:2]):
        step["parameters"] += [["parallel_group_input", "segment"],
                               ["parallel_leader_input", str(index == 0).lower()]]
    plan["steps"][2]["parameters"] = [
        item for item in plan["steps"][2]["parameters"]
        if not item[0].startswith(("parallel_group_", "parallel_leader_"))
    ]
    plan["modules"][1]["depends_on"] = []
    for module in plan["modules"][2:]:
        module["depends_on"] = [plan["modules"][0]["id"], plan["modules"][1]["id"]]
    provider = SlowBlocking()
    runtime = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(provider))
    try:
        result = await runtime.evaluate(
            ProtectionRequest(phase="input", texts=("alpha beta",),
                              context=RequestContext(protocol="playground")),
            preview_id="rank-group", guardrail_id="ordered", draft_revision=1,
            candidate_version="20260904-010000.001Z", plan=plan, runtime_profile="auto",
        )
    finally:
        await runtime.shutdown()
    assert result.decision == "block"
    policies = [item for item in result.trace if item.kind == "policy"]
    lower = next(item for item in policies if item.policy_id == "lower")
    assert lower.status == "blocked"
    # The authored lower rank is the authoritative blocking candidate even if
    # the higher rank returned first.
    assert result.reason


@pytest.mark.asyncio
async def test_transform_barrier_feeds_later_block_group_new_content():
    steps = [("a", "missing", "unused", "allow"),
             ("b", "missing", "unused", "block"),
             ("t", "alpha", "[A]", "transform"),
             ("c", "alpha", "unused", "block")]
    plan = chain_plan(steps, "input")
    for index, step in enumerate(plan["steps"][:2]):
        step["parameters"] += [["parallel_group_input", "before"],
                               ["parallel_leader_input", str(index == 0).lower()]]
    plan["modules"][1]["depends_on"] = []
    plan["modules"][2]["depends_on"] = [plan["modules"][0]["id"], plan["modules"][1]["id"]]
    plan["modules"][3]["depends_on"] = [plan["modules"][2]["id"]]
    provider = RecordingSecrets()
    runtime = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(provider))
    try:
        result = await runtime.evaluate(
            ProtectionRequest(phase="input", texts=("alpha beta",),
                              context=RequestContext(protocol="playground")),
            preview_id="rank-barrier", guardrail_id="ordered", draft_revision=1,
            candidate_version="20260904-010000.001Z", plan=plan, runtime_profile="auto",
        )
    finally:
        await runtime.shutdown()
    assert result.decision == "transform", result.reason
    assert result.texts == ("[A] beta",)
    assert ("c", "[A] beta") in provider.calls
    assert ("c", "alpha beta") not in provider.calls


@pytest.mark.asyncio
async def test_full_evidence_keeps_official_block_while_collecting_later_diagnostics():
    steps = [("block", "alpha", "unused", "block"),
             ("redact", "beta", "[B]", "transform"),
             ("after", "missing", "unused", "allow")]
    plan = chain_plan(steps, "input")
    provider = RecordingSecrets()
    runtime = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(provider))
    try:
        result = await runtime.evaluate(
            ProtectionRequest(phase="input", texts=("alpha beta",), evidence_scope="full",
                              execution_purpose="validation",
                              context=RequestContext(protocol="validation")),
            preview_id="rank-full", guardrail_id="ordered", draft_revision=1,
            candidate_version="20260904-010000.001Z", plan=plan, runtime_profile="auto",
        )
    finally:
        await runtime.shutdown()
    assert result.decision == "block"
    assert result.texts == ()
    assert any(item.kind == "policy" and item.policy_id == "redact" for item in result.trace)
    assert provider.calls[-1] == ("after", "alpha [B]")
