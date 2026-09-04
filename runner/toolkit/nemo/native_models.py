from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

import yaml


TOPIC_CONTROL_MODEL_TYPE = "topic_control"
TOPIC_CONTROL_PROFILE = "tali.nemoguard-topic-control.v1"


@dataclass(frozen=True, slots=True)
class NativeRailModel:
    """A Controller model assignment materialized for an official NeMo rail."""

    type: str
    profile_ref: str
    runtime_id: str
    model: str
    base_url: str
    api_key: str
    timeout_seconds: float
    max_tokens: int

    def __post_init__(self) -> None:
        if not self.type.strip() or not self.runtime_id.strip() or not self.model.strip():
            raise ValueError("Native Rail model identity cannot be empty.")
        if not self.base_url.startswith(("http://", "https://")):
            raise ValueError("Native Rail models require an HTTP(S) base_url.")
        if self.timeout_seconds <= 0 or self.max_tokens <= 0:
            raise ValueError("Native Rail model timeout and max_tokens must be positive.")

    def compiler_config(self) -> dict[str, Any]:
        """Return a secret-free model declaration suitable for a signed artifact."""

        return {
            "type": self.type,
            "engine": "openai",
            "model": f"__tasklattice_runtime__:{self.type}",
        }

    def runtime_config(self) -> dict[str, Any]:
        parameters: dict[str, Any] = {
            "base_url": self.base_url.rstrip("/"),
            "timeout": self.timeout_seconds,
            "max_tokens": self.max_tokens,
            # LLMRails consumes api_key; IORails intentionally accepts auth via
            # the 0.24 default_headers model parameter.
            "api_key": self.api_key or None,
        }
        if self.api_key:
            parameters["default_headers"] = {
                "Authorization": f"Bearer {self.api_key}",
            }
        return {
            "type": self.type,
            "engine": "openai",
            "model": self.model,
            "parameters": parameters,
        }


def native_rail_models(
    configuration: object,
    credentials: dict[str, str],
) -> tuple[NativeRailModel, ...]:
    """Select only model profiles that are safe to hand to standard NeMo rails."""

    runtimes = {item.id: item for item in configuration.runtimes}
    assignment = next(
        (
            item
            for item in configuration.assignments
            if item.role == "topic_policy_judge"
        ),
        None,
    )
    if assignment is None or assignment.profile_ref != TOPIC_CONTROL_PROFILE:
        return ()
    try:
        runtime = runtimes[assignment.model_ref]
    except KeyError as error:
        raise ValueError(
            "Topic Control assignment references unavailable Model Runtime "
            f"{assignment.model_ref!r}."
        ) from error
    if runtime.profile_ref != TOPIC_CONTROL_PROFILE:
        raise ValueError(
            "Topic Control assignment and Model Runtime profiles must both be "
            f"{TOPIC_CONTROL_PROFILE!r}."
        )
    # NeMo 0.24's IORails HTTP engine does not expose a per-model TLS bypass.
    # Keep this revision on the existing custom provider rather than silently
    # weakening or changing its transport semantics.
    if runtime.skip_tls_verify:
        return ()
    if runtime.credential_ref and not credentials.get(runtime.credential_ref):
        raise ValueError(
            f"Credential {runtime.credential_ref!r} is unavailable for the dedicated "
            "Topic Control Model Runtime."
        )
    return (
        NativeRailModel(
            type=TOPIC_CONTROL_MODEL_TYPE,
            profile_ref=TOPIC_CONTROL_PROFILE,
            runtime_id=runtime.id,
            model=runtime.model,
            base_url=runtime.base_url,
            api_key=credentials.get(runtime.credential_ref, ""),
            timeout_seconds=float(runtime.timeout_seconds or 20),
            max_tokens=int(runtime.max_tokens or 128),
        ),
    )


def compiler_model_configs(
    models: Iterable[NativeRailModel],
) -> tuple[dict[str, Any], ...]:
    return tuple(item.compiler_config() for item in models)


def materialize_model_configs(
    config_yaml: str,
    required_models: Iterable[str],
    models: Iterable[NativeRailModel],
) -> str:
    """Inject live endpoints and leased credentials into an artifact in memory."""

    required = frozenset(required_models)
    if not required:
        return config_yaml
    available = {item.type: item for item in models}
    missing = required - available.keys()
    if missing:
        raise ValueError(
            "Active NeMo artifact requires unavailable native model assignments: "
            + ", ".join(sorted(missing))
            + "."
        )
    payload = yaml.safe_load(config_yaml) or {}
    if not isinstance(payload, dict):
        raise ValueError("Compiled NeMo configuration YAML must contain a mapping.")
    configured = payload.get("models", [])
    if not isinstance(configured, list):
        raise ValueError("Compiled NeMo models configuration must contain a list.")
    configured_types = {
        str(item.get("type", ""))
        for item in configured
        if isinstance(item, dict)
    }
    undeclared = required - configured_types
    if undeclared:
        raise ValueError(
            "Native model dependencies are missing from the signed artifact: "
            + ", ".join(sorted(undeclared))
            + "."
        )
    payload["models"] = [
        available[str(item.get("type"))].runtime_config()
        if isinstance(item, dict) and str(item.get("type")) in required
        else item
        for item in configured
    ]
    return yaml.safe_dump(payload, allow_unicode=True, sort_keys=False)
