from __future__ import annotations

import asyncio
import threading

import pytest


@pytest.mark.parametrize("kind", ["preview", "validation"])
async def test_cancelled_candidate_build_stays_off_loop_and_closes_runtime(monkeypatch, kind):
    from runner.compiler import DefaultRunnerCompiler
    from runner.draft_preview import DraftPreviewRuntime
    from runner.validator import DefaultRunnerValidator
    from runner import generated as protocol
    from runner.protocol_codec import plan_to_proto
    from runner.toolkit.nemo.action_registry import action_providers
    from runner.toolkit.nemo.actions import local_action_providers
    from tests.test_runner_draft_preview import PLAN

    compiler = DefaultRunnerCompiler()
    entered, release = threading.Event(), threading.Event()
    main_thread = threading.get_ident()
    created = []
    if kind == "preview":
        owner = DraftPreviewRuntime(compiler, action_providers(*local_action_providers()))
        call = owner.prepare(preview_id="cancel-test", guardrail_id=PLAN["guardrail_id"],
                             draft_revision=1, candidate_version=PLAN["guardrail_version"],
                             plan=PLAN, runtime_profile="auto")
    else:
        owner = DefaultRunnerValidator(compiler)
        call = owner.validate(protocol.ValidationRequest(run_id="cancel-test", guardrail_id=PLAN["guardrail_id"],
            candidate_version=PLAN["guardrail_version"], plan=plan_to_proto(PLAN), runtime_profile="auto"))
    original = owner._prepare

    def build(*args):
        assert threading.get_ident() != main_thread
        result = original(*args)
        registry = result.runtime._registry if kind == "preview" else result[0]
        created.append(registry)
        entered.set()
        assert release.wait(3)
        return result

    monkeypatch.setattr(owner, "_prepare", build)
    task = asyncio.create_task(call)
    try:
        assert await asyncio.to_thread(entered.wait, 3)
        task.cancel()
        await asyncio.sleep(.01)
        assert not task.done()
    finally:
        release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert len(created) == 1 and created[0]._closed
    assert created[0].stats()["entries"] == 0
    if kind == "preview":
        assert not owner._items
        await owner.shutdown()
