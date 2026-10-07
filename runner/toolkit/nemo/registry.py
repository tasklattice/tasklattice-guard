from __future__ import annotations

import asyncio
import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Protocol

import yaml
from nemoguardrails import Guardrails, RailsConfig

from runner.diagnostics import diagnostic_phase
from runner.preparation import prepare

from ..compiler.domain import PlanCompilationError
from ..evaluation.contracts import (
    MODEL_SAFETY_CAPABILITY_BY_CONTRACT,
    CONTRACT_TOPIC_SEMANTIC,
    CONTRACT_COMPANY_POLICY,
    CONTRACT_CONTEXTUAL_GROUNDING,
    CONTRACT_AUTOMATED_REASONING,
)
from ..runtime.contracts import GuardrailPlanSnapshot, NeMoConfigSnapshot
from ..policy_runtime.snapshots import definitions_from_parameters
from .action_registry import (
    ACTION_CUSTOMER_IDENTIFIER,
    ACTION_EVALUATE,
    ACTION_RECORD_NATIVE,
    ACTION_RECORD_POLICY,
    ACTION_RESOLVE,
    ActionProviders,
    action_providers,
)
from .artifacts import config_checksum
from .actions.model_call import instrument_nemo_models
from .actions.names import (
    ACTION_RECORD_OWNED_POLICY, ACTION_TOPIC_JUDGE, ACTION_GROUNDING,
    ACTION_AUTOMATED_REASONING,
)
from .actions.strict_topic_safety import install_strict_topic_safety_action
from .native_models import (
    NativeRailModel,
    TOPIC_CONTROL_MODEL_TYPE,
    TOPIC_CONTROL_PROFILE,
    materialize_model_configs,
)


logger = logging.getLogger("uvicorn.error.tasklattice.nemo.registry")


_PROFILE_RUNTIME = {
    "iorails_native": ("iorails", "1.0"),
    "llmrails_colang1_standard": ("llmrails", "1.0"),
    "llmrails_colang2_programmable": ("llmrails", "2.x"),
}
_EXECUTOR_ACTION_VERSIONS = {
    ACTION_CUSTOMER_IDENTIFIER: "1.0.0",
    ACTION_RECORD_POLICY: "1.0.0",
    ACTION_RECORD_OWNED_POLICY: "1.0.0",
    ACTION_RECORD_NATIVE: "1.0.0",
    ACTION_RESOLVE: "1.0.0",
}
_DECLARED_DEDICATED_CONTRACTS = {
    CONTRACT_TOPIC_SEMANTIC: (ACTION_TOPIC_JUDGE, "topic_control"),
    CONTRACT_COMPANY_POLICY: (ACTION_TOPIC_JUDGE, "company_policy"),
    CONTRACT_CONTEXTUAL_GROUNDING: (ACTION_GROUNDING, "contextual_grounding"),
    CONTRACT_AUTOMATED_REASONING: (ACTION_AUTOMATED_REASONING, "automated_reasoning"),
}


class NeMoConfigStore(Protocol):
    def plan(self, guardrail_id: str, version: str) -> GuardrailPlanSnapshot: ...

    def nemo_config(self, guardrail_id: str, version: str) -> NeMoConfigSnapshot: ...

    def active_plan_keys(self) -> tuple[tuple[str, str], ...]: ...


@dataclass(slots=True)
class NeMoRuntimeInstance:
    config: NeMoConfigSnapshot
    plan: GuardrailPlanSnapshot
    rails: Guardrails
    admission: asyncio.BoundedSemaphore
    native_models: tuple[NativeRailModel, ...] = ()
    active_requests: int = 0
    waiting_requests: int = 0


RuntimeKey = tuple[str, str]


@dataclass(frozen=True, slots=True)
class RuntimeCandidate:
    plan: GuardrailPlanSnapshot
    config: NeMoConfigSnapshot
    checksum: str


@dataclass(slots=True)
class PreparedRuntimeRelease:
    builder: _RuntimeBuilder
    candidates: dict[RuntimeKey, RuntimeCandidate]
    items: dict[RuntimeKey, NeMoRuntimeInstance]
    active: frozenset[RuntimeKey]
    created: list[NeMoRuntimeInstance] = field(default_factory=list)
    token: object = field(default_factory=object)


@dataclass(slots=True)
class _Release:
    prepared: PreparedRuntimeRelease
    expires_at: float
    used_until: dict[RuntimeKey, float] = field(default_factory=dict)
    pending: int = 0


class RuntimeNotPrepared(LookupError):
    pass


class NeMoRuntimeRegistry:
    """Prepare privately; publish complete releases with short, memory-only locks."""

    def __init__(self, store: NeMoConfigStore, providers: ActionProviders, *,
                 max_entries: int = 128, max_concurrency_per_guardrail: int = 64,
                 native_models: tuple[NativeRailModel, ...] = ()) -> None:
        self._max_entries = max(1, max_entries)
        self._max_concurrency_per_guardrail = max(1, max_concurrency_per_guardrail)
        self._lock = threading.RLock()
        self._build_lock = threading.Lock()  # Only builders use this; never serving readers.
        self._retired: dict[int, NeMoRuntimeInstance] = {}
        self._orphaned: list[Guardrails] = []
        self._releases: dict[str, _Release] = {}
        self._staged_refs: dict[object, list[NeMoRuntimeInstance]] = {}
        self._release_ttl_seconds = 600.0
        self._current_release_id: str | None = None
        self._closed = False
        self._hits = self._misses = 0
        builder = _RuntimeBuilder(providers, native_models, self._max_concurrency_per_guardrail, self._discard_rails)
        self._current = _Release(PreparedRuntimeRelease(builder, {}, {}, frozenset()), float("inf"))
        active = frozenset(store.active_plan_keys())
        if active:
            # Constructors used by validation/preview run on the preparation lane.
            try:
                staged = self.prepare_release(tuple((store.plan(*key), store.nemo_config(*key)) for key in active), active)
            except BaseException:
                rails = self._drain()
                if rails:
                    try:
                        loop = asyncio.get_running_loop()
                    except RuntimeError:
                        asyncio.run(_close_runtimes(rails))
                    else:
                        # Direct synchronous construction in async test/tool code.
                        task = loop.create_task(_close_runtimes(rails))
                        _cleanup_tasks.add(task)
                        task.add_done_callback(_cleanup_tasks.discard)
                raise
            self._current = _Release(staged, float("inf"))
            staged.created.clear()
            self._staged_refs.pop(staged.token)

    def get(self, plan: GuardrailPlanSnapshot) -> NeMoRuntimeInstance:
        return self.acquire(plan)[0]

    def _release(self, release_id: str | None) -> _Release:
        if self._closed:
            raise LookupError("NeMo Runtime Registry is closed.")
        if release_id is None:
            return self._current
        entry = self._releases.get(release_id)
        if entry is None or (release_id != self._current_release_id and entry.expires_at <= time.monotonic() and not entry.pending):
            raise LookupError("Pinned effective release is unavailable on this Runner. Start a new call; no fallback to newer models is allowed.")
        return entry

    def acquire(self, plan: GuardrailPlanSnapshot, *, release_id: str | None = None) -> tuple[NeMoRuntimeInstance, bool, int]:
        with self._lock:
            return self._acquire_entry(self._release(release_id), plan)

    def _acquire_entry(self, entry: _Release, plan: GuardrailPlanSnapshot) -> tuple[NeMoRuntimeInstance, bool, int]:
        key = (plan.guardrail_id, plan.guardrail_version)
        candidate = entry.prepared.candidates.get(key)
        if candidate is None or candidate.plan != plan:
            raise LookupError("The pinned effective release does not contain this execution plan.")
        item = entry.prepared.items.get(key)
        if item is None:
            raise RuntimeNotPrepared("Runtime must be prepared asynchronously before execution.")
        now = time.monotonic()
        entry.expires_at = now + self._release_ttl_seconds
        entry.used_until[key] = now + self._release_ttl_seconds
        self._hits += 1
        return item, True, 0

    async def acquire_async(self, plan: GuardrailPlanSnapshot, *, release_id: str | None = None) -> tuple[NeMoRuntimeInstance, bool, int]:
        try:
            return self.acquire(plan, release_id=release_id)
        except RuntimeNotPrepared:
            pass
        started = time.perf_counter()
        with self._lock:
            entry = self._release(release_id)
            entry.pending += 1
            entry.expires_at = time.monotonic() + self._release_ttl_seconds
        try:
            await prepare(self._prepare_one, entry, (plan.guardrail_id, plan.guardrail_version))
            with self._lock:
                if self._closed:
                    raise LookupError("NeMo Runtime Registry is closed.")
                item, _, _ = self._acquire_entry(entry, plan)
            return item, False, round((time.perf_counter() - started) * 1_000)
        finally:
            with self._lock:
                entry.pending -= 1

    def _prepare_one(self, entry: _Release, key: RuntimeKey) -> None:
        with self._build_lock:
            with self._lock:
                if key in entry.prepared.items:
                    return
                self._prune_items(entry)
                if key not in entry.prepared.active and len(entry.prepared.items.keys() - entry.prepared.active) >= self._max_entries:
                    raise RuntimeError("Runner on-demand runtime capacity is in use. Retry after existing leases expire.")
                candidate = entry.prepared.candidates[key]
                if self._closed:
                    raise LookupError("NeMo Runtime Registry is closed.")
            item = self._build_with_logging(entry.prepared.builder, candidate)
            with self._lock:
                entry.prepared.items[key] = item
                entry.used_until[key] = time.monotonic() + self._release_ttl_seconds
                self._misses += 1
                self._prune_items(entry)

    def retain_release(self, release_id: str) -> None:
        with self._lock:
            entry = self._release(release_id)
            entry.expires_at = time.monotonic() + self._release_ttl_seconds

    def prepare_release(self, candidates: tuple[tuple[GuardrailPlanSnapshot, NeMoConfigSnapshot], ...],
                        active: frozenset[RuntimeKey], *, providers: ActionProviders | None = None,
                        native_models: tuple[NativeRailModel, ...] | None = None) -> PreparedRuntimeRelease:
        with diagnostic_phase("runtime.prepare_release", candidates=len(candidates), active=len(active)), self._build_lock:
            with self._lock:
                previous = self._current.prepared
                previous_items = dict(previous.items)
                used_until = dict(self._current.used_until)
                if self._closed:
                    raise LookupError("NeMo Runtime Registry is closed.")
                token = object()
                self._staged_refs[token] = list(previous_items.values())
            builder = previous.builder
            if ((providers is not None and providers is not builder._providers)
                    or (native_models is not None and native_models != builder._native_models)):
                builder = _RuntimeBuilder(providers if providers is not None else builder._providers,
                    native_models if native_models is not None else builder._native_models,
                    self._max_concurrency_per_guardrail, self._discard_rails)
            staged = PreparedRuntimeRelease(builder, {}, {}, active, token=token)
            try:
                for plan, config in candidates:
                    key = (plan.guardrail_id, plan.guardrail_version)
                    if key in staged.candidates:
                        raise ValueError("Duplicate Guardrail Version in desired state.")
                    candidate = RuntimeCandidate(plan, config, config_checksum(config))
                    staged.candidates[key] = candidate
                    old = previous.candidates.get(key)
                    if (builder is previous.builder and old is not None and old.checksum == candidate.checksum
                            and old.plan == plan and key in previous_items
                            and (key in active or used_until.get(key, 0) > time.monotonic()
                                 or previous_items[key].active_requests or previous_items[key].waiting_requests)):
                        staged.items[key] = previous_items[key]
                if active - staged.candidates.keys():
                    raise ValueError("Active Guardrail Versions are missing from desired state.")
                for key in sorted(active):
                    if key not in staged.items:
                        item = self._build_with_logging(builder, staged.candidates[key])
                        staged.items[key] = item
                        staged.created.append(item)
                        with self._lock:
                            self._staged_refs[token].append(item)
                return staged
            except BaseException:
                self.discard_prepared(staged)
                raise

    def discard_prepared(self, staged: PreparedRuntimeRelease) -> None:
        with self._lock:
            self._retired.update((id(item.rails), item) for item in staged.created)
            staged.created.clear()
            self._staged_refs.pop(staged.token, None)

    def publish_release(self, release_id: str, staged: PreparedRuntimeRelease,
                        publish: Callable[[], None]) -> None:
        with self._lock:
            if self._closed:
                raise LookupError("NeMo Runtime Registry is closed.")
            now = time.monotonic()
            old = self._current
            old.expires_at = now + self._release_ttl_seconds
            entry = self._releases.get(release_id)
            if entry is None:
                entry = _Release(staged, now + self._release_ttl_seconds)
                # Preserve outstanding input/output leases when reusing instances.
                entry.used_until = {key: deadline for key, deadline in old.used_until.items()
                                    if staged.items.get(key) is old.prepared.items.get(key)}
            else:
                self.discard_prepared(staged)
            # Store readers never acquire this lock while holding the store lock.
            # All expensive validation, hashing, and disk I/O precede this callback.
            publish()
            reused = {id(item.rails) for item in entry.prepared.items.values()}
            self._retired.update((id(item.rails), item) for item in old.prepared.items.values() if id(item.rails) not in reused)
            self._releases[release_id] = entry
            self._current = entry
            self._current_release_id = release_id
            staged.created.clear()
            self._staged_refs.pop(staged.token, None)

    def _prune_items(self, entry: _Release) -> None:
        now = time.monotonic()
        for key, item in tuple(entry.prepared.items.items()):
            if ((entry is self._current and key in entry.prepared.active) or entry.used_until.get(key, 0) > now
                    or item.active_requests or item.waiting_requests):
                continue
            self._retired[id(item.rails)] = entry.prepared.items.pop(key)
            entry.used_until.pop(key, None)

    async def collect_retired(self) -> None:
        with self._lock:
            now = time.monotonic()
            retained_releases = {key: entry for key, entry in self._releases.items()
                if key == self._current_release_id or entry.expires_at > now or entry.pending
                or any(item.active_requests or item.waiting_requests for item in entry.prepared.items.values())}
            for key, entry in self._releases.items():
                if key not in retained_releases:
                    self._retired.update((id(item.rails), item) for item in entry.prepared.items.values())
            self._releases = retained_releases
            for entry in [self._current, *self._releases.values()]:
                self._prune_items(entry)
            retained = {id(item.rails) for entry in [self._current, *self._releases.values()]
                        for item in entry.prepared.items.values()}
            retained.update(id(item.rails) for items in self._staged_refs.values() for item in items)
            closing = {key: item.rails for key, item in self._retired.items()
                       if key not in retained and not item.active_requests and not item.waiting_requests}
            self._retired = {key: item for key, item in self._retired.items() if key not in closing}
            closing.update((id(rails), rails) for rails in self._orphaned)
            self._orphaned.clear()
        await asyncio.gather(*(rails.shutdown() for rails in closing.values()), return_exceptions=True)

    def stats(self) -> dict[str, int]:
        with self._lock:
            return {"entries": len(self._current.prepared.items), "retired": len(self._retired),
                    "hits": self._hits, "misses": self._misses}

    def admission_load(self) -> tuple[int, int, int]:
        with self._lock:
            items = {id(item): item for entry in [self._current, *self._releases.values()]
                     for item in entry.prepared.items.values()}
            active_items = {id(self._current.prepared.items[key]) for key in self._current.prepared.active if key in self._current.prepared.items}
            serving = sum(1 for key, item in items.items()
                          if key in active_items or item.active_requests or item.waiting_requests)
            return (sum(item.active_requests for item in items.values()),
                    sum(item.waiting_requests for item in items.values()),
                    max(1, serving) * self._max_concurrency_per_guardrail)

    def ready(self) -> bool:
        return bool(self.readiness()["ready"])

    def readiness(self) -> dict[str, object]:
        with self._lock:
            current = self._current.prepared
            missing = current.active - current.items.keys()
            return {"ready": not missing and not self._closed,
                    "status": "not_ready" if missing or self._closed else "ready",
                    "reason": "registry_closed" if self._closed else "missing_prewarmed_guardrail_versions" if missing else "all_active_guardrail_versions_prewarmed",
                    "active_versions": len(current.active),
                    "prewarmed_active_versions": len(current.active) - len(missing),
                    "missing_versions": [{"guardrail_id": key[0], "guardrail_version": key[1]} for key in sorted(missing)]}

    async def shutdown(self) -> None:
        with self._lock:
            self._closed = True
        rails = await prepare(self._drain, on_cancel=_close_runtimes)
        await _close_runtimes(rails)

    def _drain(self) -> list[Guardrails]:
        with self._build_lock, self._lock:
            rails = {id(item.rails): item.rails for entry in [self._current, *self._releases.values()]
                     for item in entry.prepared.items.values()}
            rails.update((id(item.rails), item.rails) for item in self._retired.values())
            rails.update((id(item), item) for item in self._orphaned)
            rails.update((id(item.rails), item.rails) for items in self._staged_refs.values() for item in items)
            self._current.prepared.items.clear()
            self._releases.clear()
            self._retired.clear()
            self._orphaned.clear()
            self._staged_refs.clear()
            return list(rails.values())

    def _discard_rails(self, rails: Guardrails) -> None:
        with self._lock:
            self._orphaned.append(rails)

    def _build_with_logging(self, builder: _RuntimeBuilder, candidate: RuntimeCandidate) -> NeMoRuntimeInstance:
        with diagnostic_phase("runtime.prewarm", guardrail_id=candidate.plan.guardrail_id,
                              version=candidate.plan.guardrail_version, profile=candidate.config.runtime_profile):
            return builder.build(candidate.plan, candidate.config)


_cleanup_tasks: set[asyncio.Task] = set()


async def _close_runtimes(rails: list[Guardrails]) -> None:
    closing = asyncio.gather(*(item.shutdown() for item in rails), return_exceptions=True)
    try:
        await asyncio.shield(closing)
    except asyncio.CancelledError:
        while not closing.done():
            try:
                await asyncio.shield(closing)
            except asyncio.CancelledError:
                continue
        raise


class _RuntimeBuilder:
    """Model/provider dependencies captured once; never mutate a serving builder."""

    def __init__(self, providers: ActionProviders, native_models: tuple[NativeRailModel, ...],
                 concurrency: int, discard: Callable[[Guardrails], None]) -> None:
        self._providers = providers
        self._native_models = native_models
        self._max_concurrency_per_guardrail = concurrency
        self._discard = discard

    def build(
        self,
        plan: GuardrailPlanSnapshot,
        config: NeMoConfigSnapshot,
    ) -> NeMoRuntimeInstance:
        from .runtime import NeMoActionBridge

        self._validate_runtime_profile(config)
        self._validate_bindings(config, plan)
        self._validate_native_model_dependencies(config)
        materialized_yaml = materialize_model_configs(
            config.config_yaml,
            config.required_models,
            self._native_models,
        )
        if TOPIC_CONTROL_MODEL_TYPE in config.required_models:
            install_strict_topic_safety_action()
        rails_config = RailsConfig.from_content(
            yaml_content=materialized_yaml,
            colang_content=config.colang_content or None,
        )
        use_iorails = config.runtime_profile == "iorails_native"
        if use_iorails:
            from nemoguardrails.guardrails.iorails import IORails

            reason = IORails.unsupported_reason(rails_config)
            if reason is not None:
                raise PlanCompilationError(
                    f"NeMo IORails cannot serve the compiled manifest: {reason}."
                )
        rails = Guardrails(
            rails_config,
            use_iorails=use_iorails,
            require_iorails=use_iorails,
        )
        try:
            if not use_iorails:
                instrument_nemo_models(rails, config.required_models)
            bridge = NeMoActionBridge(
                plan,
                config,
                self._providers_for(config),
            )
            if config.runtime_profile in {
                "llmrails_colang1_standard",
                "llmrails_colang2_programmable",
            }:
                bridge.register(rails)
            item = NeMoRuntimeInstance(
                config,
                plan,
                rails,
                asyncio.BoundedSemaphore(self._max_concurrency_per_guardrail),
                native_models=tuple(
                    item
                    for item in self._native_models
                    if item.type in config.required_models
                ),
            )
        except BaseException:
            self._discard(rails)
            raise
        return item

    def _validate_runtime_profile(self, config: NeMoConfigSnapshot) -> None:
        expected = _PROFILE_RUNTIME.get(config.runtime_profile)
        if expected is None:
            names = ", ".join(sorted(_PROFILE_RUNTIME))
            raise PlanCompilationError(
                f"Unknown NeMo runtime profile {config.runtime_profile!r}; "
                f"expected one of: {names}."
            )
        actual = (config.runtime_engine, config.colang_version)
        if actual != expected:
            raise PlanCompilationError(
                f"NeMo runtime profile {config.runtime_profile!r} requires "
                f"runtime_engine={expected[0]!r} and colang_version={expected[1]!r}; "
                f"received runtime_engine={actual[0]!r} and "
                f"colang_version={actual[1]!r}."
            )

        try:
            payload = yaml.safe_load(config.config_yaml) or {}
        except yaml.YAMLError as error:
            raise PlanCompilationError(
                "Compiled NeMo configuration YAML is invalid: "
                f"{error.__class__.__name__}."
            ) from error
        if not isinstance(payload, dict):
            raise PlanCompilationError(
                "Compiled NeMo configuration YAML must contain a mapping."
            )
        yaml_version = str(payload.get("colang_version", ""))
        if yaml_version != config.colang_version:
            raise PlanCompilationError(
                "NeMo artifact colang_version does not match config_yaml: "
                f"{config.colang_version!r} != {yaml_version!r}."
            )

        if config.runtime_profile == "iorails_native":
            action_dependencies = tuple(
                item
                for item in config.dependency_manifest
                if item and item[0] == "action"
            )
            if config.action_bindings or action_dependencies:
                raise PlanCompilationError(
                    "The iorails_native profile must be action-free."
                )
            if "sensitive_data_detection" in config.required_features:
                raise PlanCompilationError(
                    "The iorails_native profile cannot require runtime Action-backed "
                    "sensitive-data detection."
                )

        tracing = payload.get("tracing", {})
        tracing_enabled = isinstance(tracing, dict) and _enabled(
            tracing.get("enabled")
        )
        metrics = payload.get("metrics", {})
        metrics_enabled = isinstance(metrics, dict) and _enabled(
            metrics.get("enabled")
        )
        if (
            config.runtime_profile == "llmrails_colang2_programmable"
            and tracing_enabled
        ):
            raise PlanCompilationError(
                "Tracing must be disabled for the "
                "llmrails_colang2_programmable profile."
            )
        if config.runtime_profile != "iorails_native" and metrics_enabled:
            raise PlanCompilationError(
                f"Metrics must be disabled for the "
                f"{config.runtime_profile} profile."
            )

    def _validate_native_model_dependencies(
        self,
        config: NeMoConfigSnapshot,
    ) -> None:
        manifest_models = {
            name: version
            for kind, name, version in config.dependency_manifest
            if kind == "model"
        }
        undeclared = set(config.required_models) - manifest_models.keys()
        if undeclared:
            raise PlanCompilationError(
                "Native model requirements are missing from the artifact manifest: "
                + ", ".join(sorted(undeclared))
                + "."
            )
        if (
            TOPIC_CONTROL_MODEL_TYPE in config.required_models
            and manifest_models.get(TOPIC_CONTROL_MODEL_TYPE) != TOPIC_CONTROL_PROFILE
        ):
            raise PlanCompilationError(
                "Official Topic Safety requires the dedicated Model profile "
                f"{TOPIC_CONTROL_PROFILE!r}."
            )
        active_models = {item.type: item for item in self._native_models}
        for model_type in config.required_models:
            active = active_models.get(model_type)
            if active is None:
                continue
            expected_profile = manifest_models[model_type]
            if active.profile_ref != expected_profile:
                raise PlanCompilationError(
                    f"Native model {model_type!r} uses profile {active.profile_ref!r}; "
                    f"artifact requires {expected_profile!r}."
                )

    def _validate_bindings(self, config: NeMoConfigSnapshot, plan: GuardrailPlanSnapshot | None = None) -> None:
        for binding in config.action_bindings:
            if binding.capability == "builtin_content_filter":
                definitions_from_parameters(dict(binding.parameters))
        result_vars = tuple(
            binding.result_var
            for binding in config.action_bindings
            if binding.result_var
        )
        if config.runtime_profile == "llmrails_colang1_standard":
            missing = tuple(
                item.id for item in config.action_bindings if not item.result_var
            )
            if missing:
                raise PlanCompilationError(
                    "Colang 1 Action bindings require explicit result variables: "
                    + ", ".join(missing)
                    + "."
                )
            if len(result_vars) != len(set(result_vars)):
                raise PlanCompilationError(
                    "Colang 1 Action result variables must be unique."
                )
        elif result_vars:
            raise PlanCompilationError(
                f"The {config.runtime_profile} profile cannot carry Colang 1 "
                "Action result variables."
            )
        references = _action_references(config)
        if config.runtime_profile == "llmrails_colang1_standard":
            c2_only = sorted(
                name for name, _ in references if name in _EXECUTOR_ACTION_VERSIONS
            )
            if c2_only:
                raise PlanCompilationError(
                    "The Colang 1 standard profile cannot depend on programmable "
                    "executor Actions: " + ", ".join(c2_only) + "."
                )
        versions_by_name: dict[str, set[str]] = {}
        for name, version in references:
            versions_by_name.setdefault(name, set()).add(version)
        ambiguous = {
            name: versions
            for name, versions in versions_by_name.items()
            if len(versions) > 1
        }
        if ambiguous:
            names = ", ".join(
                f"{name} ({', '.join(sorted(versions))})"
                for name, versions in sorted(ambiguous.items())
            )
            raise PlanCompilationError(
                "A NeMo configuration cannot bind multiple versions under the same "
                f"Action name: {names}."
            )

        malformed = tuple(
            binding
            for binding in config.action_bindings
            if (
                not binding.capability
                or not binding.contract_ref
                or
                (not binding.action_name and not binding.flow_name)
                or (binding.action_name and not binding.action_version)
            )
        )
        malformed_dependencies = tuple(
            item
            for item in config.dependency_manifest
            if item[0] == "action" and (not item[1] or not item[2])
        )
        unavailable = tuple(
            (name, version)
            for name, version in sorted(references)
            if (
                (
                    name in _EXECUTOR_ACTION_VERSIONS
                    and version != _EXECUTOR_ACTION_VERSIONS[name]
                )
                or (
                    name not in _EXECUTOR_ACTION_VERSIONS
                    and (name, version) not in self._providers
                )
            )
        )
        if "sensitive_data_detection" in config.required_features and not (
            (ACTION_EVALUATE, "1.0.0") in self._providers
        ):
            raise PlanCompilationError(
                "NeMo sensitive-data rails require GuardEvaluateAction."
            )
        if malformed:
            names = ", ".join(
                f"{item.id} ({item.contract_ref})" for item in malformed
            )
            raise PlanCompilationError(
                f"NeMo Action bindings are incomplete for: {names}."
            )
        if malformed_dependencies:
            raise PlanCompilationError(
                "NeMo Action dependencies must pin a non-empty name and version."
            )
        if unavailable:
            names = ", ".join(
                f"{name}@{version}" for name, version in unavailable
            )
            raise PlanCompilationError(
                f"NeMo Action providers are unavailable for: {names}."
            )
        evaluation = self._providers.get((ACTION_EVALUATE, "1.0.0"))
        route_keys = frozenset(getattr(evaluation, "route_keys", ()))
        route_rail_keys = frozenset(getattr(evaluation, "route_rail_keys", ()))
        declared_phases: dict[str, set[str]] = {}
        for policy in plan.policy_versions if plan is not None else ():
            phases = {phase for binding in config.action_bindings
                if binding.policy_id == policy.policy_id and binding.policy_version == policy.version
                for phase in binding.phases}
            for contract in policy.evaluation_contracts:
                declared_phases.setdefault(contract, set()).update(phases)
        # Custom flows can declare a model dependency that is not their first
        # binding contract (or only call it on an untested branch). Enforce the
        # signed declaration before constructing NeMo, independently of calls
        # observed in a particular test. Local PII does not satisfy semantic PII.
        missing_declared_models = sorted({
            contract
            for kind, contract, _version in config.dependency_manifest
            if kind == "evaluation_contract"
            and contract in MODEL_SAFETY_CAPABILITY_BY_CONTRACT
            and (MODEL_SAFETY_CAPABILITY_BY_CONTRACT[contract], contract) not in route_keys
        })
        if missing_declared_models:
            raise PlanCompilationError(
                "Declared model Evaluator Bindings are unavailable for: "
                + ", ".join(missing_declared_models) + "."
            )
        missing_declared_rails = sorted(f"{contract} ({phase})"
            for contract, phases in declared_phases.items()
            if contract in MODEL_SAFETY_CAPABILITY_BY_CONTRACT
            for phase in phases
            if (MODEL_SAFETY_CAPABILITY_BY_CONTRACT[contract], contract, phase) not in route_rail_keys)
        if missing_declared_rails:
            raise PlanCompilationError("Declared model Evaluator Bindings are unavailable for Rails: "
                + ", ".join(missing_declared_rails) + ".")
        missing_dedicated = []
        for kind, contract, _version in config.dependency_manifest:
            if kind != "evaluation_contract" or contract not in _DECLARED_DEDICATED_CONTRACTS:
                continue
            # Official native Topic Safety does not register a Guard Action.
            # Its signed model requirement is checked/materialized separately.
            if (contract == CONTRACT_TOPIC_SEMANTIC and TOPIC_CONTROL_MODEL_TYPE in config.required_models
                and declared_phases.get(contract, set()).issubset({"input"})):
                continue
            name, capability = _DECLARED_DEDICATED_CONTRACTS[contract]
            provider = self._providers.get((name, "1.0.0"))
            if provider is None or capability not in provider.capabilities:
                missing_dedicated.append(contract)
            elif not declared_phases.get(contract, set()).issubset(provider.rails):
                missing_dedicated.append(f"{contract} ({', '.join(sorted(declared_phases[contract] - provider.rails))})")
        if missing_dedicated:
            raise PlanCompilationError(
                "Declared dedicated Evaluator Bindings are unavailable for: "
                + ", ".join(sorted(set(missing_dedicated))) + "."
            )
        unmapped_contracts = tuple(
            binding
            for binding in config.action_bindings
            if binding.action_name == ACTION_EVALUATE
            and any((binding.capability, binding.contract_ref, phase) not in route_rail_keys for phase in binding.phases)
        )
        if unmapped_contracts:
            details = ", ".join(
                f"{item.capability} -> {item.contract_ref} ({', '.join(item.phases)})"
                for item in unmapped_contracts
            )
            raise PlanCompilationError(
                "No Evaluator Binding is available for: " + details + "."
            )

    def _providers_for(self, config: NeMoConfigSnapshot) -> ActionProviders:
        """Scope name-based NeMo registration to artifact-pinned providers."""
        references = {
            (name, version)
            for name, version in _action_references(config)
            if name not in _EXECUTOR_ACTION_VERSIONS
        }
        if "sensitive_data_detection" in config.required_features:
            references.add((ACTION_EVALUATE, "1.0.0"))
        return action_providers(
            *(
                self._providers[(name, version)]
                for name, version in sorted(references)
            )
        )


def _action_references(
    config: NeMoConfigSnapshot,
) -> set[tuple[str, str]]:
    references = {
        (binding.action_name, binding.action_version)
        for binding in config.action_bindings
        if binding.action_name and binding.action_version
    }
    references.update(
        (name, version)
        for kind, name, version in config.dependency_manifest
        if kind == "action" and name and version
    )
    return references


def _enabled(value: object) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in {"1", "on", "true", "yes"}
    return value is True or value == 1
