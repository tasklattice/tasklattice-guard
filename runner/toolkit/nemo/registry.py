from __future__ import annotations

import asyncio
import logging
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Literal, Protocol

import yaml
from nemoguardrails import Guardrails, RailsConfig

from ..compiler.domain import PlanCompilationError
from ..runtime.contracts import GuardrailPlanSnapshot, NeMoConfigSnapshot
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


logger = logging.getLogger("uvicorn.error.tasklattice.nemo.registry")


_PROFILE_RUNTIME = {
    "iorails_native": ("iorails", "1.0"),
    "llmrails_colang1_standard": ("llmrails", "1.0"),
    "llmrails_colang2_programmable": ("llmrails", "2.x"),
}
_EXECUTOR_ACTION_VERSIONS = {
    ACTION_CUSTOMER_IDENTIFIER: "1.0.0",
    ACTION_RECORD_POLICY: "1.0.0",
    ACTION_RECORD_NATIVE: "1.0.0",
    ACTION_RESOLVE: "1.0.0",
}


class NeMoConfigStore(Protocol):
    def plan(self, guardrail_id: str, version: int) -> GuardrailPlanSnapshot: ...

    def nemo_config(self, guardrail_id: str, version: int) -> NeMoConfigSnapshot: ...

    def active_plan_keys(self) -> tuple[tuple[str, int], ...]: ...


@dataclass(slots=True)
class NeMoRuntimeInstance:
    config: NeMoConfigSnapshot
    plan: GuardrailPlanSnapshot
    rails: Guardrails
    admission: asyncio.BoundedSemaphore
    active_requests: int = 0
    waiting_requests: int = 0


class NeMoRuntimeRegistry:
    """Prewarmed, version-isolated NeMo Runtime registry."""

    def __init__(
        self,
        store: NeMoConfigStore,
        providers: ActionProviders,
        *,
        max_entries: int = 128,
        max_concurrency_per_guardrail: int = 64,
        execution_surface: Literal[
            "standalone_check", "owned_generation"
        ] = "standalone_check",
    ) -> None:
        self._store = store
        self._providers = providers
        self._max_entries = max(1, max_entries)
        self._max_concurrency_per_guardrail = max(1, max_concurrency_per_guardrail)
        self._execution_surface = execution_surface
        self._items: OrderedDict[tuple[str, int, str], NeMoRuntimeInstance] = OrderedDict()
        self._retired: list[Guardrails] = []
        self._lock = threading.RLock()
        self._hits = 0
        self._misses = 0
        self._last_missing_versions: tuple[tuple[str, int], ...] | None = None
        self.reload()

    def get(self, plan: GuardrailPlanSnapshot) -> NeMoRuntimeInstance:
        return self.acquire(plan)[0]

    def acquire(
        self, plan: GuardrailPlanSnapshot
    ) -> tuple[NeMoRuntimeInstance, bool, int]:
        config = self._store.nemo_config(plan.guardrail_id, plan.guardrail_version)
        key = (plan.guardrail_id, plan.guardrail_version, config_checksum(config))
        waiting_started = time.perf_counter()
        with self._lock:
            queue_latency_ms = max(
                0, round((time.perf_counter() - waiting_started) * 1_000)
            )
            item = self._items.get(key)
            if item is not None:
                self._hits += 1
                self._items.move_to_end(key)
                return item, True, queue_latency_ms
            self._misses += 1
            return self._build_with_logging(plan, config, key), False, queue_latency_ms

    def validate(
        self, plan: GuardrailPlanSnapshot, config: NeMoConfigSnapshot
    ) -> None:
        key = (plan.guardrail_id, plan.guardrail_version, config_checksum(config))
        with self._lock:
            if key not in self._items:
                self._build_with_logging(plan, config, key)

    def reload(self) -> None:
        active = tuple(sorted(set(self._store.active_plan_keys())))
        started = time.perf_counter()
        before = self.stats()["entries"]
        logger.info("Synchronizing %d active NeMo Guardrail Version(s).", len(active))
        try:
            with self._lock:
                for guardrail_id, version in active:
                    self.get(self._store.plan(guardrail_id, version))
        except Exception:
            logger.exception("NeMo runtime synchronization failed.")
            raise
        duration_ms = max(0, round((time.perf_counter() - started) * 1_000))
        after = self.stats()["entries"]
        logger.info(
            "NeMo runtime synchronization completed: active=%d newly_prewarmed=%d duration_ms=%d.",
            len(active),
            max(0, after - before),
            duration_ms,
        )
        self.readiness()

    def replace_providers(
        self,
        providers: ActionProviders,
        candidates: tuple[tuple[GuardrailPlanSnapshot, NeMoConfigSnapshot], ...],
    ) -> None:
        """Prewarm against a new registry, then swap it in as one atomic unit."""

        with self._lock:
            previous_providers = self._providers
            previous_items = self._items
            previous_retired = list(self._retired)
            self._providers = providers
            self._items = OrderedDict()
            try:
                for plan, config in candidates:
                    key = (plan.guardrail_id, plan.guardrail_version, config_checksum(config))
                    self._build_with_logging(plan, config, key)
                self.readiness()
            except Exception:
                rejected = [item.rails for item in self._items.values()]
                self._providers = previous_providers
                self._items = previous_items
                self._retired = [*previous_retired, *rejected]
                raise
            self._retired = [
                *previous_retired,
                *(item.rails for item in previous_items.values()),
            ]

    def stats(self) -> dict[str, int]:
        with self._lock:
            return {
                "entries": len(self._items),
                "retired": len(self._retired),
                "hits": self._hits,
                "misses": self._misses,
            }

    def admission_load(self) -> tuple[int, int, int]:
        """Return aggregate active, waiting, and available admission slots."""
        with self._lock:
            active_keys = set(self._store.active_plan_keys())
            draining_inactive = sum(
                1
                for key, item in self._items.items()
                if key[:2] not in active_keys and (item.active_requests or item.waiting_requests)
            )
            return (
                sum(item.active_requests for item in self._items.values()),
                sum(item.waiting_requests for item in self._items.values()),
                max(1, len(active_keys) + draining_inactive) * self._max_concurrency_per_guardrail,
            )

    def ready(self) -> bool:
        return bool(self.readiness()["ready"])

    def readiness(self) -> dict[str, object]:
        with self._lock:
            active = set(self._store.active_plan_keys())
            available = {key[:2] for key in self._items}
            missing = tuple(sorted(active - available))
            if missing != self._last_missing_versions:
                if missing:
                    logger.warning(
                        "NeMo registry is not ready: active=%d prewarmed_active=%d missing=%s.",
                        len(active),
                        len(active & available),
                        ",".join(f"{guardrail_id}@{version}" for guardrail_id, version in missing),
                    )
                else:
                    logger.info(
                        "NeMo registry is ready: active=%d prewarmed_active=%d.",
                        len(active),
                        len(active & available),
                    )
                self._last_missing_versions = missing
            return {
                "ready": not missing,
                "status": "ready" if not missing else "not_ready",
                "reason": (
                    "all_active_guardrail_versions_prewarmed"
                    if not missing
                    else "missing_prewarmed_guardrail_versions"
                ),
                "active_versions": len(active),
                "prewarmed_active_versions": len(active & available),
                "missing_versions": [
                    {
                        "guardrail_id": guardrail_id,
                        "guardrail_version": version,
                    }
                    for guardrail_id, version in missing
                ],
            }

    async def shutdown(self) -> None:
        with self._lock:
            rails = (
                *(item.rails for item in self._items.values()),
                *self._retired,
            )
            self._items.clear()
            self._retired.clear()
        await asyncio.gather(
            *(item.shutdown() for item in rails), return_exceptions=True
        )

    def _build(
        self,
        plan: GuardrailPlanSnapshot,
        config: NeMoConfigSnapshot,
        key: tuple[str, int, str],
    ) -> NeMoRuntimeInstance:
        from .runtime import NeMoActionBridge

        self._validate_runtime_profile(config)
        self._validate_bindings(config)
        rails_config = RailsConfig.from_content(
            yaml_content=config.config_yaml,
            colang_content=config.colang_content or None,
        )
        use_iorails = config.runtime_profile == "iorails_native"
        rails = Guardrails(
            rails_config,
            use_iorails=use_iorails,
            require_iorails=use_iorails,
        )
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
        )
        self._items[key] = item
        self._items.move_to_end(key)
        active = set(self._store.active_plan_keys())
        while len(self._items) > self._max_entries:
            candidate = next(iter(self._items))
            if candidate[:2] in active:
                self._items.move_to_end(candidate)
                if all(item_key[:2] in active for item_key in self._items):
                    break
                continue
            retired = self._items.pop(candidate)
            self._retired.append(retired.rails)
        return item

    def _build_with_logging(
        self,
        plan: GuardrailPlanSnapshot,
        config: NeMoConfigSnapshot,
        key: tuple[str, int, str],
    ) -> NeMoRuntimeInstance:
        started = time.perf_counter()
        logger.info(
            "Prewarming NeMo runtime: guardrail_id=%s version=%d profile=%s.",
            plan.guardrail_id,
            plan.guardrail_version,
            config.runtime_profile,
        )
        try:
            item = self._build(plan, config, key)
        except Exception:
            logger.exception(
                "NeMo runtime prewarm failed: guardrail_id=%s version=%d profile=%s.",
                plan.guardrail_id,
                plan.guardrail_version,
                config.runtime_profile,
            )
            raise
        logger.info(
            "NeMo runtime prewarm completed: guardrail_id=%s version=%d duration_ms=%d.",
            plan.guardrail_id,
            plan.guardrail_version,
            max(0, round((time.perf_counter() - started) * 1_000)),
        )
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
            if self._execution_surface != "owned_generation":
                raise PlanCompilationError(
                    "The iorails_native profile requires an owned-generation host; "
                    "publish a new llmrails_colang1_standard version before using "
                    "the standalone check service."
                )
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
                "NeMo 0.23 requires tracing to be disabled for the "
                "llmrails_colang2_programmable profile."
            )
        if config.runtime_profile != "iorails_native" and metrics_enabled:
            raise PlanCompilationError(
                f"NeMo 0.23 requires metrics to be disabled for the "
                f"{config.runtime_profile} profile."
            )

    def _validate_bindings(self, config: NeMoConfigSnapshot) -> None:
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
        unmapped_contracts = tuple(
            binding
            for binding in config.action_bindings
            if binding.action_name == ACTION_EVALUATE
            and (binding.capability, binding.contract_ref) not in route_keys
        )
        if unmapped_contracts:
            details = ", ".join(
                f"{item.capability} -> {item.contract_ref}"
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
