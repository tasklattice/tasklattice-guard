from __future__ import annotations

import asyncio
import json
import hashlib
import importlib.metadata
import logging
import time
import uuid
from dataclasses import asdict
from datetime import UTC, datetime
from .telemetry import RuntimeTelemetryExporter
from .toolkit.nemo.actions.model_call import begin_cost_collection, end_cost_collection
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from pathlib import Path

import grpc
import httpx

from runner.toolkit.nemo.action_registry import ActionProviders, action_providers
from runner.toolkit.nemo.native_models import NativeRailModel, native_rail_models

from .software_version import SOFTWARE_VERSION
from .artifact_store import ArtifactStore
from .compiler import DefaultRunnerCompiler
from .capability_validation import validate_capability
from .config import RunnerSettings
from .diagnostics import diagnostic_phase
from .preparation import prepare
from .control_transport import CONTROL_CHANNEL_OPTIONS
from . import generated as protocol
from .generated import runner_control_pb2_grpc as services
from .metrics import RunnerMetrics
from .providers import dynamic_runtime_action_providers
from .protocol_codec import validation_case_result_to_proto, validation_metrics_to_proto
from .validator import DefaultRunnerValidator


logger = logging.getLogger("tasklattice.guard.runner.control")


def _prepare_model_dependencies(
    configuration: protocol.DataPlaneModelConfiguration, credentials: dict[str, str],
) -> tuple[ActionProviders, tuple[NativeRailModel, ...]]:
    with diagnostic_phase("desired_state.models", model_revision_id=configuration.revision_id):
        providers = action_providers(*dynamic_runtime_action_providers(configuration, credentials))
        return providers, native_rail_models(configuration, credentials)


class RunnerControlClient:
    def __init__(
        self,
        settings: RunnerSettings,
        store: ArtifactStore,
        metrics: RunnerMetrics,
        providers: ActionProviders | None = None,
        provider_observer: Callable[[ActionProviders], Awaitable[None]] | None = None,
        compiler: DefaultRunnerCompiler | None = None,
        telemetry: RuntimeTelemetryExporter | None = None,
    ) -> None:
        self._telemetry = telemetry
        self._settings = settings
        self._store = store
        self._metrics = metrics
        self._boot_id = str(uuid.uuid4())
        self._outgoing: asyncio.Queue[protocol.RunnerMessage] = asyncio.Queue(maxsize=1_000)
        self._stop = asyncio.Event()
        self._connected = asyncio.Event()
        self._synchronized = asyncio.Event()
        if store.generation > 0:
            self._synchronized.set()
        self._metrics.set_control_state(connected=False, synchronized=self._synchronized.is_set())
        self._heartbeat_interval = 10
        self._sequence = 0
        self._capability_tasks: set[asyncio.Task] = set()
        self._validation_lock = asyncio.Lock()
        # Reconnect retries replay results without executing the test suite again.
        # Bound both the number and serialized size of retained results.
        self._validation_results: OrderedDict[str, bytes] = OrderedDict()
        self._validation_result_bytes = 0
        self._validation_result_budget = 32 * 1024 * 1024
        self._compiler = None
        if settings.compiler_capable:
            self._compiler = compiler or DefaultRunnerCompiler()
        self._providers = providers
        self._materialization_key: str | None = None
        self._provider_observer = provider_observer
        self._validator = (
            DefaultRunnerValidator(self._compiler, providers, self._store.verify,
                                   max_concurrency=getattr(settings, "validation_max_concurrency", 8))
            if self._compiler
            else None
        )

    @property
    def connected(self) -> bool:
        return self._connected.is_set()

    @property
    def synchronized(self) -> bool:
        """Whether a verified last-known-good desired state can be served."""
        return self._synchronized.is_set()

    async def run(self) -> None:
        delay = 1.0
        while not self._stop.is_set():
            try:
                await self._connect_once()
                delay = 1.0
            except asyncio.CancelledError:
                raise
            except Exception:
                self._connected.clear()
                self._metrics.set_control_state(connected=False)
                self._metrics.observe_control_reconnect("stream_error")
                logger.exception("Runner control stream failed; reconnecting in %.1f seconds.", delay)
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=delay)
                except TimeoutError:
                    pass
                delay = min(30.0, delay * 2)

    async def stop(self) -> None:
        self._stop.set()

    async def _connect_once(self) -> None:
        # Results from a failed stream are retried by Controller reconciliation.
        # A fresh queue guarantees that registration is the first message on
        # every new stream instead of sitting behind stale heartbeats.
        self._outgoing = asyncio.Queue(maxsize=1_000)
        channel = self._channel()
        stub = services.RunnerControlStub(channel)
        heartbeat = asyncio.create_task(self._heartbeats())
        metadata = (("authorization", f"Bearer {self._settings.controller_token}"),)
        # Own the sender task explicitly. gRPC's iterator consumer can remain
        # blocked on our empty queue after the server has closed the RPC.
        response_stream = stub.Connect(metadata=metadata)
        sender = asyncio.create_task(
            self._write_messages(response_stream), name="guard-control-writer",
        )
        try:
            await self._receive_messages(response_stream)
        except ExceptionGroup as errors:
            # Preserve the transport error contract for callers and reconnect logic.
            if len(errors.exceptions) == 1:
                raise errors.exceptions[0] from None
            raise
        finally:
            response_stream.cancel()
            sender.cancel()
            self._connected.clear()
            self._metrics.set_control_state(connected=False)
            heartbeat.cancel()
            for task in self._capability_tasks:
                task.cancel()
            await asyncio.gather(*self._capability_tasks, return_exceptions=True)
            self._capability_tasks.clear()
            await asyncio.gather(heartbeat, sender, return_exceptions=True)
            await channel.close()

    async def _receive_messages(self, stream) -> None:
        # Keep ordinary commands ordered while emergency modes can overtake
        # model preparation or version tests already in progress.
        pending = asyncio.Queue(maxsize=64)

        async def handle(message):
            kind = message.WhichOneof("body") or "unknown"
            try:
                await self._handle(message)
                self._metrics.observe_control_message("received", kind)
            except Exception:
                self._metrics.observe_control_message("received", kind, "error")
                raise

        async def consume():
            while (message := await pending.get()) is not None:
                await handle(message)

        async with asyncio.TaskGroup() as tasks:
            tasks.create_task(consume())
            async for message in stream:
                self._connected.set()
                self._metrics.set_control_state(connected=True)
                if message.WhichOneof("body") == "protection_state":
                    await handle(message)
                else:
                    # Reconnect on overflow instead of blocking mode delivery.
                    pending.put_nowait(message)
            await pending.put(None)

    async def _write_messages(self, stream) -> None:
        async for message in self._messages(self._registration()):
            await stream.write(message)

    async def _messages(self, registration: protocol.RunnerMessage):
        self._metrics.observe_control_message("sent", "registration")
        yield registration
        while not self._stop.is_set():
            message = await self._outgoing.get()
            self._metrics.set_control_queue_depth(self._outgoing.qsize())
            self._metrics.observe_control_message("sent", message.WhichOneof("body") or "unknown")
            yield message

    async def _heartbeats(self) -> None:
        while not self._stop.is_set():
            await asyncio.sleep(self._heartbeat_interval)
            await self._send_heartbeat()

    async def _send_heartbeat(self) -> None:
        self._sequence += 1
        await self._send(protocol.RunnerMessage(
            message_id=str(uuid.uuid4()),
            sent_at_unix_ms=_now_ms(),
            heartbeat=protocol.RunnerHeartbeat(
                runner_id=self._settings.runner_id,
                boot_id=self._boot_id,
                sequence=self._sequence,
                applied_generation=self._store.generation,
                applied_protection_generation=self._store.protection_generation,
                load=self._metrics.heartbeat(),
            ),
        ))
        self._metrics.observe_heartbeat_sent()

    async def _handle(self, message: protocol.ControllerMessage) -> None:
        body = message.WhichOneof("body")
        if body == "registration_accepted":
            self._heartbeat_interval = max(2, message.registration_accepted.heartbeat_interval_seconds)
            self._metrics.set_desired_generation(message.registration_accepted.desired_generation)
        elif body == "protection_state":
            state = message.protection_state
            reason, accepted = "", True
            try:
                self._store.apply_protection_modes(state)
            except Exception as error:
                reason, accepted = str(error) or type(error).__name__, False
            await self._send(protocol.RunnerMessage(message_id=str(uuid.uuid4()), sent_at_unix_ms=_now_ms(),
                protection_result=protocol.GuardrailProtectionResult(runner_id=self._settings.runner_id,
                    generation=state.generation, accepted=accepted, reason=reason)))
        elif body == "desired_state":
            await self._apply_desired_state(message.desired_state)
        elif body == "validation_request":
            await self._validate(message.validation_request)
        elif body == "artifact_compilation_request":
            request = message.artifact_compilation_request
            if len(self._capability_tasks) >= 4:
                await self._send_compilation_result(request.compile_id, error="Compiler capacity reached. Retry shortly.")
            else:
                task = asyncio.create_task(self._compile_artifact(request))
                self._capability_tasks.add(task)
                task.add_done_callback(self._capability_tasks.discard)
        elif body == "capability_validation_request":
            if len(self._capability_tasks) >= 4:
                await self._send_capability_result(protocol.CapabilityValidationResult(
                    request_id=message.capability_validation_request.request_id,
                    message="Runner validation capacity reached. Retry shortly.",
                ))
            else:
                task = asyncio.create_task(self._validate_capability(message.capability_validation_request))
                self._capability_tasks.add(task)
                task.add_done_callback(self._capability_tasks.discard)
        elif body == "artifact_admission_request":
            if len(self._capability_tasks) >= 4:
                await self._send_admission_result(message.artifact_admission_request.request_id, False,
                                                  "Runner check capacity reached. Retry shortly.")
            else:
                task = asyncio.create_task(self._admit(message.artifact_admission_request))
                self._capability_tasks.add(task)
                task.add_done_callback(self._capability_tasks.discard)
        elif body == "drain_request":
            logger.warning("Controller requested Runner drain: %s", message.drain_request.reason)

    async def _apply_desired_state(self, desired_state: protocol.DesiredState) -> None:
        started = time.perf_counter()
        self._metrics.set_desired_generation(desired_state.generation)
        model_revision_id = (
            desired_state.model_configuration.revision_id
            if desired_state.HasField("model_configuration")
            else ""
        )
        try:
            providers = None
            native_models = None
            if desired_state.HasField("model_configuration"):
                with diagnostic_phase("desired_state.credentials", generation=desired_state.generation,
                                      model_revision_id=model_revision_id):
                    credentials = await self._model_credentials(
                        desired_state.model_configuration
                    )
                # Include leased credential values: a rotation must not reuse clients
                # merely because the assignment's revision ID stayed the same.
                materialization_key = hashlib.sha256(
                    desired_state.model_configuration.SerializeToString(deterministic=True)
                    + json.dumps(credentials, sort_keys=True, separators=(",", ":")).encode()
                ).hexdigest()
                if materialization_key != self._materialization_key:
                    providers, native_models = await prepare(
                        _prepare_model_dependencies, desired_state.model_configuration, credentials,
                    )
            else:
                materialization_key = None
            await prepare(self._store.apply, desired_state, providers=providers, native_models=native_models,
                          materialization_key=materialization_key)
            self._materialization_key = materialization_key
            if providers is not None:
                self._providers = providers
                if self._compiler is not None:
                    await prepare(self._compiler.configure_native_models, native_models or ())
                    self._validator = DefaultRunnerValidator(self._compiler, providers, self._store.verify,
                                                             max_concurrency=getattr(self._settings, "validation_max_concurrency", 8))
                if self._provider_observer is not None:
                    try:
                        await self._provider_observer(providers)
                    except Exception:
                        logger.exception(
                            "Dynamic Model Providers were applied, but existing Draft previews "
                            "could not be retired. New desired state remains active."
                        )
            artifact_count, route_count, endpoint_count = self._store.observability_counts()
            self._metrics.set_desired_state(
                generation=desired_state.generation,
                artifacts=artifact_count,
                routes=route_count,
                endpoints=endpoint_count,
            )
            self._synchronized.set()
            self._metrics.set_control_state(synchronized=True)
            self._metrics.observe_desired_state_apply("success", time.perf_counter() - started)
        except Exception as error:
            self._metrics.observe_desired_state_apply("rejected", time.perf_counter() - started)
            self._metrics.observe_failure("desired_state", "verification_or_prewarm")
            logger.exception("Rejected desired generation %d.", desired_state.generation)
            for artifact in desired_state.artifacts:
                await self._artifact_result(artifact, desired_state.generation, False, str(error))
            await self._desired_state_result(
                desired_state.generation,
                False,
                str(error),
                model_revision_id,
            )
            return
        for artifact in desired_state.artifacts:
            await self._artifact_result(artifact, desired_state.generation, True, "")
        await self._desired_state_result(
            desired_state.generation,
            True,
            "",
            model_revision_id,
        )
        # A desired state can contain only Endpoint or route changes and no
        # artifact acknowledgements. Report the applied generation immediately
        # so Controller mutations do not expose a Secret or route before the
        # data plane can actually serve it.
        await self._send_heartbeat()

    async def _model_credentials(
        self,
        configuration: protocol.DataPlaneModelConfiguration,
        lease_id: str | None = None,
    ) -> dict[str, str]:
        refs = sorted({
            runtime.credential_ref
            for runtime in configuration.runtimes
            if runtime.credential_ref
        })
        if not refs:
            return {}
        endpoint = self._settings.telemetry_endpoint
        base_url = endpoint.split("/api/internal/v1/", 1)[0].rstrip("/")
        if not base_url.startswith(("http://", "https://")):
            raise ValueError("Controller HTTP endpoint cannot be derived for Model credentials.")
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                f"{base_url}/api/internal/v1/model-credentials/resolve",
                headers={
                    "authorization": f"Bearer {self._settings.controller_token}",
                    "content-type": "application/json",
                },
                json={"refs": refs, **({"leaseId": lease_id} if lease_id else {})},
            )
            response.raise_for_status()
            payload = response.json()
        credentials = payload.get("credentials")
        if not isinstance(credentials, dict):
            raise TypeError("Controller returned an invalid Model credential lease.")
        missing = [ref for ref in refs if not isinstance(credentials.get(ref), str)]
        if missing:
            raise ValueError(
                "Controller did not resolve Model credentials: " + ", ".join(missing)
            )
        return {ref: str(credentials[ref]) for ref in refs}

    async def _compile_artifact(self, request: protocol.CompileRequest) -> None:
        try:
            if self._compiler is None:
                raise ValueError("This Runner is not compiler-capable.")
            artifact = await prepare(self._compiler.compile_offline, request)
        except Exception as error:
            await self._send_compilation_result(request.compile_id, error=str(error) or type(error).__name__)
            return
        await self._send_compilation_result(request.compile_id, artifact=artifact)

    async def _send_compilation_result(self, compile_id: str, *, artifact=None, error: str = "") -> None:
        await self._send(protocol.RunnerMessage(message_id=str(uuid.uuid4()), sent_at_unix_ms=_now_ms(),
            artifact_compilation_result=protocol.ArtifactCompilationResult(
                compile_id=compile_id, runner_id=self._settings.runner_id, artifact=artifact, error=error)))

    async def _validate_capability(self, request: protocol.CapabilityValidationRequest) -> None:
        try:
            if self._compiler is None:
                raise ValueError("This Runner is not compiler-capable.")
            async with asyncio.timeout(90):
                credentials = await self._model_credentials(request.configuration, request.credential_lease_id)
                result = await validate_capability(request, credentials)
        except Exception as error:
            result = protocol.CapabilityValidationResult(request_id=request.request_id,
                message=f"Rail validation could not complete ({type(error).__name__}). Check Runner availability and retry.")
        await self._send_capability_result(result)

    async def _send_capability_result(self, result: protocol.CapabilityValidationResult) -> None:
        await self._send(protocol.RunnerMessage(message_id=str(uuid.uuid4()), sent_at_unix_ms=_now_ms(),
                                              capability_validation_result=result))

    async def _admit(self, request: protocol.ArtifactAdmissionRequest) -> None:
        try:
            with diagnostic_phase("artifact.admission", request_id=request.request_id,
                                  guardrail_id=request.artifact.guardrail_id, version=request.artifact.guardrail_version):
                await prepare(self._store.admit, request.artifact)
        except Exception as error:
            logger.warning("Artifact admission check %s rejected: %s", request.request_id, error)
            await self._send_admission_result(request.request_id, False, str(error) or type(error).__name__)
            return
        await self._send_admission_result(request.request_id, True, "")

    async def _send_admission_result(self, request_id: str, admitted: bool, reason: str) -> None:
        await self._send(protocol.RunnerMessage(
            message_id=str(uuid.uuid4()), sent_at_unix_ms=_now_ms(),
            artifact_admission_result=protocol.ArtifactAdmissionResult(
                runner_id=self._settings.runner_id, request_id=request_id, admitted=admitted, reason=reason,
                nemo_version=importlib.metadata.version("nemoguardrails"),
                model_revision_id=self._store.model_revision_id,
            ),
        ))

    async def _validate(self, request: protocol.ValidationRequest) -> None:
        async with self._validation_lock:
            cached = self._validation_results.get(request.run_id)
            if cached is not None:
                self._validation_results.move_to_end(request.run_id)
                await self._send(protocol.RunnerMessage(
                    message_id=str(uuid.uuid4()), sent_at_unix_ms=_now_ms(),
                    validation_result=protocol.ValidationResult.FromString(cached),
                ))
                return
            await self._execute_validation(request)

    async def _execute_validation(self, request: protocol.ValidationRequest) -> None:
        if self._validator is None:
            return
        async def report_progress(phase: str, completed: int, passed: int) -> None:
            await self._send(protocol.RunnerMessage(
                message_id=str(uuid.uuid4()), sent_at_unix_ms=_now_ms(),
                validation_progress=protocol.ValidationProgress(
                    runner_id=self._settings.runner_id, run_id=request.run_id,
                    phase=protocol.ValidationExecutionPhase.Value(f"VALIDATION_EXECUTION_PHASE_{phase.upper()}"),
                    completed_cases=completed, passed_cases=passed,
                ),
            ))
        self._metrics.job("validation", True)
        cost_calls, cost_token = begin_cost_collection()
        cost_event_id = str(uuid.uuid4())
        try:
            with diagnostic_phase("guardrail.validation", run_id=request.run_id,
                                  guardrail_id=request.guardrail_id, cases=len(request.test_cases)):
                outcome = await self._validator.run(request, on_progress=report_progress)
            if request.HasField("test_model_rules") and not request.test_model_rules and cost_calls:
                raise RuntimeError("Local-only validation recorded a model call, including preparation.")
            passed = outcome.status == "passed"
            result = protocol.ValidationResult(
                runner_id=self._settings.runner_id,
                run_id=request.run_id,
                accepted=True,
                status=(
                    protocol.VALIDATION_STATUS_PASSED
                    if passed
                    else protocol.VALIDATION_STATUS_FAILED
                ),
                metrics=validation_metrics_to_proto(outcome.metrics),
                results=[validation_case_result_to_proto(item) for item in outcome.results],
                runtime=protocol.ValidationRuntime(
                    runner_id=self._settings.runner_id,
                    runner_version=SOFTWARE_VERSION["version"],
                    nemo_version=importlib.metadata.version("nemoguardrails"),
                    model_revision_id=self._store.model_revision_id,
                    compiler_model_types=list(self._validator.compiler_model_types),
                ),
            )
            if not request.HasField("artifact"):
                # Publication reuses exactly this tested draft candidate. A
                # released version was tested as it is and needs no candidate.
                result.candidate_artifact.CopyFrom(outcome.artifact)
            if outcome.test_scope is not None:
                scope = outcome.test_scope
                result.test_scope.CopyFrom(protocol.ValidationScope(
                    test_model_rules=scope["testModelRules"], model_invocations=scope["modelInvocations"],
                    execution_digest=scope["executionDigest"], full_artifact_loaded=scope["fullArtifactLoaded"],
                    skipped_rules=[protocol.ValidationSkippedRule(policy_id=r["policyId"], rule_id=r["ruleId"], reason=r["reason"])
                                   for r in scope["skippedRules"]],
                ))
        except Exception as error:
            logger.exception("Guardrail Validation %s failed.", request.run_id)
            result = protocol.ValidationResult(
                runner_id=self._settings.runner_id,
                run_id=request.run_id,
                accepted=False,
                reason=str(error),
                status=protocol.VALIDATION_STATUS_FAILED,
            )
        finally:
            end_cost_collection(cost_token)
            self._metrics.job("validation", False)
            if self._telemetry is not None and cost_calls:
                await self._telemetry.emit({
                    "id": cost_event_id, "requestId": request.run_id,
                    "runnerId": self._settings.runner_id, "guardrailId": request.guardrail_id,
                    "occurredAt": datetime.now(UTC).isoformat(), "direction": "incoming",
                    "decision": "testing", "durationMs": 0,
                    "metadata": {"costOnly": True, "costSource": "testing", "usage": {
                        "model_calls": [asdict(call) for call in cost_calls],
                        "model_invocations": len(cost_calls),
                    }},
                })
        encoded = result.SerializeToString()
        while self._validation_results and (len(self._validation_results) >= 64
                or self._validation_result_bytes + len(encoded) > self._validation_result_budget):
            _, previous = self._validation_results.popitem(last=False)
            self._validation_result_bytes -= len(previous)
        if len(encoded) <= self._validation_result_budget:
            self._validation_results[request.run_id] = encoded
            self._validation_result_bytes += len(encoded)
        await self._send(protocol.RunnerMessage(
            message_id=str(uuid.uuid4()), sent_at_unix_ms=_now_ms(), validation_result=result,
        ))

    async def _artifact_result(self, artifact, generation: int, accepted: bool, reason: str) -> None:
        await self._send(protocol.RunnerMessage(
            message_id=str(uuid.uuid4()), sent_at_unix_ms=_now_ms(),
            artifact_result=protocol.ArtifactResult(
                runner_id=self._settings.runner_id,
                artifact_id=artifact.artifact_id,
                generation=generation,
                accepted=accepted,
                reason=reason,
            ),
        ))

    async def _desired_state_result(
        self,
        generation: int,
        accepted: bool,
        reason: str,
        model_revision_id: str,
    ) -> None:
        await self._send(protocol.RunnerMessage(
            message_id=str(uuid.uuid4()), sent_at_unix_ms=_now_ms(),
            desired_state_result=protocol.DesiredStateResult(
                runner_id=self._settings.runner_id,
                generation=generation,
                accepted=accepted,
                reason=reason,
                model_revision_id=model_revision_id,
            ),
        ))

    async def _send(self, message: protocol.RunnerMessage) -> None:
        await self._outgoing.put(message)
        self._metrics.set_control_queue_depth(self._outgoing.qsize())

    def _registration(self) -> protocol.RunnerMessage:
        return protocol.RunnerMessage(
            message_id=str(uuid.uuid4()),
            sent_at_unix_ms=_now_ms(),
            registration=protocol.RunnerRegistration(
                runner_id=self._settings.runner_id,
                boot_id=self._boot_id,
                pool_id=self._settings.pool_id,
                runner_version=SOFTWARE_VERSION["version"],
                labels={"tasklattice.build": json.dumps(SOFTWARE_VERSION), "tasklattice.protection-modes": "1",
                        "tasklattice.offline-compilation": "1"},
                nemo_version=importlib.metadata.version("nemoguardrails"),
                max_concurrency=self._settings.max_concurrency,
                compiler_capable=self._settings.compiler_capable,
                applied_generation=self._store.generation,
                applied_protection_generation=self._store.protection_generation,
            ),
        )

    def _channel(self) -> grpc.aio.Channel:
        if self._settings.controller_ca_path:
            credentials = grpc.ssl_channel_credentials(
                root_certificates=self._settings.controller_ca_path.read_bytes(),
                private_key=self._required(self._settings.client_key_path).read_bytes(),
                certificate_chain=self._required(self._settings.client_certificate_path).read_bytes(),
            )
            return grpc.aio.secure_channel(
                self._settings.controller_target, credentials, options=CONTROL_CHANNEL_OPTIONS,
            )
        return grpc.aio.insecure_channel(
            self._settings.controller_target, options=CONTROL_CHANNEL_OPTIONS,
        )

    @staticmethod
    def _required(path: Path | None) -> Path:
        if path is None:
            raise RuntimeError("Runner mTLS path is unavailable.")
        return path


def _now_ms() -> int:
    return int(time.time() * 1_000)
