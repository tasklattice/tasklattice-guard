"""Opt-in model Policy compilation/runtime with synthetic HTTP contract responses.

These tests prove model wiring, original-text ordering and failure behavior;
they do not measure real classifier quality or count as model validation.
"""
from __future__ import annotations

import json

import httpx
import pytest

from runner import generated as protocol
from runner.compiler import DefaultRunnerCompiler
from runner.draft_preview import DraftPreviewRuntime
from runner.providers import dynamic_runtime_action_providers
from runner.toolkit.compiler.domain import PlanCompilationError
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext
from tests.model_policy_fixture import model_enabled_guardrail


@pytest.fixture(scope="module")
def model_default_plan():
    return model_enabled_guardrail()["plan"]


def configuration(omit=None):
    safety = "tali.qwen3guard.v1"
    jailbreak = "tali.nemoguard-jailbreak-detect.v1"
    return protocol.DataPlaneModelConfiguration(
        revision_id="synthetic-default-models", revision=1,
        runtimes=[protocol.ModelRuntime(id=id, model=id, profile_ref=profile,
            base_url=f"https://{id}.test/v1", credential_ref="synthetic",
            timeout_seconds=2, max_tokens=128)
            for id, profile in (("safety", safety), ("jailbreak", jailbreak))],
        bindings=[protocol.CapabilityBinding(binding_id=f"{capability}.{phase}",
            capability_ref=capability, rail_type=protocol.RAIL_TYPE_INPUT if phase == "input" else protocol.RAIL_TYPE_OUTPUT,
            model_ref=model, profile_ref=profile, contract_refs=[contract])
            for capability, phase, model, profile, contract in (
                ("jailbreak", "input", "jailbreak", jailbreak, "tali.guard.jailbreak.v1"),
                ("content_safety", "input", "safety", safety, "tali.guard.content-safety.v1"),
                ("content_safety", "output", "safety", safety, "tali.guard.content-safety.v1"),
            ) if f"{capability}.{phase}" != omit],
    )


def runtime_and_identity(plan, handler, omit=None):
    providers = dynamic_runtime_action_providers(configuration(omit), {"synthetic": "contract-test-only"},
                                                 transport=httpx.MockTransport(handler))
    runtime = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(*providers))
    identity = dict(preview_id="model-default", guardrail_id=plan["guardrail_id"], draft_revision=1,
                    candidate_version=plan["guardrail_version"], plan=plan, runtime_profile="auto")
    return runtime, identity


def safety_reply(unsafe=False):
    return httpx.Response(200, json={"choices": [{"message": {"content":
        "Safety: Unsafe\nCategories: Violent" if unsafe else "Safety: Safe\nCategories: None"}}]})


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["input", "output"])
async def test_models_see_original_content_before_local_redaction(model_default_plan, phase):
    calls = []
    text = "Passport: E12345678"
    history = ({"role": "user", "content": "Please check this document."},)

    def respond(request):
        body = json.loads(request.content)
        calls.append((request.url.host, body))
        if request.url.host == "jailbreak.test":
            assert body == {"input": text}
            return httpx.Response(200, json={"jailbreak": False, "score": -0.9})
        assert body["messages"][-1] == {"role": "user" if phase == "input" else "assistant", "content": text}
        assert all("REDACTED" not in message["content"] for message in body["messages"])
        assert history[0] in body["messages"]
        return safety_reply()

    runtime, identity = runtime_and_identity(model_default_plan, respond)
    try:
        result = await runtime.evaluate(ProtectionRequest(phase=phase, texts=(text,), messages=history,
            context=RequestContext(protocol="playground")), **identity)
        assert result.decision == "transform", result.reason
        assert result.texts == ("Passport: [passport_china_REDACTED]",)
        assert [host for host, _ in calls] == (["jailbreak.test", "safety.test"] if phase == "input" else ["safety.test"])
        assert result.usage.model_invocations == len(calls)
        assert not result.usage.fail_closed
    finally:
        await runtime.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize("phase,blocking_model", [("input", "jailbreak"), ("input", "safety"), ("output", "safety")])
async def test_model_blocks_are_attributed_to_default_policy(model_default_plan, phase, blocking_model):
    calls = []

    def respond(request):
        calls.append(request.url.host)
        if request.url.host == "jailbreak.test":
            unsafe = blocking_model == "jailbreak"
            return httpx.Response(200, json={"jailbreak": unsafe, "score": 0.9 if unsafe else -0.9})
        return safety_reply(unsafe=True)

    runtime, identity = runtime_and_identity(model_default_plan, respond)
    try:
        result = await runtime.evaluate(ProtectionRequest(phase=phase, texts=("A synthetic contract test.",),
            context=RequestContext(protocol="playground")), **identity)
        assert result.decision == "block", result.reason
        policy = "builtin-jailbreak" if blocking_model == "jailbreak" else "builtin-content-safety"
        assert any(f.policy_id == policy and f.recommended_action == "block" for f in result.findings)
        assert result.usage.model_invocations == len(calls)
        assert not result.usage.fail_closed
        action_policies = {t.policy_id for t in result.trace if t.kind == "action" and t.policy_id is not None}
        # Cheap local Block checks precede the independent model checks; no
        # mutating PII check can execute after a model veto.
        transforms = {dict(step["parameters"]).get("policy_id") for step in model_default_plan["steps"]
                      if step["on_unsafe"] == "transform"}
        assert not (action_policies & transforms)
    finally:
        await runtime.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize("missing", ["jailbreak.input", "content_safety.input", "content_safety.output"])
async def test_opt_in_models_cannot_prepare_without_each_required_binding(model_default_plan, missing):
    runtime, identity = runtime_and_identity(model_default_plan,
        lambda _: pytest.fail("No inference before all model bindings are ready"), omit=missing)
    try:
        with pytest.raises(PlanCompilationError, match="Evaluator Binding") as error:
            await runtime.prepare(**identity)
        assert f"Required platform assignments: {missing}." in str(error.value)
        assert "apply the assignments to the Runner" in str(error.value)
    finally:
        await runtime.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize("phase,failed_model", [("input", "jailbreak"), ("input", "safety"), ("output", "safety")])
@pytest.mark.parametrize("failure", ["unavailable", "malformed"])
async def test_opt_in_models_fail_closed_when_required_model_fails(model_default_plan, phase, failed_model, failure):
    calls = []

    def respond(request):
        calls.append(request.url.host)
        if request.url.host == f"{failed_model}.test":
            return httpx.Response(503) if failure == "unavailable" else httpx.Response(200, json={"invalid": True})
        return httpx.Response(200, json={"jailbreak": False, "score": -0.9})

    runtime, identity = runtime_and_identity(model_default_plan, respond)
    try:
        result = await runtime.evaluate(ProtectionRequest(phase=phase, texts=("Have a pleasant day.",),
            context=RequestContext(protocol="playground")), **identity)
        assert result.decision == "block"
        assert result.usage.fail_closed
        assert result.usage.model_invocations == len(calls)
        assert any(t.error_type or t.status in {"error", "failed"} for t in result.trace)
    finally:
        await runtime.shutdown()


@pytest.mark.asyncio
async def test_public_evaluator_counts_real_model_calls_but_separates_provider_failures(model_default_plan, tmp_path):
    from scripts.evaluate_default_public import CURRENT_CASE_ID, Case, evaluate_cases, summarize

    def respond(request):
        assert CURRENT_CASE_ID.get() in {"model block", "provider failure"}
        if request.url.host == "jailbreak.test":
            if "failure" in json.loads(request.content)["input"]:
                return httpx.Response(503)
            return httpx.Response(200, json={"jailbreak": False, "score": -0.9})
        return safety_reply(unsafe=True)

    providers = dynamic_runtime_action_providers(configuration(), {"synthetic": "contract-test-only"},
                                                 transport=httpx.MockTransport(respond))
    cases = [Case(id=id, source="contract_test", split="synthetic", phase="input", text=id,
        label="synthetic", categories=(), expected="block_reference", mapping_reason="wiring only")
        for id in ("model block", "provider failure")]
    rows = await evaluate_cases(cases, model_default_plan, tmp_path, 1, providers=providers)
    assert [(row["status"], row["decision"], row["model_invocations"]) for row in rows] == [
        ("complete", "block", 2), ("execution_error", "block", 2)]
    summary = summarize(rows)
    assert summary["model_invocations"] == 4
    assert summary["blocked_reference"] == 1
    assert summary["execution_errors"] == 1
    assert CURRENT_CASE_ID.get() is None


@pytest.mark.asyncio
async def test_public_evaluator_stop_leaves_unsubmitted_cases_unscored(model_default_plan, tmp_path):
    import asyncio
    from scripts.evaluate_default_public import Case, evaluate_cases

    providers = dynamic_runtime_action_providers(configuration(), {"synthetic": "contract-test-only"},
        transport=httpx.MockTransport(lambda _: pytest.fail("Stopped cases must not invoke a model")))
    stop = asyncio.Event()
    stop.set()
    case = Case("not-submitted", "contract_test", "synthetic", "input", "Hello", "safe", (), "preserve", "wiring only")
    assert await evaluate_cases([case], model_default_plan, tmp_path, 1, providers=providers, stop_event=stop) == []
    assert (tmp_path / "results.jsonl").read_text() == ""


@pytest.mark.asyncio
async def test_public_evaluator_excludes_unknown_category_blocks_from_quality(model_default_plan, tmp_path):
    from scripts.evaluate_default_public import Case, evaluate_cases, summarize

    def respond(request):
        if request.url.host == "jailbreak.test":
            return httpx.Response(200, json={"jailbreak": False, "score": -0.9})
        return httpx.Response(200, json={"choices": [{"message": {"content":
            "Safety: Unsafe\nCategories: Unmapped review boundary"}}]})

    providers = dynamic_runtime_action_providers(configuration(), {"synthetic": "contract-test-only"},
                                                 transport=httpx.MockTransport(respond))
    case = Case("unmapped", "contract_test", "synthetic", "input", "Synthetic target", "synthetic", (), "block_reference", "wiring only")
    results = await evaluate_cases([case], model_default_plan, tmp_path, 1, providers=providers)
    assert results[0]["decision"] == "block"
    assert results[0]["fail_closed"] is False
    assert results[0]["status"] == "indeterminate"
    summary = summarize(results)
    assert summary["blocked_reference"] == summary["execution_errors"] == 0
    assert summary["indeterminate"] == 1
