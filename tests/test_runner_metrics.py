from __future__ import annotations

import time
from types import SimpleNamespace

import pytest

from nemoguardrails.types import LLMResponse, UsageInfo
from prometheus_client import generate_latest

from runner.metrics import INTERNAL_METRIC_ID, RunnerMetrics
from runner.toolkit.nemo.actions.contracts import ActionResult, ActionUsage, ModelCallUsage
from runner.toolkit.nemo.actions.model_call import (
    ObservedNeMoModel,
    activate_native_model_observation,
    deactivate_native_model_observation,
)
from runner.toolkit.nemo.runtime import _model_wait_wall_ms, _provider_work_ms
from runner.toolkit.runtime.contracts import (
    AppliedIntervention,
    DecisionFragment,
    ModuleAssessment,
    ProtectionDecision,
    RiskFinding,
    RuntimeCoverage,
    RuntimeTraceStep,
    RuntimeUsage,
)


def test_guardrail_business_metrics_cover_allow_deny_transform_and_failure_modes():
    metrics = RunnerMetrics(8)
    coverage = RuntimeCoverage(
        status="complete", guarded_items=1, total_items=1,
        guarded_characters=5, total_characters=5,
        required_modules_completed=2, required_modules_total=2,
    )
    allow = ProtectionDecision(
        decision="allow", action="pass", guardrail_id="guardrail-1",
        guardrail_version="20260904-020000.002Z", deployment_id="deployment-1",
        # The runtime/route identity is deliberately different. Metrics must
        # retain the authenticated entrypoint identity supplied below.
        integration_id="route-derived-must-not-win", coverage=coverage,
    )
    deny = ProtectionDecision(
        decision="block", action="reject", guardrail_id="guardrail-1",
        guardrail_version="20260904-020000.002Z", deployment_id="deployment-1",
        coverage=coverage, usage=RuntimeUsage(fail_closed=True, queue_latency_ms=5),
    )
    transform = ProtectionDecision(
        decision="transform", action="redact", guardrail_id="guardrail-1",
        guardrail_version="20260904-020000.002Z", deployment_id="deployment-1",
        mode="detect",
        interventions=(AppliedIntervention(
            kind="redact", module_id="secrets", fragment_id="fragment-1",
        ),),
        coverage=RuntimeCoverage(
            status="partial", guarded_items=1, total_items=2,
            guarded_characters=5, total_characters=10,
            required_modules_completed=1, required_modules_total=2,
        ),
        usage=RuntimeUsage(queue_latency_ms=5, provider_latency_ms=11),
        trace=(RuntimeTraceStep(
            id="runtime-1", kind="runtime", name="runtime", status="complete",
            duration_ms=7, detail="completed", route="fail_open",
        ),),
    )

    for decision in (allow, deny, transform):
        with metrics.request(
            "runtime", "http", "input", integration_id="integration-authenticated",
        ) as observation:
            observation.complete(decision)

    rendered = generate_latest(metrics.registry).decode()
    assert 'coverage="complete",disposition="allow",enforcement_mode="enforce",failure_mode="normal",guardrail_id="guardrail-1",integration_id="integration-authenticated",phase="input",protocol="http",result="success",traffic_class="runtime"} 1.0' in rendered
    # A policy denial is a successful Guardrail execution, not a platform error.
    assert 'coverage="complete",disposition="deny",enforcement_mode="enforce",failure_mode="fail_closed",guardrail_id="guardrail-1",integration_id="integration-authenticated",phase="input",protocol="http",result="success",traffic_class="runtime"} 1.0' in rendered
    assert 'coverage="partial",disposition="transform",enforcement_mode="detect",failure_mode="fail_open",guardrail_id="guardrail-1",integration_id="integration-authenticated",phase="input",protocol="http",result="success",traffic_class="runtime"} 1.0' in rendered
    assert 'guard_runner_guardrail_interventions_total{action="reject",guardrail_id="guardrail-1",integration_id="integration-authenticated",phase="input",protocol="http"} 1.0' in rendered
    assert 'guard_runner_guardrail_interventions_total{action="redact",guardrail_id="guardrail-1",integration_id="integration-authenticated",phase="input",protocol="http"} 1.0' in rendered
    assert 'guard_runner_guardrail_request_duration_seconds_count{disposition="deny",guardrail_id="guardrail-1",integration_id="integration-authenticated",phase="input",protocol="http",result="success",traffic_class="runtime"} 1.0' in rendered
    assert 'guard_runner_guardrail_guarded_items_total{guardrail_id="guardrail-1",integration_id="integration-authenticated",phase="input",protocol="http"} 3.0' in rendered
    assert 'guard_runner_guardrail_stage_duration_seconds_count{guardrail_id="guardrail-1",integration_id="integration-authenticated",phase="input",protocol="http",result="success",stage="runtime"} 1.0' in rendered
    # Provider work is explicit external RPC work. It must not fall back to the
    # duration of local actions and therefore only the transform contributes.
    assert 'guard_runner_guardrail_provider_work_duration_seconds_count{guardrail_id="guardrail-1",integration_id="integration-authenticated",phase="input",protocol="http"} 1.0' in rendered
    assert 'guard_runner_guardrail_queue_wait_duration_seconds_count{guardrail_id="guardrail-1",integration_id="integration-authenticated",phase="input",protocol="http"} 2.0' in rendered
    assert 'deployment_id="' not in rendered
    assert 'guardrail_version="' not in rendered
    assert "route-derived-must-not-win" not in rendered
    assert "guard_runner_runtime_requests_total" not in rendered
    assert "guard_runner_inspections_total" not in rendered


def test_guardrail_request_errors_keep_resolved_identity_and_unmatched_is_stable():
    metrics = RunnerMetrics(8)

    with pytest.raises(RuntimeError):
        with metrics.request(
            "runtime", "a2a", "output", integration_id="integration-a2a",
        ) as observation:
            observation.resolve(SimpleNamespace(
                plan=SimpleNamespace(guardrail_id="guardrail-resolved", guardrail_version="20260904-070000.007Z"),
                deployment_id="deployment-resolved",
                integration_id="route-derived-must-not-win",
            ))
            raise RuntimeError("provider failed with request-specific details")

    with pytest.raises(TimeoutError):
        with metrics.request(
            "runtime", "http", "input", integration_id="integration-http",
        ) as observation:
            observation.set_identity(
                guardrail_id="guardrail-timeout",
                guardrail_version="20260904-030000.003Z",
                deployment_id="deployment-timeout",
            )
            raise TimeoutError("bounded runtime timeout")

    with metrics.request(
        "runtime", "http", "input", integration_id="integration-catch-all",
    ) as observation:
        observation.set_identity(
            guardrail_id="__unmatched__",
            guardrail_version="__unmatched__",
            deployment_id="__unmatched__",
        )
        observation.complete(ProtectionDecision(decision="block", action="reject"))

    rendered = generate_latest(metrics.registry).decode()
    assert 'coverage="unknown",disposition="unknown",enforcement_mode="enforce",failure_mode="normal",guardrail_id="guardrail-resolved",integration_id="integration-a2a",phase="output",protocol="a2a",result="error",traffic_class="runtime"} 1.0' in rendered
    assert 'coverage="unknown",disposition="unknown",enforcement_mode="enforce",failure_mode="normal",guardrail_id="guardrail-timeout",integration_id="integration-http",phase="input",protocol="http",result="timeout",traffic_class="runtime"} 1.0' in rendered
    assert 'coverage="unknown",disposition="deny",enforcement_mode="enforce",failure_mode="normal",guardrail_id="__unmatched__",integration_id="integration-catch-all",phase="input",protocol="http",result="success",traffic_class="runtime"} 1.0' in rendered
    assert "route-derived-must-not-win" not in rendered
    assert "provider failed with request-specific details" not in rendered


def test_scoped_technical_failures_are_bounded_and_keep_guardrail_identity():
    metrics = RunnerMetrics(8)

    with pytest.raises(TimeoutError):
        with metrics.request(
            "runtime", "http", "input", integration_id="integration-1",
        ) as observation:
            observation.set_identity(
                guardrail_id="guardrail-1", guardrail_version="20260904-040000.004Z",
                deployment_id="deployment-1",
            )
            observation.fail("provider", "timeout")
            raise TimeoutError("provider-specific secret must not become a label")

    rendered = generate_latest(metrics.registry).decode()
    assert (
        'guard_runner_guardrail_execution_failures_total{guardrail_id="guardrail-1",'
        'integration_id="integration-1",phase="input",protocol="http",'
        'reason_class="timeout",result="timeout",stage="provider"} 1.0'
    ) in rendered
    assert "provider-specific secret" not in rendered


def test_policy_and_protection_metrics_explain_module_risk_policy_and_failure():
    metrics = RunnerMetrics(8)
    finding = RiskFinding(
        risk="prompt_injection", taxonomy_id="TALI-MODEL-SECURITY-PROMPT-INJECTION",
        verdict="unsafe", confidence=0.99,
        evidence="bounded evidence", recommended_action="reject",
        policy_id="policy-injection",
    )
    coverage = RuntimeCoverage(
        status="partial", guarded_items=1, total_items=2,
        guarded_characters=4, total_characters=8,
        required_modules_completed=0, required_modules_total=1,
    )
    decision = ProtectionDecision(
        decision="block", action="reject", guardrail_id="guardrail-1",
        guardrail_version="20260904-010000.001Z", deployment_id="deployment-1",
        findings=(finding,),
        assessments=(ModuleAssessment(
            module_id="interaction-safety", module="interaction_safety",
            status="error", coverage=coverage,
            fragments=(DecisionFragment(
                id="fragment-1", module_id="interaction-safety",
                module="interaction_safety", status="intervene",
                action="reject", findings=(finding,),
            ),),
        ),),
        trace=(RuntimeTraceStep(
            id="step-1", kind="action", name="PromptInjectionAction",
            status="timeout", detail="deadline exceeded", timed_out=True,
            module_id="interaction-safety", policy_id="policy-injection",
            action_name="PromptInjectionAction", route="fail_closed",
            capability="prompt_injection",
            contract_ref="tali.guard.prompt-injection.v1",
            verdict="error", model_result="timeout",
        ),),
        coverage=coverage,
    )

    with metrics.request(
        "runtime", "http", "input", integration_id="integration-1",
    ) as observation:
        observation.complete(decision)

    rendered = generate_latest(metrics.registry).decode()
    assert (
        'guard_runner_guardrail_policy_triggers_total{action="reject",'
        'disposition="deny",guardrail_id="guardrail-1",'
        'integration_id="integration-1",module_id="interaction-safety",'
        'phase="input",policy_id="policy-injection",protocol="http",'
        'risk="prompt_injection",verdict="unsafe"} 1.0'
    ) in rendered
    assert (
        'guard_runner_guardrail_protection_failures_total{action="PromptInjectionAction",'
        'failure_mode="fail_closed",guardrail_id="guardrail-1",'
        'integration_id="integration-1",module_id="interaction-safety",'
        'phase="input",policy_id="policy-injection",protocol="http",'
        'reason_class="timeout",stage="action"} 1.0'
    ) in rendered
    assert 'guard_runner_guardrail_incomplete_coverage_total{' in rendered
    assert 'module_id="interaction-safety"' in rendered


def test_non_integration_requests_use_a_bounded_internal_identity():
    metrics = RunnerMetrics(8)

    with metrics.request("controller", "playground", "input") as observation:
        observation.complete(ProtectionDecision(
            decision="allow",
            action="pass",
            guardrail_id="guardrail-internal",
            guardrail_version="20260904-010000.001Z",
            deployment_id="deployment-internal",
            integration_id="decision-derived-must-not-win",
        ))

    rendered = generate_latest(metrics.registry).decode()
    assert f'integration_id="{INTERNAL_METRIC_ID}"' in rendered
    assert "decision-derived-must-not-win" not in rendered


def test_heartbeat_uses_its_actual_window_and_real_admission_queue():
    metrics = RunnerMetrics(8)
    metrics.set_admission_load_provider(lambda: (3, 4, 16))
    metrics._window.started = time.monotonic() - 2  # noqa: SLF001 - metric-window contract
    metrics._window.requests = 2  # noqa: SLF001
    metrics._window.errors = 1  # noqa: SLF001
    metrics._window.latencies_ms.extend([10, 100])  # noqa: SLF001

    first = metrics.heartbeat()
    second = metrics.heartbeat()

    assert first.requests_delta == 2
    assert first.errors_delta == 1
    assert first.latency_p95_ms == 100
    assert 1_900 <= first.observation_interval_ms <= 2_100
    assert first.queue_depth == 4
    assert first.inflight == 3
    assert first.max_concurrency == 16
    assert second.requests_delta == 0
    assert second.latency_p95_ms == 0


def test_rejected_authentication_is_visible_without_being_an_inspection():
    metrics = RunnerMetrics(8)
    metrics.observe_authentication("litellm", False)
    metrics.reject_request("litellm", "input", "authentication_rejected")

    rendered = generate_latest(metrics.registry).decode()
    assert 'guard_runner_authentication_total{protocol="litellm",result="rejected"} 1.0' in rendered
    assert 'guard_runner_request_rejections_total{phase="input",protocol="litellm",reason="authentication_rejected"} 1.0' in rendered
    assert "guard_runner_guardrail_requests_total{" not in rendered


def test_parallel_model_work_is_not_misreported_as_wall_wait():
    calls = (
        ModelCallUsage(
            provider="nvidia", model="judge-a", operation="classify",
            result="success", duration_ms=3_000,
            started_offset_ms=100, finished_offset_ms=3_100,
        ),
        ModelCallUsage(
            provider="nvidia", model="judge-b", operation="classify",
            result="success", duration_ms=3_000,
            started_offset_ms=100, finished_offset_ms=3_100,
        ),
    )
    results = (
        SimpleNamespace(
            result=ActionResult(
                "safe", "content", usage=ActionUsage(model_calls=(calls[0],)),
            ),
            provider_latency_ms=3_000,
        ),
        SimpleNamespace(
            result=ActionResult(
                "safe", "content", usage=ActionUsage(model_calls=(calls[1],)),
            ),
            provider_latency_ms=3_000,
        ),
    )

    assert _provider_work_ms(results) == 6_000
    assert _model_wait_wall_ms(results) == 3_000


def test_model_call_metrics_keep_provider_outcome_and_retry_evidence():
    metrics = RunnerMetrics(8)
    labels = {
        "guardrail_id": "guardrail-1",
        "integration_id": "integration-1",
        "phase": "input",
        "action": "topic_judge",
        "provider": "nvidia",
        "model": "topic-control",
        "operation": "topic_classification",
    }
    metrics.model_call_started(**labels)
    metrics.model_call_finished(
        usage=ModelCallUsage(
            provider="nvidia",
            model="topic-control",
            operation="topic_classification",
            result="timeout",
            error_type="action_deadline",
            duration_ms=4_800,
            retries=2,
            backoff_ms=750,
            input_tokens=120,
            output_tokens=8,
        ),
        **labels,
    )

    rendered = generate_latest(metrics.registry).decode()
    assert 'error_type="action_deadline",guardrail_id="guardrail-1",integration_id="integration-1",model="topic-control",operation="topic_classification",phase="input",provider="nvidia",result="timeout"} 1.0' in rendered
    assert 'guard_runner_model_call_duration_seconds_count{action="topic_judge",guardrail_id="guardrail-1"' in rendered
    duration_series = next(
        line for line in rendered.splitlines()
        if line.startswith("guard_runner_model_call_duration_seconds_count{")
    )
    assert "error_type=" not in duration_series
    assert "operation=" not in duration_series
    assert 'guard_runner_model_retries_total{action="topic_judge",guardrail_id="guardrail-1",integration_id="integration-1",model="topic-control",phase="input",provider="nvidia",reason="action_deadline"} 2.0' in rendered
    assert 'guard_runner_model_in_flight{action="topic_judge",guardrail_id="guardrail-1",integration_id="integration-1",model="topic-control",phase="input",provider="nvidia"} 0.0' in rendered


@pytest.mark.asyncio
async def test_nemo_native_model_calls_use_the_same_scoped_metrics_and_wall_time():
    class NativeModel:
        model_name = "content-safety-model"
        provider_name = "nvidia"
        provider_url = "https://provider.invalid"

        async def generate_async(self, _prompt, *, stop=None, **_kwargs):
            return LLMResponse(
                content="safe",
                usage=UsageInfo(input_tokens=40, output_tokens=2, total_tokens=42),
            )

    metrics = RunnerMetrics(8)
    scope, token = activate_native_model_observation(
        guardrail_id="guardrail-native",
        integration_id="integration-native",
        phase="input",
        request_started_at=time.perf_counter(),
        observer=metrics,
    )
    try:
        response = await ObservedNeMoModel(
            NativeModel(), "content_safety",
        ).generate_async("content")
    finally:
        deactivate_native_model_observation(token)

    assert response.content == "safe"
    assert len(scope.calls) == 1
    assert scope.calls[0].operation == "content_safety_input"
    assert scope.calls[0].input_tokens == 40
    assert _provider_work_ms((), tuple(scope.calls)) == scope.calls[0].duration_ms
    assert _model_wait_wall_ms((), tuple(scope.calls)) == scope.calls[0].duration_ms
    rendered = generate_latest(metrics.registry).decode()
    assert 'guard_runner_model_calls_total{action="nemo_content_safety",error_type="none",guardrail_id="guardrail-native",integration_id="integration-native",model="content-safety-model",operation="content_safety_input",phase="input",provider="nvidia",result="success"} 1.0' in rendered
    assert 'guard_runner_model_tokens_total{action="nemo_content_safety",direction="input",guardrail_id="guardrail-native",integration_id="integration-native",model="content-safety-model",phase="input",provider="nvidia"} 40.0' in rendered
