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
from pathlib import Path
from typing import TYPE_CHECKING

from .model_bundle_contract import Bundle, GRAPH, RUNTIME, load_lock, load_onnx_agent, verify_bundle
from .model_validation_diagnostics import LocalModelCapture, local_model_capture
from .resources import cpu_capacity_cores
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
        self.torch_threads = _torch_thread_count(concurrency) if torch_threads is None else torch_threads
        self._init_torch_threads: Callable[[], None] | None = None
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
        payload = agent.system_one(
            "Hello", {"greeting": {"type": "noul", "instructions": "Does the text contain a greeting?"}},
            lang="en", max_len=MODEL_MAX_LEN, head_max_len=MODEL_HEAD_MAX_LEN,
        )
        parse_answers(payload, {"greeting"})
        check_input_coverage(payload)
        self._bundle = bundle
        return revision, agent

    def _initialize_worker(self) -> None:
        # The first worker sets the count in _load. Later workers inherit it.
        if self._init_torch_threads is not None:
            self._init_torch_threads()

    async def close(self) -> None:
        self._closed = True
        self.revision = None
        await asyncio.to_thread(self._executor.shutdown, cancel_futures=True)
        self._agent = None
        self._bundle = None

    async def predict(self, state: str | dict[str, object], questions: dict[str, dict[str, object]], *,
                      max_len: int, head_max_len: int, deadline: float) -> dict:
        from .toolkit.nemo.actions.model_call import record_model_queue

        agent = self._agent
        if self._closed or agent is None:
            record_model_queue(0, False)
            raise ModelConfigurationError("Built-in Laya is unavailable.")
        if self._pending >= self._capacity:
            record_model_queue(0, False)
            raise BuiltinLayaBusyError("Built-in Laya inference queue is full.")
        started = time.monotonic()
        acquired = False
        inference = None
        self._pending += 1
        try:
            async with asyncio.timeout(max(0, deadline - started)):
                await self._slots.acquire()
                acquired = True
                if self._closed:
                    raise ModelConfigurationError("Built-in Laya is shutting down.")
                if time.monotonic() >= deadline:
                    raise TimeoutError("Built-in Laya inference deadline exceeded.")
                inference = asyncio.get_running_loop().run_in_executor(
                    self._executor, self._predict, agent, state, questions, max_len, head_max_len, local_model_capture(),
                )
                inference.add_done_callback(self._inference_done)
                record_model_queue(round((time.monotonic() - started) * 1000), True)
                # Cancellation stops the caller's wait. The completion callback
                # still owns the permit until the CPU forward has finished.
                return await asyncio.shield(inference)
        finally:
            if inference is None:
                self._pending -= 1
                if acquired:
                    self._slots.release()
                record_model_queue(round((time.monotonic() - started) * 1000), False)

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

    def _inference_done(self, inference: asyncio.Future) -> None:
        self._pending -= 1
        self._slots.release()
        if not inference.cancelled():
            inference.exception()
