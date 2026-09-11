from __future__ import annotations

import fnmatch
import hashlib
import hmac
import importlib.metadata
import json
import logging
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from runner.toolkit.nemo.registry import NeMoRuntimeRegistry
from runner.toolkit.nemo.action_registry import ActionProviders
from runner.toolkit.nemo.native_models import NativeRailModel
from runner.toolkit.runtime.contracts import (
    GuardrailPlanSnapshot,
    NeMoConfigSnapshot,
    PlanResolution,
    RequestContext,
    RuntimeTraceStep,
)

from . import generated as protocol
from .artifact_config import config_snapshot_from_artifact
from .protocol_codec import (
    artifact_content,
    endpoint_verification_from_proto,
    traffic_scope_from_proto,
)
from .serialization import plan_from_dict
from .routing import RoutingError, select, validate_router


logger = logging.getLogger("tasklattice.guard.runner.artifact_store")


@dataclass(frozen=True, slots=True)
class RuntimeArtifact:
    artifact_id: str
    generation: int
    checksum: str
    plan: GuardrailPlanSnapshot
    config: NeMoConfigSnapshot


@dataclass(frozen=True, slots=True)
class RouterRoute:
    router_id: str
    guardrail_id: str
    artifact_id: str
    endpoint_id: str | None
    route_order: int
    traffic_scope: dict[str, Any]


class ArtifactStore:
    """Atomic, last-known-good desired-state store owned only by the Runner."""

    def __init__(self, public_key_path: Path, state_path: Path) -> None:
        key = serialization.load_pem_public_key(public_key_path.read_bytes())
        if not isinstance(key, Ed25519PublicKey):
            raise ValueError("GUARD_ARTIFACT_PUBLIC_KEY_PATH must contain an Ed25519 public key.")
        self._public_key = key
        self._nemo_version = importlib.metadata.version("nemoguardrails")
        self._state_path = state_path
        self._lock = threading.RLock()
        # Serialize writers without holding the reader lock during NeMo work.
        self._apply_lock = threading.Lock()
        self._registry: NeMoRuntimeRegistry | None = None
        self._generation = 0
        self._release_id: str | None = None
        self._model_revision_id: str | None = None
        self._artifacts: dict[str, RuntimeArtifact] = {}
        self._routes: tuple[RouterRoute, ...] = ()
        self._router_revisions: dict[str, Any] = {}
        self._endpoints: dict[str, dict[str, Any]] = {}
        self._logging_levels: dict[str, str] = {}
        self._persisted_state: protocol.DesiredState | None = self._read_snapshot()

    def attach_registry(self, registry: NeMoRuntimeRegistry) -> None:
        self._registry = registry
        if self._persisted_state is not None:
            try:
                self.apply(self._persisted_state, persist=False)
            except Exception:
                logger.warning(
                    "Last-known-good state could not be restored; Runner will stay "
                    "unready until the Controller synchronizes current desired state.",
                    exc_info=True,
                )
            self._persisted_state = None

    @property
    def generation(self) -> int:
        with self._lock:
            return self._generation

    def observability_counts(self) -> tuple[int, int, int]:
        """Return loaded artifact, router-route, and Endpoint counts."""
        with self._lock:
            return len(self._artifacts), len(self._routes), len(self._endpoints)

    def plan(self, guardrail_id: str, version: str) -> GuardrailPlanSnapshot:
        with self._lock:
            return next(
                artifact.plan
                for artifact in self._artifacts.values()
                if artifact.plan.guardrail_id == guardrail_id
                and artifact.plan.guardrail_version == version
            )

    def nemo_config(self, guardrail_id: str, version: str) -> NeMoConfigSnapshot:
        with self._lock:
            return next(
                artifact.config
                for artifact in self._artifacts.values()
                if artifact.config.guardrail_id == guardrail_id
                and artifact.config.guardrail_version == version
            )

    def active_plan_keys(self) -> tuple[tuple[str, str], ...]:
        with self._lock:
            active_artifact_ids = {route.artifact_id for route in self._routes}
            active_artifact_ids.update(t.artifact_id for r in self._router_revisions.values() for route in r.routes for t in route.targets if t.weight_bps)
            return tuple(
                (artifact.plan.guardrail_id, artifact.plan.guardrail_version)
                for artifact_id, artifact in self._artifacts.items()
                if artifact_id in active_artifact_ids
            )

    def composed_endpoint(self, endpoint_id: str | None) -> bool:
        with self._lock:
            return bool(self._router_revisions) or bool(self._endpoints.get(endpoint_id, {}).get("_router_id"))

    def resolve(self, context: RequestContext) -> PlanResolution:
        with self._lock:
            endpoint = self._endpoints.get(context.endpoint_id, {})
            router_id = endpoint.get("_router_id")
            if self._router_revisions or router_id:
                router = self._router_revisions.get(router_id)
                if router is None:
                    raise RoutingError("endpoint_router_unavailable")
                target, assignment = select(router, context)
                artifact = self._artifacts.get(target.artifact_id)
                if artifact is None:
                    raise RoutingError("target_unavailable", assignment)
                return PlanResolution(plan=artifact.plan, router_id=router.router_id,
                    endpoint_id=context.endpoint_id, effective_release_id=self._release_id,
                    model_revision_id=self._model_revision_id, route_assignment=assignment)
            # Legacy snapshots are only accessible to internal/test callers;
            # an unbound authenticated Endpoint never inherits a global Router.
            if context.endpoint_id in self._endpoints:
                raise RoutingError("endpoint_router_unavailable")
            candidates = tuple(
                route
                for route in self._routes
                if route.endpoint_id == context.endpoint_id
                and _scope_matches(route.traffic_scope, context)
            ) or tuple(route for route in self._routes if route.endpoint_id is None)
            candidates = tuple(route for route in candidates if _scope_matches(route.traffic_scope, context))
            if not candidates:
                raise LookupError("No active Runner router matches this request.")
            route = min(candidates, key=lambda item: (
                -_scope_specificity(item.traffic_scope)[0],
                -_scope_specificity(item.traffic_scope)[1],
                item.route_order,
                item.router_id,
            ))
            artifact = self._artifacts[route.artifact_id]
            return PlanResolution(
                plan=artifact.plan,
                effective_release_id=self._release_id,
                model_revision_id=self._model_revision_id,
                router_id=route.router_id,
                endpoint_id=route.endpoint_id,
                trace=(RuntimeTraceStep(
                    id=f"router:{route.router_id}",
                    kind="router",
                    name=route.router_id,
                    status="selected",
                    detail=f"Runner selected immutable Artifact {route.artifact_id}.",
                    guardrail_id=artifact.plan.guardrail_id,
                    guardrail_version=artifact.plan.guardrail_version,
                ),),
            )

    def resolve_guardrail(self, guardrail_id: str, version: str) -> PlanResolution:
        """Resolve an explicit immutable version for Controller-owned tools such as Playground."""
        with self._lock:
            artifact = next(
                (
                    item
                    for item in self._artifacts.values()
                    if item.plan.guardrail_id == guardrail_id
                    and item.plan.guardrail_version == version
                ),
                None,
            )
            if artifact is None:
                raise LookupError(f"Guardrail {guardrail_id}@{version} is not available on this Runner.")
            route = next(
                (item for item in self._routes if item.artifact_id == artifact.artifact_id),
                None,
            )
            router_id = route.router_id if route else f"playground:{guardrail_id}:{version}"
            return PlanResolution(
                plan=artifact.plan,
                effective_release_id=self._release_id,
                model_revision_id=self._model_revision_id,
                router_id=router_id,
                endpoint_id=None,
                trace=(RuntimeTraceStep(
                    id=f"router:{router_id}",
                    kind="router",
                    name=router_id,
                    status="selected",
                    detail=f"Controller selected immutable Artifact {artifact.artifact_id} for Playground.",
                    guardrail_id=artifact.plan.guardrail_id,
                    guardrail_version=artifact.plan.guardrail_version,
                ),),
            )

    def authenticate_endpoint(self, endpoint_id: str, credential: str | None) -> bool:
        if not credential:
            return False
        with self._lock:
            endpoint = self._endpoints.get(endpoint_id)
        if not endpoint:
            return False
        expected_digests: list[str] = []
        credentials = endpoint.get("credentials")
        if isinstance(credentials, list):
            for item in credentials:
                if not isinstance(item, dict):
                    continue
                if item.get("revokedAt") is not None:
                    continue
                digest = item.get("sha256")
                if isinstance(digest, str):
                    expected_digests.append(digest)
        actual = hashlib.sha256(credential.encode()).hexdigest()
        authenticated = False
        for expected in expected_digests:
            authenticated = hmac.compare_digest(actual, expected) or authenticated
        return authenticated

    def endpoint_adapter(self, endpoint_id: str) -> str | None:
        with self._lock:
            endpoint = self._endpoints.get(endpoint_id)
            adapter = endpoint.get("_adapter") if endpoint else None
        return adapter if isinstance(adapter, str) else None

    def logging_level(self, guardrail_id: str | None) -> str:
        if guardrail_id is None:
            return "info"
        with self._lock:
            value = self._logging_levels.get(guardrail_id, "info")
        return value if value in {"info", "debug", "trace"} else "info"

    def retain_release(self, release_id: str | None) -> None:
        if release_id and self._registry:
            self._registry.retain_release(release_id)

    def apply(
        self,
        desired_state: Any,
        *,
        persist: bool = True,
        providers: ActionProviders | None = None,
        native_models: tuple[NativeRailModel, ...] | None = None,
    ) -> None:
        with self._apply_lock:
            self._apply(desired_state, persist=persist, providers=providers, native_models=native_models)

    def _apply(
        self,
        desired_state: Any,
        *,
        persist: bool,
        providers: ActionProviders | None,
        native_models: tuple[NativeRailModel, ...] | None,
    ) -> None:
        generation = int(desired_state.generation)
        with self._lock:
            if generation < self._generation:
                return
        staged = {
            message.artifact_id: self._artifact_from_message(message)
            for message in desired_state.artifacts
        }
        routes = tuple(
            RouterRoute(
                router_id=item.router_id,
                guardrail_id=item.guardrail_id,
                artifact_id=item.artifact_id,
                endpoint_id=item.endpoint_id or None,
                route_order=item.route_order,
                traffic_scope=traffic_scope_from_proto(item.traffic_scope),
            )
            for item in desired_state.routers
        )
        router_revisions = {}
        for item in desired_state.router_revisions:
            if item.router_id in router_revisions: raise ValueError("Duplicate Router ID.")
            validate_router(item, staged)
            snapshot = protocol.RouterRevision()
            snapshot.CopyFrom(item)
            router_revisions[item.router_id] = snapshot
        missing = {route.artifact_id for route in routes} - set(staged)
        if missing:
            raise ValueError("Desired state references unavailable Artifacts: " + ", ".join(sorted(missing)))
        endpoints: dict[str, dict[str, Any]] = {}
        for item in desired_state.endpoints:
            verification = endpoint_verification_from_proto(item.verification)
            endpoints[item.endpoint_id] = {**verification, "_adapter": item.adapter, "_router_id": item.router_id}
        registry = self._registry
        if registry is None:
            raise RuntimeError("NeMo Runtime Registry is not attached.")
        if providers is None and native_models is None:
            for artifact in staged.values():
                registry.validate(artifact.plan, artifact.config)
        else:
            if providers is None:
                raise ValueError(
                    "Native model configuration must be swapped with a complete Action provider registry."
                )
            registry.replace_providers(
                providers,
                tuple((artifact.plan, artifact.config) for artifact in staged.values()),
                native_models,
            )
        candidates = tuple((artifact.plan, artifact.config) for artifact in staged.values())
        release_id = hashlib.sha256(
            str(generation).encode() + b":"
            + desired_state.model_configuration.SerializeToString(deterministic=True)
            + ":".join(sorted(artifact.checksum for artifact in staged.values())).encode()
        ).hexdigest()
        # Publish materialized instances before exposing their routing identity.
        # Registry observers acquire registry -> store; never take those locks
        # in the reverse order here. Existing requests keep their old release.
        registry.publish_release(release_id, candidates)
        with self._lock:
            self._artifacts = staged
            self._routes = routes
            self._router_revisions = router_revisions
            self._endpoints = endpoints
            self._logging_levels = dict(desired_state.guardrail_logging_levels)
            self._generation = generation
            self._release_id = release_id
            self._model_revision_id = desired_state.model_configuration.revision_id or None
            if persist:
                self._persist_snapshot(desired_state)
        if providers is None and native_models is None:
            registry.reload()
        else:
            registry.readiness()

    def _artifact_from_message(self, message: Any) -> RuntimeArtifact:
        content = artifact_content(message)
        canonical = _stable_json(content)
        checksum = hashlib.sha256(canonical.encode()).hexdigest()
        if not hmac.compare_digest(checksum, message.checksum):
            raise ValueError(f"Artifact {message.artifact_id} checksum does not match its content.")
        self._public_key.verify(_base64(message.signature), checksum.encode())
        if message.nemo_version != self._nemo_version:
            raise ValueError(
                f"Artifact {message.artifact_id} targets NeMo Guardrails "
                f"{message.nemo_version!r}; this Runner requires "
                f"{self._nemo_version!r}. Recompile the Guardrail before router."
            )
        plan_payload = content["plan"]
        return RuntimeArtifact(
            artifact_id=message.artifact_id,
            generation=int(message.generation),
            checksum=checksum,
            plan=plan_from_dict(plan_payload),
            config=config_snapshot_from_artifact(
                message,
                verified_content=content,
            ),
        )

    def _persist_snapshot(self, desired_state: Any) -> None:
        self._state_path.mkdir(parents=True, exist_ok=True)
        target = self._state_path / "last-known-good.json"
        temporary = self._state_path / "last-known-good.json.tmp"
        temporary.write_text(
            json.dumps({
                "generation": self._generation,
                "desired_state_b64": _encode_base64(desired_state.SerializeToString()),
            }, sort_keys=True),
            encoding="utf-8",
        )
        temporary.replace(target)

    def _read_snapshot(self) -> protocol.DesiredState | None:
        target = self._state_path / "last-known-good.json"
        if not target.exists():
            return None
        payload = json.loads(target.read_text(encoding="utf-8"))
        encoded = payload.get("desired_state_b64")
        if not isinstance(encoded, str) or not encoded:
            raise ValueError("Runner last-known-good snapshot is incomplete.")
        desired_state = protocol.DesiredState()
        desired_state.ParseFromString(_base64(encoded))
        if int(desired_state.generation) != int(payload.get("generation", -1)):
            raise ValueError("Runner last-known-good generation does not match its payload.")
        return desired_state


def _stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _base64(value: str) -> bytes:
    import base64
    return base64.b64decode(value, validate=True)


def _encode_base64(value: bytes) -> str:
    import base64
    return base64.b64encode(value).decode("ascii")


def _scope_matches(scope: dict[str, Any], context: RequestContext) -> bool:
    conditions = scope.get("conditions", ())
    if not conditions:
        return True
    values = [
        _scope_matches(item, context) if isinstance(item, dict) and "conditions" in item
        else _condition_matches(item, context)
        for item in conditions
    ]
    return all(values) if scope.get("combinator", "and") == "and" else any(values)


def _condition_matches(condition: Any, context: RequestContext) -> bool:
    if not isinstance(condition, dict):
        return False
    field = str(condition.get("field", ""))
    key = str(condition.get("key", ""))
    if field == "protocol":
        actual = context.protocol
    elif field == "endpoint.id":
        actual = context.endpoint_id
    elif field == "http.header":
        actual = context.value("header", key)
    elif field == "auth.jwt_claim":
        actual = context.value("jwt_claim", key)
    elif field == "adapter.field":
        actual = context.value("field", key)
    else:
        actual = context.value("field", field)
    if actual is None:
        return False
    expected = str(condition.get("value", ""))
    operator = condition.get("operator", "equals")
    if operator == "equals":
        return actual == expected
    if operator == "contains":
        return expected in actual
    if operator == "starts_with":
        return actual.startswith(expected)
    if operator == "glob":
        return fnmatch.fnmatchcase(actual, expected)
    return False


def _scope_specificity(scope: dict[str, Any]) -> tuple[int, int]:
    weights = {"equals": 4, "starts_with": 3, "contains": 2, "glob": 1}
    conditions = scope.get("conditions", ())
    if not conditions:
        return (0, 0)
    children = [
        _scope_specificity(item) if isinstance(item, dict) and "conditions" in item
        else (1, weights.get(str(item.get("operator", "")), 0))
        for item in conditions
        if isinstance(item, dict)
    ]
    if not children:
        return (0, 0)
    if scope.get("combinator", "and") == "and":
        return (sum(item[0] for item in children), sum(item[1] for item in children))
    return min(children)
