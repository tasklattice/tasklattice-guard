from __future__ import annotations

import os
import socket
import base64
import json
from dataclasses import dataclass
from pathlib import Path

from runner.toolkit.safety.providers import (
    EvaluatorBindingConfig,
    ModelRuntimeConfig,
    resolve_evaluator_model_providers,
)


def _boolean(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "true" if default else "false").strip().casefold()
    if raw not in {"1", "0", "true", "false", "yes", "no", "on", "off"}:
        raise ValueError(f"{name} must be a boolean.")
    return raw in {"1", "true", "yes", "on"}


def _positive_int(name: str, default: int) -> int:
    value = int(os.environ.get(name, str(default)))
    if value <= 0:
        raise ValueError(f"{name} must be positive.")
    return value


def _ratio(name: str, default: float, fallback_name: str | None = None) -> float:
    raw = os.environ.get(name)
    if raw is None and fallback_name is not None:
        raw = os.environ.get(fallback_name)
    value = float(raw if raw is not None else default)
    if not 0 <= value <= 1:
        raise ValueError(f"{name} must be between 0 and 1.")
    return value


@dataclass(frozen=True, slots=True)
class RunnerSettings:
    runner_id: str
    pool_id: str
    controller_target: str
    controller_token: str
    metrics_token: str | None
    artifact_public_key_path: Path
    artifact_state_path: Path
    compiler_capable: bool
    max_concurrency: int
    controller_ca_path: Path | None
    client_certificate_path: Path | None
    client_key_path: Path | None
    telemetry_endpoint: str
    telemetry_batch_size: int
    call_context_redis_url: str | None
    model_runtimes: tuple[ModelRuntimeConfig, ...]
    evaluator_bindings: tuple[EvaluatorBindingConfig, ...]
    automated_reasoning_endpoint_url: str | None
    automated_reasoning_api_key_env_var: str
    runtime_log_encryption_key: bytes | None
    otel_exporter_otlp_endpoint: str | None = None
    otel_trace_sample_ratio: float = 0.1
    pyroscope_server_address: str | None = None
    pyroscope_sample_rate: int = 100

    @classmethod
    def from_env(cls) -> "RunnerSettings":
        pool_id = os.environ.get("GUARD_RUNNER_POOL_ID", "default").strip()
        runner_id = os.environ.get("GUARD_RUNNER_ID", socket.gethostname()).strip()
        token = os.environ.get("GUARD_CONTROLLER_TOKEN", "")
        metrics_token = os.environ.get("GUARD_METRICS_TOKEN", "").strip()
        public_key = os.environ.get("GUARD_ARTIFACT_PUBLIC_KEY_PATH", "").strip()
        if not runner_id or not pool_id:
            raise ValueError("GUARD_RUNNER_ID and GUARD_RUNNER_POOL_ID cannot be empty.")
        if len(token) < 32:
            raise ValueError("GUARD_CONTROLLER_TOKEN must contain at least 32 characters.")
        if metrics_token and len(metrics_token) < 32:
            raise ValueError("GUARD_METRICS_TOKEN must contain at least 32 characters when configured.")
        if not public_key:
            raise ValueError("GUARD_ARTIFACT_PUBLIC_KEY_PATH is required.")
        target = os.environ.get("GUARD_CONTROLLER_TARGET", "tali-guard-controller:9090").strip()
        if not target:
            raise ValueError("GUARD_CONTROLLER_TARGET cannot be empty.")
        controller_ca = os.environ.get("GUARD_CONTROLLER_CA_PATH", "").strip()
        client_certificate = os.environ.get("GUARD_RUNNER_CLIENT_CERT_PATH", "").strip()
        client_key = os.environ.get("GUARD_RUNNER_CLIENT_KEY_PATH", "").strip()
        tls_values = (controller_ca, client_certificate, client_key)
        if any(tls_values) and not all(tls_values):
            raise ValueError(
                "GUARD_CONTROLLER_CA_PATH, GUARD_RUNNER_CLIENT_CERT_PATH, and "
                "GUARD_RUNNER_CLIENT_KEY_PATH must be configured together."
            )
        if all(tls_values) and not metrics_token:
            raise ValueError("GUARD_METRICS_TOKEN is required with production control-channel mTLS.")
        model_runtimes = _model_runtimes(
            os.environ.get("MODEL_GUARDRAILS_MODEL_RUNTIMES_JSON", "")
        )
        evaluator_bindings = _evaluator_bindings(
            os.environ.get("MODEL_GUARDRAILS_EVALUATOR_BINDINGS_JSON", "")
        )
        # Validate every binding/profile reference before the runtime starts.
        resolve_evaluator_model_providers(model_runtimes, evaluator_bindings)
        for runtime in model_runtimes:
            if runtime.api_key_env_var and not os.environ.get(
                runtime.api_key_env_var, ""
            ).strip():
                raise ValueError(
                    f"{runtime.api_key_env_var} is required by Model Runtime "
                    f"{runtime.id!r}."
                )
        runtime_log_key_value = os.environ.get(
            "MODEL_GUARDRAILS_RUNTIME_LOG_ENCRYPTION_KEY", ""
        ).strip()
        runtime_log_encryption_key = None
        if runtime_log_key_value:
            try:
                runtime_log_encryption_key = base64.b64decode(
                    runtime_log_key_value, validate=True
                )
            except ValueError as error:
                raise ValueError(
                    "MODEL_GUARDRAILS_RUNTIME_LOG_ENCRYPTION_KEY must be valid base64."
                ) from error
            if len(runtime_log_encryption_key) != 32:
                raise ValueError(
                    "MODEL_GUARDRAILS_RUNTIME_LOG_ENCRYPTION_KEY must decode to 32 bytes."
                )
        automated_reasoning_endpoint_url = os.environ.get(
            "MODEL_GUARDRAILS_AUTOMATED_REASONING_ENDPOINT_URL", ""
        ).strip()
        automated_reasoning_api_key_env_var = os.environ.get(
            "MODEL_GUARDRAILS_AUTOMATED_REASONING_API_KEY_ENV_VAR",
            "MODEL_GUARDRAILS_AUTOMATED_REASONING_API_KEY",
        ).strip() or "MODEL_GUARDRAILS_AUTOMATED_REASONING_API_KEY"
        if automated_reasoning_endpoint_url:
            if not automated_reasoning_endpoint_url.startswith(("http://", "https://")):
                raise ValueError(
                    "MODEL_GUARDRAILS_AUTOMATED_REASONING_ENDPOINT_URL must be an HTTP(S) URL."
                )
            if not os.environ.get(automated_reasoning_api_key_env_var, "").strip():
                raise ValueError(
                    f"{automated_reasoning_api_key_env_var} is required when Automated Reasoning is configured."
                )
        return cls(
            runner_id=runner_id,
            pool_id=pool_id,
            controller_target=target,
            controller_token=token,
            metrics_token=metrics_token or None,
            artifact_public_key_path=Path(public_key),
            artifact_state_path=Path(
                os.environ.get("GUARD_RUNNER_STATE_PATH", "/var/lib/tasklattice/guard-runner")
            ),
            compiler_capable=_boolean("GUARD_RUNNER_COMPILER_CAPABLE", pool_id == "default"),
            max_concurrency=_positive_int("GUARD_RUNNER_MAX_CONCURRENCY", 64),
            controller_ca_path=Path(controller_ca) if controller_ca else None,
            client_certificate_path=(Path(client_certificate) if client_certificate else None),
            client_key_path=Path(client_key) if client_key else None,
            telemetry_endpoint=os.environ.get(
                "GUARD_CONTROLLER_TELEMETRY_ENDPOINT",
                "http://tali-guard-controller:8080/api/internal/v1/runtime-events",
            ).strip(),
            telemetry_batch_size=_positive_int("GUARD_RUNNER_TELEMETRY_BATCH_SIZE", 100),
            call_context_redis_url=(
                os.environ.get("GUARD_RUNNER_CALL_CONTEXT_REDIS_URL", "").strip() or None
            ),
            model_runtimes=model_runtimes,
            evaluator_bindings=evaluator_bindings,
            automated_reasoning_endpoint_url=automated_reasoning_endpoint_url or None,
            automated_reasoning_api_key_env_var=automated_reasoning_api_key_env_var,
            runtime_log_encryption_key=runtime_log_encryption_key,
            otel_exporter_otlp_endpoint=(
                os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "").strip().rstrip("/")
                or os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "").strip().rstrip("/")
                or os.environ.get("GUARD_OTEL_EXPORTER_OTLP_ENDPOINT", "").strip().rstrip("/")
                or None
            ),
            otel_trace_sample_ratio=_ratio(
                "OTEL_TRACES_SAMPLER_ARG", 0.1, "GUARD_OTEL_TRACE_SAMPLE_RATIO",
            ),
            pyroscope_server_address=(
                os.environ.get("GUARD_PYROSCOPE_SERVER_ADDRESS", "").strip().rstrip("/")
                or None
            ),
            pyroscope_sample_rate=_positive_int("GUARD_PYROSCOPE_SAMPLE_RATE", 100),
        )


def _model_runtimes(value: str) -> tuple[ModelRuntimeConfig, ...]:
    payload = _configuration_array(value, "MODEL_GUARDRAILS_MODEL_RUNTIMES_JSON")
    runtimes: list[ModelRuntimeConfig] = []
    for index, item in enumerate(payload):
        try:
            runtimes.append(ModelRuntimeConfig(
                id=str(item["id"]),
                client=str(item.get("client", "openai_chat")),
                base_url=str(item["base_url"]).rstrip("/"),
                model=str(item["model"]),
                api_key_env_var=(
                    str(item["api_key_env_var"])
                    if item.get("api_key_env_var")
                    else None
                ),
                timeout_seconds=float(item.get("timeout_seconds", 20.0)),
                max_tokens=int(item.get("max_tokens", 128)),
            ))
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f"Model Runtime at index {index} is invalid: {error}") from error
    ids = tuple(item.id for item in runtimes)
    if len(ids) != len(set(ids)):
        raise ValueError("Model Runtime IDs must be unique.")
    return tuple(runtimes)


def _evaluator_bindings(value: str) -> tuple[EvaluatorBindingConfig, ...]:
    payload = _configuration_array(
        value, "MODEL_GUARDRAILS_EVALUATOR_BINDINGS_JSON"
    )
    bindings: list[EvaluatorBindingConfig] = []
    for index, item in enumerate(payload):
        try:
            bindings.append(EvaluatorBindingConfig(
                id=str(item["id"]),
                contract_ref=str(item["contract_ref"]),
                profile_ref=str(item["profile_ref"]),
                model_ref=str(item["model_ref"]),
                priority=int(item.get("priority", 100)),
            ))
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(
                f"Evaluator Binding at index {index} is invalid: {error}"
            ) from error
    ids = tuple(item.id for item in bindings)
    if len(ids) != len(set(ids)):
        raise ValueError("Evaluator Binding IDs must be unique.")
    keys = tuple((item.contract_ref, item.priority) for item in bindings)
    if len(keys) != len(set(keys)):
        raise ValueError(
            "Evaluator Binding contract priorities must be unique."
        )
    return tuple(sorted(bindings, key=lambda item: (item.priority, item.id)))


def _configuration_array(value: str, name: str) -> list[dict[str, object]]:
    if not value.strip():
        return []
    try:
        payload = json.loads(value)
    except json.JSONDecodeError as error:
        raise ValueError(f"{name} must be valid JSON.") from error
    if not isinstance(payload, list):
        raise ValueError(f"{name} must be a JSON array.")
    records: list[dict[str, object]] = []
    for index, item in enumerate(payload):
        if not isinstance(item, dict):
            raise ValueError(f"{name} entry {index} must be an object.")
        records.append(item)
    return records
