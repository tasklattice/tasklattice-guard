"""One bundled Laya checkpoint and bounded CPU executor per Runner process."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from functools import partial
from pathlib import Path
from typing import TYPE_CHECKING

from .model_bundle_contract import Bundle, GRAPH, RUNTIME, load_lock, load_onnx_agent, verify_bundle
from .model_validation_diagnostics import LocalModelCapture, local_model_capture
from .resources import cpu_capacity_cores
from .laya_batch import LayaBatchCall, LayaInput, current_laya_batch
from .toolkit.runtime.failures import ModelConfigurationError

if TYPE_CHECKING:
    from laya import Agent
    from laya.onnx_agent import ONNXAgent


BUILTIN_LAYA_BACKEND = "builtin_laya"
BUILTIN_LAYA_REVISION_LABEL = "tasklattice.builtin-laya-revision"
_REQUIRED_FILES = frozenset({
    "model.safetensors",
    "rl_agent_config.json",
    "encoder/config.json",
    "tokenizer/tokenizer.json",
    "tokenizer/tokenizer_config.json",
})


class BuiltinLayaBusyError(RuntimeError):
    """The bounded inference queue is full."""


class BuiltinLayaInferenceError(RuntimeError):
    """The local CPU forward failed."""


def _bounded_int(name: str, default: int) -> int:
    value = int(os.environ.get(name, str(default)))
    if not 1 <= value <= 64:
        raise ValueError(f"{name} must be an integer from 1 to 64.")
    return value


def _torch_thread_count(concurrency: int) -> int:
    override = "GUARD_BUILTIN_LAYA_TORCH_THREADS"
    if override in os.environ:
        return _bounded_int(override, 1)

    budget = "GUARD_RUNNER_CPU_MILLICORES"
    raw = os.environ.get(budget, "").strip()
    if raw and not raw.isdecimal():
        raise ValueError(f"{budget} must be a nonnegative integer in millicores.")
    millicores = int(raw or "0")
    capacity = cpu_capacity_cores()
    if millicores:
        capacity = min(capacity, millicores / 1_000)
    return max(1, min(64, int(capacity / concurrency)))


def configure_builtin_cpu_environment() -> None:
    """Set native defaults before NeMo/Torch can load their OpenMP runtimes."""
    if not os.environ.get("GUARD_BUILTIN_LAYA_MODEL_PATH", "").strip():
        return
    threads = _torch_thread_count(_bounded_int("GUARD_BUILTIN_LAYA_INFERENCE_CONCURRENCY", 1))
    # New native threads can initialize another OpenMP/BLAS pool. They must
    # inherit the same per-worker budget, rather than the machine's CPU count.
    for name in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
        os.environ[name] = str(threads)


def _verify_checkpoint(directory: Path) -> str:
    manifest = json.loads((directory / "model-manifest.json").read_text())
    if not isinstance(manifest, dict):
        raise ValueError("Built-in Laya manifest must be an object.")
    revision, files = manifest.get("revision"), manifest.get("files")
    if not isinstance(revision, str) or not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("Built-in Laya manifest has an invalid checkpoint revision.")
    if not isinstance(files, dict) or not _REQUIRED_FILES <= files.keys():
        raise ValueError("Built-in Laya manifest is missing required checkpoint files.")
    for name, digest in files.items():
        relative = Path(name)
        if (relative.is_absolute() or ".." in relative.parts
                or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)):
            raise ValueError("Built-in Laya manifest contains an invalid file or SHA-256.")
        path = (directory / relative).resolve(strict=True)
        if not path.is_relative_to(directory):
            raise ValueError("Built-in Laya checkpoint files must be inside its model directory.")
        with path.open("rb") as file:
            actual = hashlib.file_digest(file, "sha256").hexdigest()
        if actual != digest:
            raise ValueError(f"Built-in Laya checksum mismatch for {name}.")
    return revision


class BuiltinLaya:
    def __init__(self, directory: Path, *, concurrency: int = 1, torch_threads: int | None = None,
                 queue_capacity: int = 64, bundle_lock: Path | None = None) -> None:
        self._directory = directory
        self._bundle_lock = bundle_lock
        self._bundle: Bundle | None = None
        self.concurrency = concurrency
        self.torch_threads = _torch_thread_count(concurrency) if torch_threads is None else torch_threads
        self._init_torch_threads: Callable[[], None] | None = None
        self._native_thread_limit = None
        self.cpu_thread_pools: list[dict[str, object]] = []
        self._executor = ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="builtin-laya",
                                            initializer=self._initialize_worker)
        self._slots = asyncio.Semaphore(concurrency)
        self._capacity = concurrency + queue_capacity
        self._pending = 0
        self._agent: Agent | ONNXAgent | None = None
        self._closed = False
        self.revision: str | None = None

    @classmethod
    def from_env(cls) -> BuiltinLaya | None:
        configure_builtin_cpu_environment()
        directory = os.environ.get("GUARD_BUILTIN_LAYA_MODEL_PATH", "").strip()
        if not directory:
            return None
        lock = os.environ.get("GUARD_BUILTIN_LAYA_BUNDLE_LOCK", "").strip()
        return cls(Path(directory), concurrency=_bounded_int("GUARD_BUILTIN_LAYA_INFERENCE_CONCURRENCY", 1),
                   bundle_lock=Path(lock) if lock else None)

    @property
    def model_identity(self) -> dict[str, str]:
        if self._bundle is not None:
            return self._bundle.identity
        return {"modelVersion": self.revision} if self.revision is not None else {}

    def thresholds(self, capability: str, fallback: tuple[float, float]) -> tuple[float, float]:
        if self._bundle is None:
            return fallback
        policy = self._bundle.thresholds
        pair = policy["categories"].get(capability, policy["default"])
        return pair["allow"], pair["block"]

    async def start(self) -> None:
        if self._agent is not None:
            return
        try:
            self.revision, self._agent = await asyncio.get_running_loop().run_in_executor(
                self._executor, self._load,
            )
        except BaseException:
            await self.close()
            raise

    def _load(self) -> tuple[str, Agent | ONNXAgent]:
        directory = self._directory.resolve(strict=True)
        import torch

        from .toolkit.nemo.evaluators.laya import MODEL_HEAD_MAX_LEN, MODEL_MAX_LEN, check_input_coverage, parse_answers

        torch.set_num_threads(self.torch_threads)
        self._init_torch_threads = torch.init_num_threads
        bundle = None
        if self._bundle_lock is not None:
            lock = load_lock(self._bundle_lock)
            bundle = verify_bundle(directory, manifest_sha256=lock["manifestSha256"],
                                   model_version=lock["modelVersion"])
            if bundle.manifest["artifactSha256"] != lock["artifactSha256"]:
                raise ValueError("Model bundle artifact SHA-256 differs from its lock.")
            if (MODEL_MAX_LEN, MODEL_HEAD_MAX_LEN) != (RUNTIME["maxLen"], RUNTIME["headMaxLen"]):
                raise ValueError("Runner token budgets differ from the locked model contract.")
            revision = bundle.manifest["artifactSha256"][:40]
            agent = load_onnx_agent(directory, directory / GRAPH, self.torch_threads)
        else:
            import laya

            revision = _verify_checkpoint(directory)
            agent = laya.load(str(directory), device="cpu", fast=False, compile=False)
            agent.model.float().eval()
            agent.amp_enabled = False
        # CPU wheels can load separate BLAS/OpenMP runtimes. Torch's intra-op
        # setting alone does not bound those pools. Apply the same persistent
        # budget after model libraries load, before warmup. Per-request
        # limit/restore contexts would race between inference workers.
        self._configure_native_threads()
        payload = agent.system_one(
            "Hello", {"greeting": {"type": "noul", "instructions": "Does the text contain a greeting?"}},
            lang="en", max_len=MODEL_MAX_LEN, head_max_len=MODEL_HEAD_MAX_LEN,
        )
        parse_answers(payload, {"greeting"})
        check_input_coverage(payload)
        self._bundle = bundle
        return revision, agent

    def _configure_native_threads(self) -> None:
        from threadpoolctl import threadpool_info, threadpool_limits

        self._native_thread_limit = threadpool_limits(limits=self.torch_threads)
        self.cpu_thread_pools = [
            {key: pool[key] for key in ("user_api", "internal_api", "prefix", "num_threads")}
            for pool in threadpool_info()
        ]

    def _initialize_worker(self) -> None:
        # The first worker sets the count in _load. Later workers inherit it.
        if self._init_torch_threads is not None:
            self._init_torch_threads()
            # OpenMP limits are local to the calling application thread.
            self._configure_native_threads()

    async def close(self) -> None:
        self._closed = True
        self.revision = None
        await asyncio.to_thread(self._executor.shutdown, cancel_futures=True)
        self._agent = None
        self._bundle = None

    async def predict(self, state: str | dict[str, object], questions: dict[str, dict[str, object]], *,
                      max_len: int, head_max_len: int, deadline: float, allow_batch: bool = True) -> dict:
        from .toolkit.nemo.actions.model_call import record_model_queue

        if allow_batch and not getattr(self._agent, "hooks", ()) and (batch := current_laya_batch()):
            context = copy_context()
            call = LayaBatchCall(self, LayaInput(state, questions, max_len, head_max_len), deadline,
                local_model_capture(), lambda ms, sent: context.run(record_model_queue, ms, sent),
                asyncio.get_running_loop().create_future())
            return await batch.submit(call)
        return await self._execute(self._predict,
            (state, questions, max_len, head_max_len, local_model_capture()), deadline=deadline)

    async def predict_batch(self, calls: list[LayaBatchCall]) -> list[dict | Exception]:
        if self._closed or self._agent is None:
            for call in calls:
                call.queued(0, False)
            raise ModelConfigurationError("Built-in Laya is unavailable.")
        ready = [call for call in calls if not call.future.done() and time.monotonic() < call.deadline]
        admitted = ready[:max(0, self._capacity - self._pending)]
        ready_ids, admitted_ids = {id(call) for call in ready}, {id(call) for call in admitted}
        rejected = {}
        # Preserve per-check admission under load. A group with more members
        # than remaining capacity must not turn an admissible first check into
        # a queue error merely because its siblings cannot enter.
        for call in calls:
            if id(call) not in admitted_ids:
                error = (BuiltinLayaBusyError("Built-in Laya inference queue is full.")
                         if id(call) in ready_ids else TimeoutError("Built-in Laya inference deadline exceeded."))
                rejected[id(call)] = error
                call.queued(0, False)
                if not call.future.done():
                    call.future.set_exception(error)
        if not admitted:
            return [rejected[id(call)] for call in calls]
        selected: list[LayaBatchCall] = []

        def prepare():
            selected[:] = [call for call in admitted if not call.future.done() and time.monotonic() < call.deadline]
            if not selected:
                raise asyncio.CancelledError()
            return ([call.input for call in selected], [call.capture for call in selected])

        def queued(ms, sent):
            for call in calls:
                call.queued(ms, sent and any(call is active for active in selected))

        results = await self._execute(self._predict_batch, prepare, deadline=max(call.deadline for call in admitted),
                                     weight=len(admitted), on_queue=queued)
        by_call = {id(call): result for call, result in zip(selected, results, strict=True)}
        return [by_call.get(id(call), rejected.get(id(call), TimeoutError("Built-in Laya inference deadline exceeded.")))
                for call in calls]

    async def _execute(self, function, arguments, *, deadline: float, weight: int = 1, on_queue=None):
        from .toolkit.nemo.actions.model_call import record_model_queue

        queued = on_queue or record_model_queue
        agent = self._agent
        if self._closed or agent is None:
            queued(0, False)
            raise ModelConfigurationError("Built-in Laya is unavailable.")
        if self._pending + weight > self._capacity:
            queued(0, False)
            raise BuiltinLayaBusyError("Built-in Laya inference queue is full.")
        started = time.monotonic()
        acquired = False
        inference = None
        self._pending += weight
        try:
            async with asyncio.timeout(max(0, deadline - started)):
                await self._slots.acquire()
                acquired = True
                if self._closed:
                    raise ModelConfigurationError("Built-in Laya is shutting down.")
                if time.monotonic() >= deadline:
                    raise TimeoutError("Built-in Laya inference deadline exceeded.")
                inputs = arguments() if callable(arguments) else arguments
                inference = asyncio.get_running_loop().run_in_executor(
                    self._executor, function, agent, *inputs,
                )
                inference.add_done_callback(partial(self._inference_done, weight=weight))
                queued(round((time.monotonic() - started) * 1000), True)
                # Cancellation stops the caller's wait. The completion callback
                # still owns the permit until the CPU forward has finished.
                return await asyncio.shield(inference)
        finally:
            if inference is None:
                self._pending -= weight
                if acquired:
                    self._slots.release()
                queued(round((time.monotonic() - started) * 1000), False)

    @staticmethod
    def _predict_batch(agent, inputs: list[LayaInput], captures: list[LocalModelCapture | None]) -> list[dict | Exception]:
        from .laya_native_batch import predict_native_batch

        records = [capture.start({"state": item.state, "questions": item.questions, "lang": "en",
            "max_len": item.max_len, "head_max_len": item.head_max_len}) if capture is not None else None
            for item, capture in zip(inputs, captures, strict=True)]
        try:
            results = predict_native_batch(agent, inputs)
        except Exception as error:
            for capture, record in zip(captures, records, strict=True):
                if capture is not None:
                    capture.finish(record, error=error)
            raise BuiltinLayaInferenceError("Built-in Laya CPU forward failed.") from None
        for index, (result, capture, record) in enumerate(zip(results, captures, records, strict=True)):
            if capture is not None:
                capture.finish(record, error=result if isinstance(result, Exception) else None,
                               output=None if isinstance(result, Exception) else result)
            if isinstance(result, Exception):
                results[index] = BuiltinLayaInferenceError("Built-in Laya CPU forward failed.")
        return results

    @staticmethod
    def _predict(agent: Agent | ONNXAgent, state: str | dict[str, object], questions: dict[str, dict[str, object]],
                 max_len: int, head_max_len: int, capture: LocalModelCapture | None) -> dict:
        options = {"lang": "en", "max_len": max_len, "head_max_len": head_max_len}
        try:
            if capture is not None:
                return capture.invoke({"state": state, "questions": questions, **options},
                                      lambda: agent.system_one(state, questions, **options))
            return agent.system_one(state, questions, **options)
        except Exception:
            raise BuiltinLayaInferenceError("Built-in Laya CPU forward failed.") from None

    def _inference_done(self, inference: asyncio.Future, *, weight: int = 1) -> None:
        self._pending -= weight
        self._slots.release()
        if not inference.cancelled():
            inference.exception()
