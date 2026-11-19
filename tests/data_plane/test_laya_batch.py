import asyncio
from contextvars import ContextVar
import json
import threading
import time
from types import SimpleNamespace

import pytest

from runner.builtin_laya import BuiltinLaya, BuiltinLayaBusyError, BuiltinLayaInferenceError
from runner import laya_native_batch
from runner.laya_batch import laya_batch_scope, MAX_BATCH_CALLS, MAX_BATCH_QUESTIONS
from runner.model_validation_diagnostics import ValidationDiagnostics, capture_validation_case


def payload(item):
    return {"model": "synthetic-laya", "answers": {key: {"type": "noul", "noul": .01}
        for key in item.questions}, "usage": {"input_tokens": len(item.questions) * 10, "output_tokens": 0}}


@pytest.fixture
async def engine(tmp_path, monkeypatch):
    from runner.laya_batch import LayaInput
    single, batches = [], []

    def one(state, questions, **options):
        single.append((state, questions))
        return payload(LayaInput(state, questions, options["max_len"], options["head_max_len"]))

    def many(agent, items):
        batches.append(items)
        return [payload(item) for item in items]

    monkeypatch.setattr(laya_native_batch, "predict_native_batch", many)
    model = BuiltinLaya(tmp_path)
    monkeypatch.setattr(model, "_load", lambda: ("a" * 40, SimpleNamespace(system_one=one)))
    await model.start()
    try:
        yield model, single, batches
    finally:
        await model.close()


async def predict(model, state, keys=("risk",), *, seconds=2, max_len=1024):
    return await model.predict(state, {key: {"type": "noul", "instructions": f"Check {key}."} for key in keys},
        max_len=max_len, head_max_len=512, deadline=time.monotonic() + seconds)


async def test_batches_distinct_states_and_duplicate_question_ids_without_rewriting_them(engine):
    model, single, batches = engine
    states = ["same text", {"request": "same text", "topic": "support"},
              {"current_input": "same text", "context_messages": []}]
    with laya_batch_scope():
        results = await asyncio.gather(*(predict(model, state) for state in states))
    assert not single and len(batches) == 1
    assert [item.state for item in batches[0]] == states
    assert all(set(result["answers"]) == {"risk"} for result in results)
    assert model._pending == 0


async def test_without_an_execution_group_simultaneous_calls_stay_independent(engine):
    model, single, batches = engine
    await asyncio.gather(predict(model, "first request"), predict(model, "second request"))
    assert len(single) == 2 and not batches


async def test_separate_requests_and_content_versions_do_not_share_batches(engine):
    model, _single, batches = engine
    async def group(label):
        with laya_batch_scope():
            return await asyncio.gather(predict(model, label + ":a"), predict(model, label + ":b"))
    await asyncio.gather(group("request-a"), group("request-b"))
    await group("transformed")
    assert [{item.state for item in batch} for batch in batches] == [
        {"request-a:a", "request-a:b"}, {"request-b:a", "request-b:b"}, {"transformed:a", "transformed:b"}]


async def test_incompatible_budgets_and_large_groups_are_split(engine):
    model, _single, batches = engine
    with laya_batch_scope():
        await asyncio.gather(*(predict(model, str(index), keys=("a", "b", "c", "d")) for index in range(11)),
                             predict(model, "other budget", max_len=512))
    assert len(batches) == 4
    assert all(len(batch) <= MAX_BATCH_CALLS and sum(len(item.questions) for item in batch) <= MAX_BATCH_QUESTIONS
               for batch in batches)
    assert {item.max_len for item in batches[-1]} == {512}


async def test_one_members_deadline_does_not_cancel_a_longer_member(engine, monkeypatch):
    model, _single, batches = engine
    original = laya_native_batch.predict_native_batch
    def slow(agent, items):
        time.sleep(.04)
        return original(agent, items)
    monkeypatch.setattr(laya_native_batch, "predict_native_batch", slow)
    with laya_batch_scope():
        results = await asyncio.gather(predict(model, "short", seconds=.01), predict(model, "long"), return_exceptions=True)
    assert isinstance(results[0], TimeoutError) and results[1]["answers"]["risk"]["noul"] == .01
    assert len(batches) == 1 and model._pending == 0


async def test_per_member_queue_observation_uses_its_original_context(engine, monkeypatch):
    from runner.toolkit.nemo.actions import model_call
    model, _single, _batches = engine
    label = ContextVar("batch-test-label", default="missing")
    observations = []
    monkeypatch.setattr(model_call, "record_model_queue", lambda ms, sent: observations.append((label.get(), sent)))
    async def run(value):
        label.set(value)
        return await predict(model, value)
    with laya_batch_scope():
        await asyncio.gather(run("a"), run("b"))
    assert observations == [("a", True), ("b", True)]


async def test_encoding_error_is_isolated_and_each_diagnostic_keeps_its_own_input(engine, monkeypatch):
    model, _single, _batches = engine
    monkeypatch.setattr(laya_native_batch, "predict_native_batch", lambda agent, items:
        [ValueError("synthetic bad row") if item.state == "bad" else payload(item) for item in items])
    session = ValidationDiagnostics({}, ())
    with capture_validation_case(enabled=True, secrets=(), session=session):
        with laya_batch_scope():
            results = await asyncio.gather(predict(model, "good"), predict(model, "bad"), return_exceptions=True)
    assert results[0]["answers"] and isinstance(results[1], BuiltinLayaInferenceError)
    good, bad = session.local_evidence()["local_model_calls"]
    assert good["input"]["state"] == "good" and good["output"]["answers"]
    assert bad["input"]["state"] == "bad" and bad["error"]["type"] == "ValueError"


async def test_shared_forward_failure_finishes_every_member_and_releases_capacity(engine, monkeypatch):
    model, _single, _batches = engine
    original = laya_native_batch.predict_native_batch
    def failed(agent, items):
        raise RuntimeError("synthetic CPU failure")
    monkeypatch.setattr(laya_native_batch, "predict_native_batch", failed)
    with laya_batch_scope():
        results = await asyncio.gather(predict(model, "a"), predict(model, "b"), return_exceptions=True)
    assert all(isinstance(result, BuiltinLayaInferenceError) for result in results)
    assert model._pending == 0
    monkeypatch.setattr(laya_native_batch, "predict_native_batch", original)
    with laya_batch_scope():
        recovered = await asyncio.gather(predict(model, "c"), predict(model, "d"))
    assert all(result["answers"] for result in recovered)


async def test_partial_admission_keeps_the_first_admissible_check_instead_of_rejecting_the_group(engine):
    model, _single, batches = engine
    model._capacity = 1
    with laya_batch_scope():
        results = await asyncio.gather(*(predict(model, value) for value in ("first", "second", "third")),
                                       return_exceptions=True)
    assert results[0]["answers"]
    assert all(isinstance(result, BuiltinLayaBusyError) for result in results[1:])
    assert len(batches) == 1 and [item.state for item in batches[0]] == ["first"]
    assert model._pending == 0


async def test_cancellation_keeps_the_shared_cpu_permit_until_forward_finishes(engine, monkeypatch):
    model, _single, _batches = engine
    entered, release = threading.Event(), threading.Event()
    def slow(agent, items):
        entered.set()
        assert release.wait(5)
        return [payload(item) for item in items]
    monkeypatch.setattr(laya_native_batch, "predict_native_batch", slow)
    model._capacity = 2
    try:
        with laya_batch_scope():
            first = asyncio.create_task(predict(model, "first"))
            second = asyncio.create_task(predict(model, "second"))
            assert await asyncio.to_thread(entered.wait, 2)
            first.cancel()
            with pytest.raises(asyncio.CancelledError):
                await first
            assert model._pending == 2
            with pytest.raises(BuiltinLayaBusyError):
                # This call is isolated from the batch context in a new scope.
                with laya_batch_scope():
                    await predict(model, "queue full")
            assert not second.done()
            release.set()
            assert (await second)["answers"]
        assert model._pending == 0
    finally:
        release.set()


async def test_cancelled_queued_batch_does_not_start_a_forward(engine, monkeypatch):
    model, single, batches = engine
    entered, release = threading.Event(), threading.Event()
    one = model._agent.system_one
    def busy(*args, **options):
        entered.set()
        assert release.wait(5)
        return one(*args, **options)
    model._agent.system_one = busy
    running = asyncio.create_task(predict(model, "already running"))
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        with laya_batch_scope():
            tasks = [asyncio.create_task(predict(model, text)) for text in ("queued a", "queued b")]
            for _ in range(100):
                if model._pending == 3:
                    break
                await asyncio.sleep(.001)
            assert model._pending == 3
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        await asyncio.sleep(0)
        assert model._pending == 1 and not batches
        release.set()
        await running
        assert len(single) == 1 and model._pending == 0
    finally:
        release.set()
        await asyncio.gather(running, return_exceptions=True)


def test_public_batch_identity_excludes_free_form_payloads():
    from runner.evaluation_evidence import builtin_laya_identity
    metadata = {"backend": "builtin_laya", "inference_batch": {
        "id": "b" * 32, "size": 3, "index": 1, "question_count": 8, "state": "never expose"}}
    assert builtin_laya_identity({"model_metadata": metadata})["inferenceBatch"] == {
        "id": "b" * 32, "size": 3, "index": 1, "question_count": 8}
    metadata["inference_batch"]["size"] = True
    assert "inferenceBatch" not in builtin_laya_identity({"model_metadata": metadata})


@pytest.mark.parametrize("batched,individual,verdict", [(.2001, .1999, "not_matched"), (.7999, .8001, "matched")])
async def test_near_threshold_member_is_rechecked_with_its_own_thresholds(engine, monkeypatch, batched, individual, verdict):
    from runner.toolkit.nemo.evaluators.laya_jailbreak import LayaJailbreakEvaluator
    from scripts.evaluate_laya import evaluation_request
    model, _single, _batches = engine
    batch_id = "c" * 32
    def many(agent, items):
        return [{**payload(item), "answers": {key: {"type": "noul", "noul": batched} for key in item.questions},
            "inference_batch": {"id": batch_id, "size": len(items), "index": index,
                                "question_count": sum(len(i.questions) for i in items)}}
                for index, item in enumerate(items)]
    monkeypatch.setattr(laya_native_batch, "predict_native_batch", many)
    rechecks = []
    def one(state, questions, **options):
        rechecks.append(state)
        return {"model": "synthetic-laya", "answers": {key: {"type": "noul", "noul": individual} for key in questions},
                "usage": {"input_tokens": 10, "output_tokens": 0}}
    model._agent.system_one = one
    evaluator = LayaJailbreakEvaluator(base_url="", model="local", api_key="", builtin_laya=model,
                                      lower_threshold=.2, upper_threshold=.8)
    request = evaluation_request({"capability": "jailbreak", "content": "Check this input."})
    with laya_batch_scope():
        result, _peer = await asyncio.gather(evaluator.evaluate_primary(request), predict(model, "peer"))
    assert result.verdict == verdict
    assert rechecks == ["Check this input."]
    assert result.usage.model_invocations == 2
    assert len(result.usage.model_calls) == 2
    assert all(call.request_sent and call.result == "success" for call in result.usage.model_calls)
    assert json.loads(result.trace[0].evidence)["model_metadata"]["batch_threshold_rechecked"] is True


async def test_topic_coverage_trace_identifies_the_same_forward(engine, monkeypatch):
    from runner.toolkit.nemo.evaluators.laya_topic import LayaTopicEvaluator
    from scripts.evaluate_laya import evaluation_request
    model, _single, _batches = engine
    def many(agent, items):
        return [{**payload(item), "inference_batch": {"id": "f" * 32, "size": len(items), "index": index,
                    "question_count": sum(len(i.questions) for i in items)}} for index, item in enumerate(items)]
    monkeypatch.setattr(laya_native_batch, "predict_native_batch", many)
    evaluator = LayaTopicEvaluator(base_url="", model="local", api_key="", builtin_laya=model)
    request = evaluation_request({"capability": "topic_control", "content": "A request.",
        "parameters": {"topic_mode": "permissive", "restricted_topics": "alpha;beta"}})
    with laya_batch_scope():
        result, _peer = await asyncio.gather(evaluator.evaluate_primary(request), predict(model, "peer"))
    assert result.verdict == "unknown" and len(result.trace) == 2
    assert {json.loads(step.evidence)["model_metadata"]["inference_batch"]["id"] for step in result.trace} == {"f" * 32}
