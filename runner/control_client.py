from __future__ import annotations

import asyncio
import importlib.metadata
import logging
import time
import uuid
from pathlib import Path

import grpc

from . import __version__
from .artifact_store import ArtifactStore
from .compiler import DefaultRunnerCompiler
from .config import RunnerSettings
from . import generated as protocol
from .generated import runner_control_pb2_grpc as services
from .metrics import RunnerMetrics
from .protocol_codec import validation_case_result_to_proto, validation_metrics_to_proto
from .validator import DefaultRunnerValidator


logger = logging.getLogger("tasklattice.guard.runner.control")


class RunnerControlClient:
    def __init__(
        self,
        settings: RunnerSettings,
        store: ArtifactStore,
        metrics: RunnerMetrics,
    ) -> None:
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
        self._compiler = DefaultRunnerCompiler(settings) if settings.compiler_capable else None
        self._validator = DefaultRunnerValidator(self._compiler) if self._compiler else None

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
        try:
            response_stream = stub.Connect(self._messages(self._registration()), metadata=metadata)
            async for message in response_stream:
                self._connected.set()
                self._metrics.set_control_state(connected=True)
                message_type = message.WhichOneof("body") or "unknown"
                try:
                    await self._handle(message)
                    self._metrics.observe_control_message("received", message_type)
                except Exception:
                    self._metrics.observe_control_message("received", message_type, "error")
                    raise
        finally:
            self._connected.clear()
            self._metrics.set_control_state(connected=False)
            heartbeat.cancel()
            await asyncio.gather(heartbeat, return_exceptions=True)
            await channel.close()

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
                load=self._metrics.heartbeat(),
            ),
        ))
        self._metrics.observe_heartbeat_sent()

    async def _handle(self, message: protocol.ControllerMessage) -> None:
        body = message.WhichOneof("body")
        if body == "registration_accepted":
            self._heartbeat_interval = max(2, message.registration_accepted.heartbeat_interval_seconds)
            self._metrics.set_desired_generation(message.registration_accepted.desired_generation)
        elif body == "desired_state":
            await self._apply_desired_state(message.desired_state)
        elif body == "compile_request":
            await self._compile(message.compile_request)
        elif body == "validation_request":
            await self._validate(message.validation_request)
        elif body == "drain_request":
            logger.warning("Controller requested Runner drain: %s", message.drain_request.reason)

    async def _apply_desired_state(self, desired_state: protocol.DesiredState) -> None:
        started = time.perf_counter()
        self._metrics.set_desired_generation(desired_state.generation)
        try:
            await asyncio.to_thread(self._store.apply, desired_state)
            artifact_count, route_count, integration_count = self._store.observability_counts()
            self._metrics.set_desired_state(
                generation=desired_state.generation,
                artifacts=artifact_count,
                routes=route_count,
                integrations=integration_count,
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
            return
        for artifact in desired_state.artifacts:
            await self._artifact_result(artifact, desired_state.generation, True, "")
        # A desired state can contain only Integration or route changes and no
        # artifact acknowledgements. Report the applied generation immediately
        # so Controller mutations do not expose a Secret or route before the
        # data plane can actually serve it.
        await self._send_heartbeat()

    async def _compile(self, request: protocol.CompileRequest) -> None:
        if self._compiler is None:
            return
        self._metrics.job("compile", True)
        try:
            artifact = await asyncio.to_thread(self._compiler.compile, request)
            result = protocol.CompileResult(
                runner_id=self._settings.runner_id,
                compile_id=request.compile_id,
                accepted=True,
                artifact=artifact,
            )
        except Exception as error:
            logger.exception("Guardrail compile %s failed.", request.compile_id)
            result = protocol.CompileResult(
                runner_id=self._settings.runner_id,
                compile_id=request.compile_id,
                accepted=False,
                reason=str(error),
                artifact=protocol.Artifact(
                    guardrail_id=request.guardrail_id,
                    guardrail_version=request.guardrail_version,
                    generation=request.generation,
                ),
            )
        finally:
            self._metrics.job("compile", False)
        await self._send(protocol.RunnerMessage(
            message_id=str(uuid.uuid4()), sent_at_unix_ms=_now_ms(), compile_result=result,
        ))

    async def _validate(self, request: protocol.ValidationRequest) -> None:
        if self._validator is None:
            return
        self._metrics.job("validation", True)
        try:
            status, metrics, results = await self._validator.validate(request)
            result = protocol.ValidationResult(
                runner_id=self._settings.runner_id,
                run_id=request.run_id,
                accepted=True,
                status=(
                    protocol.VALIDATION_STATUS_PASSED
                    if status == "passed"
                    else protocol.VALIDATION_STATUS_FAILED
                ),
                metrics=validation_metrics_to_proto(metrics),
                results=[validation_case_result_to_proto(item) for item in results],
            )
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
            self._metrics.job("validation", False)
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
                runner_version=__version__,
                nemo_version=importlib.metadata.version("nemoguardrails"),
                max_concurrency=self._settings.max_concurrency,
                compiler_capable=self._settings.compiler_capable,
                applied_generation=self._store.generation,
            ),
        )

    def _channel(self) -> grpc.aio.Channel:
        if self._settings.controller_ca_path:
            credentials = grpc.ssl_channel_credentials(
                root_certificates=self._settings.controller_ca_path.read_bytes(),
                private_key=self._required(self._settings.client_key_path).read_bytes(),
                certificate_chain=self._required(self._settings.client_certificate_path).read_bytes(),
            )
            return grpc.aio.secure_channel(self._settings.controller_target, credentials)
        return grpc.aio.insecure_channel(self._settings.controller_target)

    @staticmethod
    def _required(path: Path | None) -> Path:
        if path is None:
            raise RuntimeError("Runner mTLS path is unavailable.")
        return path


def _now_ms() -> int:
    return int(time.time() * 1_000)
