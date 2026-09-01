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
from .http_metrics import instrument_http_metrics
from .metrics import RunnerMetrics
from .observability import configure_observability
from .providers import runtime_action_providers
from .telemetry import RuntimeTelemetryExporter


def create_app(settings: RunnerSettings | None = None) -> FastAPI:
    configured = settings or RunnerSettings.from_env()
    observability = configure_observability(configured)
    store = ArtifactStore(configured.artifact_public_key_path, configured.artifact_state_path)
    providers = action_providers(*runtime_action_providers(configured))
    metrics = RunnerMetrics(configured.max_concurrency)
    registry = NeMoRuntimeRegistry(
        store,
        providers,
        max_concurrency_per_guardrail=configured.max_concurrency,
    )
    store.attach_registry(registry)
    engine = NeMoRuntime(registry, model_call_observer=metrics)
    contexts = (
        RedisCallContextStore(configured.call_context_redis_url)
        if configured.call_context_redis_url
        else CallContextStore()
    )
    runtime = GuardrailRuntimeService(engine, store, contexts=contexts)
    metrics.set_admission_load_provider(registry.admission_load)
    artifact_count, route_count, integration_count = store.observability_counts()
    metrics.set_desired_state(
        generation=store.generation,
        artifacts=artifact_count,
        routes=route_count,
        integrations=integration_count,
    )
    telemetry = RuntimeTelemetryExporter(
        configured.telemetry_endpoint,
        configured.controller_token,
        configured.artifact_state_path,
        configured.telemetry_batch_size,
        configured.runner_id,
        metrics,
    )
    control = RunnerControlClient(configured, store, metrics, providers)
    metrics.set_control_state(synchronized=control.synchronized)
    draft_previews = DraftPreviewRuntime(
        DefaultRunnerCompiler(configured),
        providers,
        max_concurrency_per_guardrail=min(configured.max_concurrency, 8),
    ) if configured.compiler_capable else None
    runtime_api = RunnerAPI(
        runtime,
        store,
        metrics,
        telemetry,
        configured.runner_id,
        configured.controller_token,
        configured.runtime_log_encryption_key,
        draft_previews,
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        control_task = asyncio.create_task(control.run(), name="runner-control")
        telemetry_task = asyncio.create_task(telemetry.run(), name="runtime-telemetry")
        try:
            yield
        finally:
            await control.stop()
            await telemetry.stop()
            control_task.cancel()
            telemetry_task.cancel()
            await asyncio.gather(control_task, telemetry_task, return_exceptions=True)
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

    @app.get("/health/live")
    async def live():
        return {"status": "ok", "component": "guard-runner"}

    @app.get("/health/ready")
    async def ready():
        detail = registry.readiness()
        # A temporary Controller outage must not remove a Runner that already
        # holds a verified last-known-good generation from the runtime Service.
        # Fresh Pods still stay unready until their first successful sync.
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
