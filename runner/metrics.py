from __future__ import annotations

import math
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterator

import psutil
from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode
from prometheus_client import (
    CollectorRegistry,
    Counter,
    Gauge,
    GCCollector,
    Histogram,
    PlatformCollector,
    ProcessCollector,
)

from runner.toolkit.runtime.contracts import PlanResolution, ProtectionDecision

from . import __version__
from . import generated as protocol
from .observability import current_exemplar, current_trace_id


_DURATION_BUCKETS = (
    0.001, 0.0025, 0.005, 0.0075, 0.01, 0.015, 0.025, 0.04, 0.05,
    0.075, 0.1, 0.15, 0.25, 0.4, 0.5, 0.75, 1, 1.5, 2.5, 5, 10, 30,
)
_QUEUE_BUCKETS = (
    0.0005, 0.001, 0.0025, 0.005, 0.0075, 0.01, 0.015, 0.025,
    0.04, 0.05, 0.075, 0.1, 0.15, 0.25, 0.5, 1, 2.5, 5, 10,
)
_KNOWN_STAGES = frozenset({"deployment", "module", "evaluator", "rail", "action", "runtime", "queue"})
_MODEL_SCOPE_LABELS = (
    "guardrail_id", "integration_id", "phase", "action", "provider", "model",
)
INTERNAL_METRIC_ID = "__internal__"
UNRESOLVED_METRIC_ID = "__unresolved__"
UNMATCHED_METRIC_ID = "__unmatched__"
_TRACER = trace.get_tracer("tasklattice.guard-runner.request")


@dataclass(slots=True)
class _Window:
    started: float = field(default_factory=time.monotonic)
    requests: int = 0
    errors: int = 0
    timeouts: int = 0
    latencies_ms: list[float] = field(default_factory=list)


@dataclass(slots=True)
class GuardrailRequestObservation:
    """Mutable metric scope populated as routing and evaluation make progress."""

    # This identity is fixed by the authenticated request entrypoint. Routing
    # and runtime decisions must never replace it with a route-derived value.
    integration_id: str = INTERNAL_METRIC_ID
    guardrail_id: str = UNRESOLVED_METRIC_ID
    guardrail_version: str = UNRESOLVED_METRIC_ID
    deployment_id: str = UNRESOLVED_METRIC_ID
    decision: ProtectionDecision | None = None
    failure_stage: str | None = None
    failure_reason_class: str | None = None

    def resolve(self, resolution: PlanResolution) -> None:
        self.set_identity(
            guardrail_id=resolution.plan.guardrail_id,
            guardrail_version=resolution.plan.guardrail_version,
            deployment_id=resolution.deployment_id,
        )

    def set_identity(
        self,
        *,
        guardrail_id: str | None,
        guardrail_version: int | str | None,
        deployment_id: str | None,
    ) -> None:
        self.guardrail_id = _identity_label(guardrail_id, self.guardrail_id)
        self.guardrail_version = _identity_label(guardrail_version, self.guardrail_version)
        self.deployment_id = _identity_label(deployment_id, self.deployment_id)

    def complete(self, decision: ProtectionDecision) -> None:
        self.decision = decision
        self.set_identity(
            guardrail_id=decision.guardrail_id,
            guardrail_version=decision.guardrail_version,
            deployment_id=decision.deployment_id,
        )

    def fail(self, stage: str, reason_class: str) -> None:
        # Preserve the first failure: a best-effort telemetry append must not
        # hide the runtime failure that caused the request to fail originally.
        if self.failure_stage is None:
            self.failure_stage = _bounded_failure_stage(stage)
            self.failure_reason_class = _bounded_failure_reason(reason_class)


class RunnerMetrics:
    """Low-cardinality operational metrics for the Guard data plane.

    Runtime execution result and firewall disposition are intentionally two
    separate metric families. A correctly returned block is a successful
    execution and a blocking disposition at the same time.
    """

    def __init__(self, max_concurrency: int) -> None:
        self._max_concurrency = max_concurrency
        self._lock = threading.Lock()
        self._window = _Window()
        self._inflight = 0
        self._inflight_by_class: dict[str, int] = {}
        self._active_jobs: dict[str, int] = {"compile": 0, "validation": 0}
        self._loaded_artifact_count = 0
        self._admission_load: Callable[[], tuple[int, int, int]] = lambda: (0, 0, max_concurrency)
        self._process = psutil.Process()
        self.registry = CollectorRegistry()
        ProcessCollector(registry=self.registry)
        PlatformCollector(registry=self.registry)
        GCCollector(registry=self.registry)

        self.build_info = Gauge(
            "guard_runner_build_info", "Static Runner build information.", ["version"],
            registry=self.registry,
        )
        self.build_info.labels(version=__version__).set(1)
        self.guardrail_requests = Counter(
            "guard_runner_guardrail_requests_total",
            "Guardrail executions by stable product identity, result, disposition, and protection state.",
            [
                "guardrail_id", "integration_id", "traffic_class", "protocol", "phase",
                "result", "disposition", "coverage",
                "enforcement_mode", "failure_mode",
            ],
            registry=self.registry,
        )
        self.guardrail_request_duration = Histogram(
            "guard_runner_guardrail_request_duration_seconds",
            "End-to-end Guardrail latency including durable telemetry append.",
            [
                "guardrail_id", "integration_id", "traffic_class", "protocol", "phase",
                "result", "disposition",
            ],
            buckets=_DURATION_BUCKETS,
            registry=self.registry,
        )
        self.guardrail_interventions = Counter(
            "guard_runner_guardrail_interventions_total",
            "Applied Guardrail interventions by bounded enforcement action.",
            [
                "guardrail_id", "integration_id", "protocol", "phase", "action",
            ],
            registry=self.registry,
        )
        self.request_rejections = Counter(
            "guard_runner_request_rejections_total",
            "Runtime requests rejected before Guard execution by bounded reason.",
            ["protocol", "phase", "reason"], registry=self.registry,
        )
        self.route_resolution = Counter(
            "guard_runner_route_resolution_total", "Integration traffic route resolution attempts.",
            ["protocol", "phase", "result"], registry=self.registry,
        )
        self.authentication = Counter(
            "guard_runner_authentication_total", "Runtime Integration authentication attempts.",
            ["protocol", "result"], registry=self.registry,
        )
        self.failures = Counter(
            "guard_runner_failures_total", "Runner failures classified by bounded stage and reason.",
            ["stage", "reason_class"], registry=self.registry,
        )
        self.guardrail_execution_failures = Counter(
            "guard_runner_guardrail_execution_failures_total",
            "Scoped technical Guardrail request failures by bounded stage, reason, and result.",
            [
                "guardrail_id", "integration_id", "protocol", "phase",
                "stage", "reason_class", "result",
            ],
            registry=self.registry,
        )
        self.stage_duration = Histogram(
            "guard_runner_guardrail_stage_duration_seconds", "Guardrail trace-stage duration.",
            [
                "guardrail_id", "integration_id", "protocol", "phase", "stage", "result",
            ],
            buckets=_DURATION_BUCKETS, registry=self.registry,
        )
        self.provider_work_duration = Histogram(
            "guard_runner_guardrail_provider_work_duration_seconds",
            "Sum of external provider RPC durations; parallel calls intentionally overlap.",
            ["guardrail_id", "integration_id", "protocol", "phase"],
            buckets=_DURATION_BUCKETS, registry=self.registry,
        )
        self.model_wait_duration = Histogram(
            "guard_runner_guardrail_model_wait_wall_duration_seconds",
            "Union wall time blocked on model RPCs within one Guardrail execution.",
            ["guardrail_id", "integration_id", "protocol", "phase"],
            buckets=_DURATION_BUCKETS, registry=self.registry,
        )
        self.model_calls = Counter(
            "guard_runner_model_calls_total",
            "External model/provider RPCs by stable product and provider outcome.",
            [*_MODEL_SCOPE_LABELS, "operation", "result", "error_type"],
            registry=self.registry,
        )
        self.model_in_flight = Gauge(
            "guard_runner_model_in_flight",
            "Currently executing external model/provider RPCs.",
            list(_MODEL_SCOPE_LABELS),
            registry=self.registry,
        )
        self.model_call_duration = Histogram(
            "guard_runner_model_call_duration_seconds",
            "Wall duration of one external model/provider RPC.",
            [*_MODEL_SCOPE_LABELS, "result"],
            buckets=_DURATION_BUCKETS,
            registry=self.registry,
        )
        self.model_time_to_first_token = Histogram(
            "guard_runner_model_time_to_first_token_seconds",
            "Time to first token for streaming model RPCs when available.",
            list(_MODEL_SCOPE_LABELS),
            buckets=_DURATION_BUCKETS,
            registry=self.registry,
        )
        self.model_retries = Counter(
            "guard_runner_model_retries_total",
            "Model RPC retries reported by the provider client.",
            [*_MODEL_SCOPE_LABELS, "reason"],
            registry=self.registry,
        )
        self.model_backoff_duration = Histogram(
            "guard_runner_model_backoff_duration_seconds",
            "Backoff wall time before model RPC retries.",
            [*_MODEL_SCOPE_LABELS, "reason"],
            buckets=_QUEUE_BUCKETS,
            registry=self.registry,
        )
        self.model_tokens = Counter(
            "guard_runner_model_tokens_total",
            "Model tokens reported by provider responses.",
            [*_MODEL_SCOPE_LABELS, "direction"],
            registry=self.registry,
        )
        self.protection_failures = Counter(
            "guard_runner_guardrail_protection_failures_total",
            "Failed or timed-out protection steps by bounded module and cause.",
            [
                "guardrail_id", "integration_id", "protocol", "phase", "module_id",
                "stage", "action", "policy_id", "failure_mode", "reason_class",
            ],
            registry=self.registry,
        )
        self.incomplete_coverage = Counter(
            "guard_runner_guardrail_incomplete_coverage_total",
            "Executions with partial or absent protection coverage by failed module and cause.",
            [
                "guardrail_id", "integration_id", "protocol", "phase", "coverage",
                "module_id", "stage", "action", "policy_id", "failure_mode", "reason_class",
            ],
            registry=self.registry,
        )
        self.policy_triggers = Counter(
            "guard_runner_guardrail_policy_triggers_total",
            "Unsafe, uncertain, or error findings that explain a Guardrail disposition.",
            [
                "guardrail_id", "integration_id", "protocol", "phase",
                "disposition", "module_id", "risk", "policy_id", "action", "verdict",
            ],
            registry=self.registry,
        )
        self.queue_duration = Histogram(
            "guard_runner_guardrail_queue_wait_duration_seconds",
            "Guardrail runtime admission wait reported for an execution.",
            ["guardrail_id", "integration_id", "protocol", "phase"],
            buckets=_QUEUE_BUCKETS, registry=self.registry,
        )
        self.inspected_items = Counter(
            "guard_runner_guardrail_inspected_items_total", "Content items presented to a Guardrail.",
            ["guardrail_id", "integration_id", "protocol", "phase"],
            registry=self.registry,
        )
        self.guarded_items = Counter(
            "guard_runner_guardrail_guarded_items_total", "Content items covered by a Guardrail.",
            ["guardrail_id", "integration_id", "protocol", "phase"],
            registry=self.registry,
        )
        self.inspected_characters = Counter(
            "guard_runner_guardrail_inspected_characters_total", "Text characters presented to a Guardrail.",
            ["guardrail_id", "integration_id", "protocol", "phase"],
            registry=self.registry,
        )
        self.guarded_characters = Counter(
            "guard_runner_guardrail_guarded_characters_total", "Text characters covered by a Guardrail.",
            ["guardrail_id", "integration_id", "protocol", "phase"],
            registry=self.registry,
        )
        self.required_modules = Counter(
            "guard_runner_guardrail_required_modules_total", "Required modules expected by a Guardrail.",
            ["guardrail_id", "integration_id", "protocol", "phase"],
            registry=self.registry,
        )
        self.completed_required_modules = Counter(
            "guard_runner_guardrail_completed_required_modules_total",
            "Required Guardrail modules completed.",
            ["guardrail_id", "integration_id", "protocol", "phase"],
            registry=self.registry,
        )

        self.inflight = Gauge(
            "guard_runner_requests_in_flight", "Currently executing Runner requests by traffic class.",
            ["traffic_class"], registry=self.registry,
        )
        self.admission_inflight = Gauge(
            "guard_runner_admission_in_flight", "Requests holding a Guardrail runtime admission slot.",
            registry=self.registry,
        )
        self.admission_queue = Gauge(
            "guard_runner_admission_queue_depth", "Requests waiting for a Guardrail runtime admission slot.",
            registry=self.registry,
        )
        self.admission_capacity = Gauge(
            "guard_runner_admission_capacity",
            "Aggregate admission slots across loaded Guardrail runtimes.",
            registry=self.registry,
        )
        self.admission_capacity.set(max_concurrency)
        self.max_concurrency = Gauge(
            "guard_runner_max_concurrency", "Configured maximum concurrency per Guardrail runtime.",
            registry=self.registry,
        )
        self.max_concurrency.set(max_concurrency)
        self.applied_generation = Gauge(
            "guard_runner_applied_generation", "Controller desired-state generation applied atomically by this Runner.",
            registry=self.registry,
        )
        self.desired_generation = Gauge(
            "guard_runner_desired_generation", "Latest Controller desired-state generation observed by this Runner.",
            registry=self.registry,
        )
        self.loaded_artifacts = Gauge(
            "guard_runner_loaded_artifacts", "Immutable Guardrail artifacts loaded by this Runner.",
            registry=self.registry,
        )
        self.configured_routes = Gauge(
            "guard_runner_configured_routes", "Deployment routes configured in this Runner.",
            registry=self.registry,
        )
        self.configured_integrations = Gauge(
            "guard_runner_configured_integrations", "Integration verifiers configured in this Runner.",
            registry=self.registry,
        )
        self.jobs_in_progress = Gauge(
            "guard_runner_jobs_in_progress", "Compiler or validation jobs currently executing.",
            ["kind"], registry=self.registry,
        )
        self.process_cpu = Gauge(
            "guard_runner_process_cpu_utilization_ratio",
            "Runner process CPU utilization where 1.0 represents one fully used core.",
            registry=self.registry,
        )
        self.process_memory = Gauge(
            "guard_runner_process_resident_memory_bytes", "Runner process resident memory in bytes.",
            registry=self.registry,
        )
        self.memory_limit_utilization = Gauge(
            "guard_runner_memory_limit_utilization_ratio",
            "Runner RSS divided by its cgroup memory limit, or host memory when no limit is visible.",
            registry=self.registry,
        )

        self.control_connected = Gauge(
            "guard_runner_control_connected", "Whether the Runner control stream is connected.",
            registry=self.registry,
        )
        self.desired_state_synchronized = Gauge(
            "guard_runner_desired_state_synchronized",
            "Whether a verified desired state or last-known-good state is available.",
            registry=self.registry,
        )
        self.control_reconnects = Counter(
            "guard_runner_control_reconnects_total", "Runner control stream reconnect attempts by reason.",
            ["reason_class"], registry=self.registry,
        )
        self.control_messages = Counter(
            "guard_runner_control_messages_total", "Runner control stream messages by direction, type, and result.",
            ["direction", "message_type", "result"], registry=self.registry,
        )
        self.control_outgoing_queue = Gauge(
            "guard_runner_control_outgoing_queue_depth",
            "Messages waiting for transmission on the Runner control stream.", registry=self.registry,
        )
        self.last_heartbeat_sent = Gauge(
            "guard_runner_last_heartbeat_sent_timestamp_seconds",
            "Unix timestamp of the most recent heartbeat queued for Controller.", registry=self.registry,
        )
        self.desired_state_apply = Counter(
            "guard_runner_desired_state_apply_total", "Desired-state application attempts.",
            ["result"], registry=self.registry,
        )
        self.desired_state_apply_duration = Histogram(
            "guard_runner_desired_state_apply_duration_seconds",
            "Desired-state verification, prewarm, and atomic application latency.",
            buckets=_DURATION_BUCKETS, registry=self.registry,
        )

        self.telemetry_wal_events = Gauge(
            "guard_runner_telemetry_wal_events", "Runtime events waiting in the local telemetry WAL.",
            registry=self.registry,
        )
        self.telemetry_wal_bytes = Gauge(
            "guard_runner_telemetry_wal_bytes", "Bytes currently used by the local telemetry WAL.",
            registry=self.registry,
        )
        self.telemetry_wal_oldest_age = Gauge(
            "guard_runner_telemetry_wal_oldest_event_age_seconds",
            "Age of the oldest Runtime event waiting in the telemetry WAL.", registry=self.registry,
        )
        self.telemetry_exports = Counter(
            "guard_runner_telemetry_export_batches_total", "Telemetry export operations by type and result.",
            ["operation", "result"], registry=self.registry,
        )
        self.telemetry_export_events = Counter(
            "guard_runner_telemetry_export_events_total",
            "Runtime events accepted or rejected by Controller telemetry export.",
            ["result"], registry=self.registry,
        )
        self.telemetry_export_duration = Histogram(
            "guard_runner_telemetry_export_duration_seconds", "Telemetry export request latency.",
            ["operation"], buckets=_DURATION_BUCKETS, registry=self.registry,
        )
        self.telemetry_last_success = Gauge(
            "guard_runner_telemetry_last_success_timestamp_seconds",
            "Unix timestamp of the most recent successful Controller telemetry operation.", registry=self.registry,
        )
        self.telemetry_write_failures = Counter(
            "guard_runner_telemetry_wal_write_failures_total", "Local telemetry WAL write failures.",
            ["operation"], registry=self.registry,
        )

    @contextmanager
    def request(
        self,
        traffic_class: str = "runtime",
        protocol_name: str = "unknown",
        phase: str = "unknown",
        *,
        integration_id: str | None = None,
        guardrail_id: str = UNRESOLVED_METRIC_ID,
        guardrail_version: int | str = UNRESOLVED_METRIC_ID,
        deployment_id: str = UNRESOLVED_METRIC_ID,
    ) -> Iterator[GuardrailRequestObservation]:
        started = time.perf_counter()
        observation = GuardrailRequestObservation(
            integration_id=_identity_label(integration_id, INTERNAL_METRIC_ID),
            guardrail_id=_identity_label(guardrail_id, UNRESOLVED_METRIC_ID),
            guardrail_version=_identity_label(guardrail_version, UNRESOLVED_METRIC_ID),
            deployment_id=_identity_label(deployment_id, UNRESOLVED_METRIC_ID),
        )
        with _TRACER.start_as_current_span(
            "guardrail.request",
            attributes={
                "guardrail.traffic_class": traffic_class,
                "guardrail.protocol": protocol_name,
                "guardrail.phase": phase,
                "integration.id": observation.integration_id,
            },
        ) as span:
            with self._lock:
                self._inflight += 1
                self._inflight_by_class[traffic_class] = self._inflight_by_class.get(traffic_class, 0) + 1
                self.inflight.labels(traffic_class=traffic_class).set(self._inflight_by_class[traffic_class])
            result = "success"
            try:
                yield observation
            except TimeoutError:
                result = "timeout"
                span.set_status(Status(StatusCode.ERROR, result))
                raise
            except Exception as error:
                result = "error"
                span.record_exception(error)
                span.set_status(Status(StatusCode.ERROR, result))
                raise
            finally:
                latency_seconds = time.perf_counter() - started
                latency_ms = latency_seconds * 1_000
                if result in {"error", "timeout"}:
                    failure_stage = _bounded_failure_stage(
                        observation.failure_stage or "runtime"
                    )
                    failure_reason = _bounded_failure_reason(
                        observation.failure_reason_class
                        or ("timeout" if result == "timeout" else "runtime_exception")
                    )
                    self.guardrail_execution_failures.labels(
                        guardrail_id=observation.guardrail_id,
                        integration_id=observation.integration_id,
                        protocol=protocol_name,
                        phase=phase,
                        stage=failure_stage,
                        reason_class=failure_reason,
                        result=result,
                    ).inc()
                    span.set_attribute("guardrail.failure.stage", failure_stage)
                    span.set_attribute("guardrail.failure.reason_class", failure_reason)
                with self._lock:
                    self._inflight = max(0, self._inflight - 1)
                    self._inflight_by_class[traffic_class] = max(0, self._inflight_by_class.get(traffic_class, 1) - 1)
                    self._window.requests += 1
                    self._window.errors += int(result == "error")
                    self._window.timeouts += int(result == "timeout")
                    self._window.latencies_ms.append(latency_ms)
                    self.inflight.labels(traffic_class=traffic_class).set(self._inflight_by_class[traffic_class])
                self._record_guardrail_request(
                    observation,
                    traffic_class=traffic_class,
                    protocol_name=protocol_name,
                    phase=phase,
                    result=result,
                    latency_seconds=latency_seconds,
                )
                span.set_attributes({
                    "guardrail.id": observation.guardrail_id,
                    "guardrail.version": observation.guardrail_version,
                    "guardrail.deployment.id": observation.deployment_id,
                    "guardrail.result": result,
                    "guardrail.duration_ms": latency_ms,
                    "guardrail.disposition": _disposition(observation.decision),
                    "guardrail.coverage": (
                        observation.decision.coverage.status
                        if observation.decision is not None
                        and observation.decision.coverage is not None
                        else "unknown"
                    ),
                    "guardrail.failure_mode": _failure_mode(observation.decision),
                })

    @staticmethod
    def current_trace_id() -> str | None:
        return current_trace_id()

    def _record_guardrail_request(
        self,
        observation: GuardrailRequestObservation,
        *,
        traffic_class: str,
        protocol_name: str,
        phase: str,
        result: str,
        latency_seconds: float,
    ) -> None:
        decision = observation.decision
        disposition = _disposition(decision)
        coverage = decision.coverage.status if decision is not None and decision.coverage is not None else "unknown"
        enforcement_mode = decision.mode if decision is not None else "enforce"
        failure_mode = _failure_mode(decision)
        identity = {
            "guardrail_id": observation.guardrail_id,
            "integration_id": observation.integration_id,
        }
        common = {
            **identity,
            "traffic_class": traffic_class,
            "protocol": protocol_name,
            "phase": phase,
            "result": result,
            "disposition": disposition,
        }
        self.guardrail_requests.labels(
            **common,
            coverage=coverage,
            enforcement_mode=enforcement_mode,
            failure_mode=failure_mode,
        ).inc()
        self.guardrail_request_duration.labels(**common).observe(
            max(0, latency_seconds), exemplar=current_exemplar(),
        )
        if decision is not None:
            self._record_policy_triggers(
                decision,
                identity=identity,
                protocol_name=protocol_name,
                phase=phase,
                disposition=disposition,
            )
            self._record_guardrail_decision(
                decision,
                identity=identity,
                protocol_name=protocol_name,
                phase=phase,
                disposition=disposition,
            )

    def _record_guardrail_decision(
        self,
        decision: ProtectionDecision,
        *,
        identity: dict[str, str],
        protocol_name: str,
        phase: str,
        disposition: str,
    ) -> None:
        detail_labels = {**identity, "protocol": protocol_name, "phase": phase}
        actions = [item.kind for item in decision.interventions]
        if not actions and disposition in {"deny", "transform"} and decision.action != "pass":
            actions.append(decision.action)
        for action in actions:
            self.guardrail_interventions.labels(**detail_labels, action=action).inc()

        if decision.coverage is not None:
            self.inspected_items.labels(**detail_labels).inc(max(0, decision.coverage.total_items))
            self.guarded_items.labels(**detail_labels).inc(max(0, decision.coverage.guarded_items))
            self.inspected_characters.labels(**detail_labels).inc(
                max(0, decision.coverage.total_characters),
            )
            self.guarded_characters.labels(**detail_labels).inc(
                max(0, decision.coverage.guarded_characters),
            )
            self.required_modules.labels(**detail_labels).inc(
                max(0, decision.coverage.required_modules_total),
            )
            self.completed_required_modules.labels(**detail_labels).inc(
                max(0, decision.coverage.required_modules_completed),
            )
        if decision.usage is not None:
            self.queue_duration.labels(**detail_labels).observe(
                max(0, decision.usage.queue_latency_ms) / 1_000,
                exemplar=current_exemplar(),
            )
            provider_work_ms = (
                decision.usage.provider_work_latency_ms
                or decision.usage.provider_latency_ms
            )
            if provider_work_ms > 0:
                self.provider_work_duration.labels(**detail_labels).observe(
                    provider_work_ms / 1_000,
                    exemplar=current_exemplar(),
                )
            if decision.usage.model_wait_latency_ms > 0:
                self.model_wait_duration.labels(**detail_labels).observe(
                    decision.usage.model_wait_latency_ms / 1_000,
                    exemplar=current_exemplar(),
                )
        failed_steps = []
        for step in decision.trace:
            stage = step.kind if step.kind in _KNOWN_STAGES else "other"
            stage_result = _bounded_result(step.status or step.outcome or step.verdict)
            self.stage_duration.labels(
                **detail_labels, stage=stage, result=stage_result,
            ).observe(
                max(0, step.duration_ms) / 1_000,
                exemplar=current_exemplar(),
            )
            if stage_result in {"error", "timeout"} or step.timed_out:
                failed_steps.append(step)
                self._record_protection_failure(
                    step,
                    guardrail_id=identity["guardrail_id"],
                    integration_id=identity["integration_id"],
                    protocol_name=protocol_name,
                    phase=phase,
                )
        if decision.coverage is not None and decision.coverage.status != "complete":
            coverage_steps = failed_steps or [None]
            for step in coverage_steps:
                labels = _failure_labels(step)
                self.incomplete_coverage.labels(
                    guardrail_id=identity["guardrail_id"],
                    integration_id=identity["integration_id"],
                    protocol=protocol_name,
                    phase=phase,
                    coverage=decision.coverage.status,
                    **labels,
                ).inc()

    def _record_policy_triggers(
        self,
        decision: ProtectionDecision,
        *,
        identity: dict[str, str],
        protocol_name: str,
        phase: str,
        disposition: str,
    ) -> None:
        triggers: set[tuple[str, str, str, str, str]] = set()
        observed_findings = set()
        for assessment in decision.assessments:
            for fragment in assessment.fragments:
                for finding in fragment.findings:
                    observed_findings.add(finding)
                    if finding.verdict in {"unsafe", "uncertain", "error"}:
                        triggers.add((
                            assessment.module_id or "__unknown__",
                            finding.risk or "unknown",
                            finding.policy_id or "__builtin__",
                            finding.recommended_action or "pass",
                            finding.verdict,
                        ))
        for finding in decision.findings:
            if finding in observed_findings or finding.verdict not in {
                "unsafe", "uncertain", "error",
            }:
                continue
            triggers.add((
                "__unknown__",
                finding.risk or "unknown",
                finding.policy_id or "__builtin__",
                finding.recommended_action or "pass",
                finding.verdict,
            ))
        if not triggers and disposition in {"deny", "transform"}:
            for step in decision.trace:
                if step.kind != "action" or step.verdict not in {
                    "unsafe", "uncertain", "error",
                }:
                    continue
                triggers.add((
                    step.module_id or "__unknown__",
                    step.risk or "unknown",
                    step.policy_id or "__builtin__",
                    decision.action or "pass",
                    step.verdict,
                ))
        for module_id, risk, policy_id, action, verdict in triggers:
            self.policy_triggers.labels(
                guardrail_id=identity["guardrail_id"],
                integration_id=identity["integration_id"],
                protocol=protocol_name,
                phase=phase,
                disposition=disposition,
                module_id=module_id,
                risk=risk,
                policy_id=policy_id,
                action=action,
                verdict=verdict,
            ).inc()

    def _record_protection_failure(
        self,
        step,
        *,
        guardrail_id: str,
        integration_id: str,
        protocol_name: str,
        phase: str,
    ) -> None:
        self.protection_failures.labels(
            guardrail_id=guardrail_id,
            integration_id=integration_id,
            protocol=protocol_name,
            phase=phase,
            **_failure_labels(step),
        ).inc()

    def model_call_started(self, **labels: str) -> None:
        self.model_in_flight.labels(**_select_labels(labels, _MODEL_SCOPE_LABELS)).inc()

    def model_call_finished(self, *, usage, **labels: str) -> None:
        scope = _select_labels(labels, _MODEL_SCOPE_LABELS)
        self.model_in_flight.labels(**scope).dec()
        self.model_calls.labels(
            **scope,
            operation=labels["operation"],
            result=usage.result,
            error_type=usage.error_type,
        ).inc()
        self.model_call_duration.labels(**scope, result=usage.result).observe(
            max(0, usage.duration_ms) / 1_000,
            exemplar=current_exemplar(),
        )
        if usage.time_to_first_token_ms is not None:
            self.model_time_to_first_token.labels(**scope).observe(
                max(0, usage.time_to_first_token_ms) / 1_000,
                exemplar=current_exemplar(),
            )
        retry_reason = usage.error_type if usage.error_type != "none" else "provider_policy"
        if usage.retries > 0:
            self.model_retries.labels(**scope, reason=retry_reason).inc(usage.retries)
        if usage.backoff_ms > 0:
            self.model_backoff_duration.labels(**scope, reason=retry_reason).observe(
                usage.backoff_ms / 1_000,
                exemplar=current_exemplar(),
            )
        if usage.input_tokens > 0:
            self.model_tokens.labels(**scope, direction="input").inc(usage.input_tokens)
        if usage.output_tokens > 0:
            self.model_tokens.labels(**scope, direction="output").inc(usage.output_tokens)

    def reject_request(self, protocol_name: str, phase: str, result: str) -> None:
        self.request_rejections.labels(protocol=protocol_name, phase=phase, reason=result).inc()

    def observe_authentication(self, protocol_name: str, accepted: bool) -> None:
        self.authentication.labels(
            protocol=protocol_name, result="accepted" if accepted else "rejected",
        ).inc()

    def observe_route(self, protocol_name: str, phase: str, matched: bool) -> None:
        self.route_resolution.labels(
            protocol=protocol_name, phase=phase, result="matched" if matched else "unmatched",
        ).inc()

    def observe_failure(self, stage: str, reason_class: str) -> None:
        self.failures.labels(stage=stage, reason_class=reason_class).inc()

    def set_admission_load_provider(self, provider: Callable[[], tuple[int, int, int]]) -> None:
        self._admission_load = provider

    def set_desired_generation(self, generation: int) -> None:
        self.desired_generation.set(max(0, generation))

    def set_desired_state(
        self, *, generation: int, artifacts: int, routes: int, integrations: int,
    ) -> None:
        self._loaded_artifact_count = max(0, artifacts)
        self.applied_generation.set(max(0, generation))
        self.loaded_artifacts.set(self._loaded_artifact_count)
        self.configured_routes.set(max(0, routes))
        self.configured_integrations.set(max(0, integrations))

    def set_control_state(self, *, connected: bool | None = None, synchronized: bool | None = None) -> None:
        if connected is not None:
            self.control_connected.set(int(connected))
        if synchronized is not None:
            self.desired_state_synchronized.set(int(synchronized))

    def observe_control_reconnect(self, reason_class: str) -> None:
        self.control_reconnects.labels(reason_class=reason_class).inc()

    def observe_control_message(self, direction: str, message_type: str, result: str = "success") -> None:
        self.control_messages.labels(
            direction=direction, message_type=message_type or "unknown", result=result,
        ).inc()

    def set_control_queue_depth(self, depth: int) -> None:
        self.control_outgoing_queue.set(max(0, depth))

    def observe_heartbeat_sent(self) -> None:
        self.last_heartbeat_sent.set(time.time())

    def observe_desired_state_apply(self, result: str, duration_seconds: float) -> None:
        self.desired_state_apply.labels(result=result).inc()
        self.desired_state_apply_duration.observe(max(0, duration_seconds))

    def job(self, kind: str, active: bool) -> None:
        with self._lock:
            self._active_jobs[kind] = max(0, self._active_jobs.get(kind, 0) + (1 if active else -1))
            self.jobs_in_progress.labels(kind=kind).set(self._active_jobs[kind])

    def set_telemetry_wal(self, *, events: int, size_bytes: int, oldest_age_seconds: float) -> None:
        self.telemetry_wal_events.set(max(0, events))
        self.telemetry_wal_bytes.set(max(0, size_bytes))
        self.telemetry_wal_oldest_age.set(max(0, oldest_age_seconds))

    def observe_telemetry_export(
        self, *, operation: str, result: str, events: int, duration_seconds: float,
    ) -> None:
        self.telemetry_exports.labels(operation=operation, result=result).inc()
        self.telemetry_export_duration.labels(operation=operation).observe(max(0, duration_seconds))
        if events:
            self.telemetry_export_events.labels(result=result).inc(max(0, events))
        if result == "success":
            self.telemetry_last_success.set(time.time())

    def observe_telemetry_write_failure(self, operation: str) -> None:
        self.telemetry_write_failures.labels(operation=operation).inc()

    def heartbeat(self) -> protocol.RunnerLoad:
        now = time.monotonic()
        admission_inflight, queue_depth, admission_capacity = self._admission_load()
        with self._lock:
            window, self._window = self._window, _Window(started=now)
            interval_ms = max(1, round((now - window.started) * 1_000))
            p95 = _percentile(sorted(window.latencies_ms), 0.95)
            cpu = min(
                1.0,
                max(0.0, self._process.cpu_percent(interval=None) / 100 / _cpu_capacity_cores()),
            )
            rss = max(0, self._process.memory_info().rss)
            memory_limit = _memory_limit_bytes()
            memory_ratio = min(1.0, rss / memory_limit) if memory_limit > 0 else 0
            self.process_cpu.set(cpu)
            self.process_memory.set(rss)
            self.memory_limit_utilization.set(memory_ratio)
            self.admission_inflight.set(max(0, admission_inflight))
            self.admission_queue.set(max(0, queue_depth))
            self.admission_capacity.set(max(1, admission_capacity))
            return protocol.RunnerLoad(
                inflight=max(0, admission_inflight), max_concurrency=max(1, admission_capacity),
                queue_depth=max(0, queue_depth), requests_delta=window.requests,
                errors_delta=window.errors, timeouts_delta=window.timeouts,
                latency_p95_ms=p95, cpu_utilization=cpu, memory_utilization=memory_ratio,
                active_guardrails=self._loaded_artifact_count,
                compile_queue_depth=sum(self._active_jobs.values()),
                observation_interval_ms=interval_ms,
            )


def _bounded_result(value: str | None) -> str:
    normalized = (value or "unknown").lower()
    if normalized in {"complete", "passed", "safe", "allow", "success"}:
        return "success"
    if normalized in {"timeout", "timed_out"}:
        return "timeout"
    if normalized in {"error", "failed", "failure", "uncovered"}:
        return "error"
    if normalized in {"unsafe", "block", "transform", "intervene", "enforce"}:
        return "intervention"
    return "other"


def _identity_label(value: object | None, fallback: str) -> str:
    if value is None:
        return fallback
    normalized = str(value).strip()
    return normalized or fallback


def _select_labels(values: dict[str, str], names: tuple[str, ...]) -> dict[str, str]:
    """Project rich trace context onto a bounded Prometheus label contract."""

    return {name: values[name] for name in names}


def _disposition(decision: ProtectionDecision | None) -> str:
    if decision is None:
        return "unknown"
    return "deny" if decision.decision == "block" else decision.decision


def _failure_mode(decision: ProtectionDecision | None) -> str:
    if decision is None:
        return "normal"
    routes = {step.route for step in decision.trace}
    if (decision.usage is not None and decision.usage.fail_closed) or "fail_closed" in routes:
        return "fail_closed"
    if "fail_open" in routes:
        return "fail_open"
    return "normal"


def _failure_labels(step) -> dict[str, str]:
    if step is None:
        return {
            "module_id": "__unknown__",
            "stage": "unknown",
            "action": "__unknown__",
            "policy_id": "__unknown__",
            "failure_mode": "unknown",
            "reason_class": "coverage_incomplete",
        }
    return {
        "module_id": step.module_id or "__unknown__",
        "stage": step.stage or step.kind or "unknown",
        "action": step.action_name or step.name or "__unknown__",
        "policy_id": step.policy_id or "__builtin__",
        "failure_mode": (
            "fail_closed" if step.route == "fail_closed"
            else "fail_open" if step.route == "fail_open"
            else "normal"
        ),
        "reason_class": _step_reason_class(step),
    }


def _bounded_failure_stage(value: str | None) -> str:
    normalized = (value or "unknown").strip().casefold().replace("-", "_")
    return normalized if normalized in {
        "authentication", "routing", "runtime", "telemetry", "control",
        "desired_state", "provider", "unknown",
    } else "unknown"


def _bounded_failure_reason(value: str | None) -> str:
    normalized = (value or "unknown").strip().casefold().replace("-", "_")
    return normalized if normalized in {
        "timeout", "runtime_exception", "telemetry_append_failed",
        "guardrail_not_loaded", "configuration_error", "dependency_missing",
        "rate_limited", "transport_error", "invalid_response",
        "evaluation_failed", "unknown",
    } else "unknown"


def _step_reason_class(step) -> str:
    if step.timed_out or step.model_result == "timeout":
        return "timeout"
    if step.model_result in {
        "rate_limited", "client_error", "server_error", "transport_error",
        "invalid_response", "configuration_error", "unknown_error",
    }:
        return step.model_result
    detail = (step.detail or "").casefold()
    if "credential" in detail or "authentication" in detail:
        return "configuration_error"
    if "unavailable" in detail or "not loaded" in detail or "missing" in detail:
        return "dependency_missing"
    if "timeout" in detail or "deadline" in detail:
        return "timeout"
    if "rate" in detail and "limit" in detail:
        return "rate_limited"
    return "step_error"


def _memory_limit_bytes() -> int:
    paths = (Path("/sys/fs/cgroup/memory.max"), Path("/sys/fs/cgroup/memory/memory.limit_in_bytes"))
    for path in paths:
        try:
            raw = path.read_text(encoding="utf-8").strip()
            if raw and raw != "max":
                value = int(raw)
                if 0 < value < 1 << 60:
                    return value
        except (OSError, ValueError):
            pass
    return max(1, psutil.virtual_memory().total)


def _cpu_capacity_cores() -> float:
    try:
        quota, period = Path("/sys/fs/cgroup/cpu.max").read_text(encoding="utf-8").split()[:2]
        if quota != "max" and float(period) > 0:
            return max(0.001, float(quota) / float(period))
    except (OSError, ValueError):
        pass
    try:
        quota = float(Path("/sys/fs/cgroup/cpu/cpu.cfs_quota_us").read_text(encoding="utf-8"))
        period = float(Path("/sys/fs/cgroup/cpu/cpu.cfs_period_us").read_text(encoding="utf-8"))
        if quota > 0 and period > 0:
            return max(0.001, quota / period)
    except (OSError, ValueError):
        pass
    try:
        affinity = psutil.Process().cpu_affinity()
        if affinity:
            return float(len(affinity))
    except (AttributeError, NotImplementedError, psutil.Error):
        pass
    return float(max(1, psutil.cpu_count() or 1))


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0
    index = min(len(values) - 1, max(0, math.ceil(len(values) * percentile) - 1))
    return round(values[index], 3)
