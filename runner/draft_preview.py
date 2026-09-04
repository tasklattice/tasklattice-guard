from __future__ import annotations

import asyncio
import hashlib
import json
import time
from dataclasses import dataclass
from typing import Any

from runner.toolkit.nemo.action_registry import ActionProviders
from runner.toolkit.nemo.registry import NeMoRuntimeRegistry
from runner.toolkit.nemo.runtime import NeMoRuntime
from runner.toolkit.runtime.context import CallContextStore
from runner.toolkit.runtime.contracts import (
    PlanResolution,
    ProtectionDecision,
    ProtectionRequest,
    RuntimeTraceStep,
)
from runner.toolkit.runtime.service import GuardrailRuntimeService

from .compiler import DefaultRunnerCompiler
from .artifact_config import config_snapshot_from_artifact
from . import generated as protocol
from .protocol_codec import (
    plan_from_proto,
    plan_to_proto,
)
from .serialization import plan_from_dict


@dataclass(slots=True)
class _PreviewEntry:
    fingerprint: str
    compiler_version: str
    runtime_profile: str
    service: GuardrailRuntimeService
    runtime: NeMoRuntime
    expires_at: float


class DraftPreviewRuntime:
    """Compile and isolate short-lived Guardrail draft runtimes for Playground."""

    def __init__(
        self,
        compiler: DefaultRunnerCompiler,
        providers: ActionProviders,
        *,
        ttl_seconds: float = 900.0,
        max_entries: int = 32,
        max_concurrency_per_guardrail: int = 8,
    ) -> None:
        self._compiler = compiler
        self._providers = providers
        self._ttl_seconds = max(1.0, ttl_seconds)
        self._max_entries = max(1, max_entries)
        self._max_concurrency = max(1, max_concurrency_per_guardrail)
        self._items: dict[str, _PreviewEntry] = {}
        self._cleanup_tasks: set[asyncio.Task[None]] = set()
        self._lock = asyncio.Lock()

    async def prepare(
        self,
        *,
        preview_id: str,
        guardrail_id: str,
        draft_revision: int,
        candidate_version: str,
        plan: dict[str, Any],
        runtime_profile: str,
    ) -> dict[str, str | int]:
        fingerprint = _fingerprint(
            guardrail_id, draft_revision, candidate_version, plan, runtime_profile
        )
        retired: list[_PreviewEntry] = []
        async with self._lock:
            retired.extend(self._prune_locked())
            current = self._items.get(preview_id)
            if current is not None:
                if current.fingerprint != fingerprint:
                    raise ValueError("Draft preview identity no longer matches its prepared plan.")
                current.expires_at = time.monotonic() + self._ttl_seconds
                return _descriptor(current, draft_revision, self._ttl_seconds)

            artifact = await asyncio.to_thread(
                self._compiler.compile,
                protocol.CompileRequest(
                    compile_id=preview_id,
                    guardrail_id=guardrail_id,
                    guardrail_version=candidate_version,
                    generation=0,
                    plan=plan_to_proto(plan),
                    runtime_profile=runtime_profile,
                ),
            )
            compiled_plan = plan_from_dict(plan_from_proto(artifact.plan))
            config = _config_from_artifact(artifact)
            store = _PreviewStore(preview_id, draft_revision, compiled_plan, config)
            registry = NeMoRuntimeRegistry(
                store,
                self._providers,
                max_entries=1,
                max_concurrency_per_guardrail=self._max_concurrency,
                native_models=self._compiler.native_models,
            )
            runtime = NeMoRuntime(registry)
            service = GuardrailRuntimeService(
                runtime,
                store,
                contexts=CallContextStore(ttl_seconds=self._ttl_seconds, max_entries=1_000),
            )
            entry = _PreviewEntry(
                fingerprint=fingerprint,
                compiler_version=artifact.compiler_version,
                runtime_profile=artifact.runtime_profile,
                service=service,
                runtime=runtime,
                expires_at=time.monotonic() + self._ttl_seconds,
            )
            self._items[preview_id] = entry
            cleanup = asyncio.create_task(
                self._expire(preview_id, fingerprint),
                name=f"draft-preview-expiry:{preview_id}",
            )
            self._cleanup_tasks.add(cleanup)
            cleanup.add_done_callback(self._cleanup_tasks.discard)
            while len(self._items) > self._max_entries:
                oldest_id = min(self._items, key=lambda key: self._items[key].expires_at)
                if oldest_id == preview_id and len(self._items) > 1:
                    oldest_id = min(
                        (key for key in self._items if key != preview_id),
                        key=lambda key: self._items[key].expires_at,
                    )
                retired.append(self._items.pop(oldest_id))
        await _shutdown(retired)
        return _descriptor(entry, draft_revision, self._ttl_seconds)

    async def evaluate(
        self,
        request: ProtectionRequest,
        *,
        preview_id: str,
        guardrail_id: str,
        draft_revision: int,
        candidate_version: str,
        plan: dict[str, Any],
        runtime_profile: str,
    ) -> ProtectionDecision:
        await self.prepare(
            preview_id=preview_id,
            guardrail_id=guardrail_id,
            draft_revision=draft_revision,
            candidate_version=candidate_version,
            plan=plan,
            runtime_profile=runtime_profile,
        )
        async with self._lock:
            entry = self._items.get(preview_id)
            if entry is None or entry.expires_at <= time.monotonic():
                raise LookupError("Draft preview expired. Prepare it again before testing.")
            entry.expires_at = time.monotonic() + self._ttl_seconds
            service = entry.service
        return await service.evaluate_guardrail(request, guardrail_id, candidate_version)

    async def shutdown(self) -> None:
        async with self._lock:
            entries = list(self._items.values())
            self._items.clear()
            cleanup_tasks = list(self._cleanup_tasks)
            self._cleanup_tasks.clear()
        for task in cleanup_tasks:
            task.cancel()
        if cleanup_tasks:
            await asyncio.gather(*cleanup_tasks, return_exceptions=True)
        await _shutdown(entries)

    async def replace_providers(self, providers: ActionProviders) -> None:
        """Use a new active Provider registry for subsequently prepared previews."""
        async with self._lock:
            entries = list(self._items.values())
            self._items.clear()
            self._providers = providers
        await _shutdown(entries)

    def _prune_locked(self) -> list[_PreviewEntry]:
        now = time.monotonic()
        expired = [key for key, item in self._items.items() if item.expires_at <= now]
        return [self._items.pop(key) for key in expired]

    async def _expire(self, preview_id: str, fingerprint: str) -> None:
        while True:
            async with self._lock:
                entry = self._items.get(preview_id)
                if entry is None or entry.fingerprint != fingerprint:
                    return
                remaining = entry.expires_at - time.monotonic()
                if remaining <= 0:
                    retired = self._items.pop(preview_id)
                    break
            await asyncio.sleep(remaining)
        await retired.runtime.shutdown()


class _PreviewStore:
    def __init__(self, preview_id: str, draft_revision: int, plan, config) -> None:
        self._preview_id = preview_id
        self._draft_revision = draft_revision
        self._plan = plan
        self._config = config

    def plan(self, guardrail_id: str, version: str):
        if (guardrail_id, version) != (
            self._plan.guardrail_id,
            self._plan.guardrail_version,
        ):
            raise KeyError((guardrail_id, version))
        return self._plan

    def nemo_config(self, guardrail_id: str, version: str):
        self.plan(guardrail_id, version)
        return self._config

    def active_plan_keys(self) -> tuple[tuple[str, str], ...]:
        return ((self._plan.guardrail_id, self._plan.guardrail_version),)

    def resolve_guardrail(self, guardrail_id: str, version: str) -> PlanResolution:
        plan = self.plan(guardrail_id, version)
        deployment_id = f"playground-draft:{self._preview_id}"
        return PlanResolution(
            plan=plan,
            deployment_id=deployment_id,
            trace=(RuntimeTraceStep(
                id=f"draft-preview:{self._preview_id}",
                kind="preview",
                name=f"Draft r{self._draft_revision}",
                status="selected",
                detail="Controller selected an unpublished, temporary Guardrail draft preview.",
                guardrail_id=plan.guardrail_id,
                guardrail_version=plan.guardrail_version,
            ),),
        )


def _config_from_artifact(artifact: protocol.Artifact):
    return config_snapshot_from_artifact(artifact)


def _fingerprint(
    guardrail_id: str,
    draft_revision: int,
    candidate_version: str,
    plan: dict[str, Any],
    runtime_profile: str,
) -> str:
    payload = json.dumps({
        "guardrail_id": guardrail_id,
        "draft_revision": draft_revision,
        "candidate_version": candidate_version,
        "plan": plan,
        "runtime_profile": runtime_profile,
    }, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode()).hexdigest()


def _descriptor(entry: _PreviewEntry, draft_revision: int, ttl_seconds: float) -> dict[str, str | int]:
    return {
        "draft_revision": draft_revision,
        "compiler_version": entry.compiler_version,
        "runtime_profile": entry.runtime_profile,
        "ttl_seconds": max(1, round(ttl_seconds)),
    }


async def _shutdown(entries: list[_PreviewEntry]) -> None:
    if entries:
        await asyncio.gather(
            *(entry.runtime.shutdown() for entry in entries),
            return_exceptions=True,
        )
