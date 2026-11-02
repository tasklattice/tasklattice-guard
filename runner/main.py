from __future__ import annotations

import asyncio
import hmac
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, Response
from prometheus_client.openmetrics.exposition import CONTENT_TYPE_LATEST, generate_latest

from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.registry import NeMoRuntimeRegistry
from runner.toolkit.nemo.runtime import NeMoRuntime
from runner.toolkit.runtime.context import CallContextStore
from runner.toolkit.runtime.service import GuardrailRuntimeService

from .api import RunnerAPI
from .artifact_store import ArtifactStore
from .compiler import DefaultRunnerCompiler
from .call_context import RedisCallContextStore
from .config import RunnerSettings
from .control_client import RunnerControlClient
from .draft_preview import DraftPreviewRuntime
from .diagnostics import EventLoopWatchdog, diagnostic_phase
from .http_metrics import instrument_http_metrics
from .metrics import RunnerMetrics
from .observability import configure_observability
from .providers import runtime_action_providers
from .telemetry import RuntimeTelemetryExporter
from .runtime_log_capture import RuntimeLogCapture
from .synchronization import RuntimeSynchronizationMiddleware
from .distributed_rate_admission import RedisRateAdmission
from .group_rate_admission import RedisGroupRateAdmission
from .admission_metrics import TenantAdmissionMetrics


def create_app(settings: RunnerSettings | None = None) -> FastAPI:
    configured = settings or RunnerSettings.from_env()
    if configured.group_rate_admission is not None:
        if (configured.distributed_rate_admission is not None or configured.tenant_admission is None or
            not configured.call_context_redis_url or not configured.control_token):
            raise ValueError("Group v2 rate requires local admission, Redis, pool control and v1 disabled.")
        configured.group_rate_admission.validate_runner(configured.pool_id, configured.tenant_admission.tenant_limits)
    if configured.distributed_rate_admission is not None:
        if configured.tenant_admission is None or not configured.call_context_redis_url or not configured.control_token:
            raise ValueError("Distributed rate admission requires local admission, Redis and pool control authentication.")
        if (configured.distributed_rate_admission.pool_id != configured.pool_id or
            set(configured.distributed_rate_admission.tenant_limits) != set(configured.tenant_admission.tenant_limits)):
            raise ValueError("Distributed rate policy must match the trusted pool and local tenant configuration.")
    observability = configure_observability(configured)
    store = ArtifactStore(configured.artifact_public_key_path, configured.artifact_state_path)
    providers = action_providers(*runtime_action_providers(configured))
    metrics = RunnerMetrics(configured.max_concurrency)
    registry = NeMoRuntimeRegistry(
        store,
        providers,
        max_concurrency_per_guardrail=configured.max_concurrency,
    )
    with diagnostic_phase("startup.restore_artifacts"):
        store.attach_registry(registry)
    watchdog = EventLoopWatchdog(metrics.registry, runner_id=configured.runner_id)
    engine = NeMoRuntime(registry, model_call_observer=metrics)
    contexts = (
        RedisCallContextStore(configured.call_context_redis_url)
        if configured.call_context_redis_url
        else CallContextStore()
    )
    runtime = GuardrailRuntimeService(engine, store, contexts=contexts)
    metrics.set_admission_load_provider(registry.admission_load)
    artifact_count, route_count, endpoint_count = store.observability_counts()
    metrics.set_desired_state(
        generation=store.generation,
        artifacts=artifact_count,
        routes=route_count,
        endpoints=endpoint_count,
    )
    telemetry = RuntimeTelemetryExporter(
        configured.telemetry_endpoint,
        configured.telemetry_token,
        configured.artifact_state_path,
        configured.telemetry_batch_size,
        configured.runner_id,
        metrics,
        progress_enabled=configured.telemetry_progress_enabled,
        progress_state_path=configured.telemetry_progress_state_path,
    )
    compiler = DefaultRunnerCompiler() if configured.compiler_capable else None
    draft_previews = DraftPreviewRuntime(
        compiler,
        providers,
        max_concurrency_per_guardrail=min(configured.max_concurrency, 8),
    ) if compiler is not None else None
    control = RunnerControlClient(
        configured,
        store,
        metrics,
        providers=providers,
        provider_observer=(
            draft_previews.replace_providers
            if draft_previews is not None
            else None
        ),
        compiler=compiler,
        telemetry=telemetry,
    )
    metrics.set_control_state(synchronized=control.synchronized)
    log_capture = RuntimeLogCapture(configured.call_context_redis_url)
    rate = None
    group_rate = None
    admission_observer = (TenantAdmissionMetrics(metrics.registry, configured.tenant_admission.capacity,
                          configured.tenant_admission.tenant_limits) if configured.tenant_admission is not None else None)
    if admission_observer is not None:
        metrics.set_tenant_admission_snapshot_provider(admission_observer.snapshot)
    if configured.distributed_rate_admission is not None:
        rate = RedisRateAdmission.connect(configured.call_context_redis_url, configured.distributed_rate_admission)
    if configured.group_rate_admission is not None:
        group_rate = RedisGroupRateAdmission.connect(configured.call_context_redis_url, configured.group_rate_admission, configured.pool_id)
    runtime_api = RunnerAPI(
        runtime,
        store,
        metrics,
        telemetry,
        configured.runner_id,
        configured.controller_http_token or configured.controller_token,
        configured.runtime_log_encryption_key,
        draft_previews,
        scan_max_body_bytes=configured.scan_max_body_bytes,
        scan_timeout_seconds=configured.scan_timeout_seconds,
        runtime_log_capture=log_capture,
        tenant_admission=(configured.tenant_admission.build(lambda: control.synchronized, rate=rate, group_rate=group_rate, observer=admission_observer)
                          if configured.tenant_admission is not None else None),
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        async def retire_runtimes():
            while True:
                await asyncio.sleep(30)
                log_capture.prune()
                await registry.collect_retired()

        watchdog.start()
        control_task = asyncio.create_task(control.run(), name="runner-control")
        telemetry_task = asyncio.create_task(telemetry.run(), name="runtime-telemetry")
        retirement_task = asyncio.create_task(retire_runtimes(), name="runtime-retirement")
        try:
            yield
        finally:
            await watchdog.stop()
            await control.stop()
            await telemetry.stop()
            control_task.cancel()
            telemetry_task.cancel()
            retirement_task.cancel()
            await asyncio.gather(control_task, telemetry_task, retirement_task, return_exceptions=True)
            await log_capture.close()
            if rate is not None:
                await rate.aclose()
            if group_rate is not None:
                await group_rate.aclose()
            if draft_previews is not None:
                await draft_previews.shutdown()
            try:
                await engine.shutdown()
            finally:
                await asyncio.to_thread(observability.shutdown)

    app = FastAPI(
        title="TaskLattice Guard Runner",
        version="0.2.0",
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )
    app.include_router(runtime_api.router)
    app.add_middleware(RuntimeSynchronizationMiddleware, control=control)

    @app.get("/health/live")
    async def live():
        return {"status": "ok", "component": "guard-runner"}

    @app.get("/health/ready")
    async def ready():
        detail = registry.readiness()
        # A cached generation cannot attest that this pool still owns its
        # Endpoints after a group allocation change. Disconnect fences serving
        # until the new control stream verifies current desired state. The
        # opt-in lease consumer additionally requires an unexpired grant.
        ready_now = control.synchronized and bool(detail["ready"])
        response = {
            **detail,
            "ready": ready_now,
            "component": "guard-runner",
            "controller_connected": control.connected,
            "desired_state_synchronized": control.synchronized,
            "applied_generation": store.generation,
            "compiler_capable": configured.compiler_capable,
        }
        if not ready_now:
            raise HTTPException(status_code=503, detail=response)
        return response

    @app.get("/metrics")
    async def prometheus_metrics(authorization: str | None = Header(default=None)):
        if configured.metrics_token and (
            authorization is None
            or not hmac.compare_digest(authorization, f"Bearer {configured.metrics_token}")
        ):
            raise HTTPException(status_code=401, detail="Metrics authentication failed.")
        return Response(generate_latest(metrics.registry), media_type=CONTENT_TYPE_LATEST)

    instrument_http_metrics(app, metrics.registry)
    observability.instrument_app(app)

    app.state.artifact_store = store
    app.state.runner_control = control
    app.state.runner_metrics = metrics
    return app
app = create_app()
