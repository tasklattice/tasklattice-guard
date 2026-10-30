from __future__ import annotations

import os
import socket
import base64
from dataclasses import dataclass
from pathlib import Path

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


def _threshold(name: str, default: float) -> float:
    value = float(os.environ.get(name, str(default)))
    if not 0 <= value <= 1:
        raise ValueError(f"{name} must be within [0, 1].")
    return value


def _ratio(name: str, default: float) -> float:
    raw = os.environ.get(name)
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
    runtime_log_encryption_key: bytes | None
    otel_exporter_otlp_endpoint: str | None = None
    otel_trace_sample_ratio: float = 0.1
    pyroscope_server_address: str | None = None
    pyroscope_sample_rate: int = 100
    scan_max_body_bytes: int = 1_048_576
    scan_timeout_seconds: int = 25
    validation_max_concurrency: int = 8
    # Explicit 429 recovery for model providers; 1 disables retrying.
    model_rate_limit_attempts: int = 3
    # Jev "uncertain" band: probabilities strictly between the two thresholds.
    jev_lower_threshold: float = 0.1
    jev_upper_threshold: float = 0.9
    # Laya starts at the same operating point but is configured independently.
    laya_lower_threshold: float = 0.1
    laya_upper_threshold: float = 0.9
    call_context_compress_plans: bool = False
    call_context_capacity_fallback: bool = False
    call_context_ttl_seconds: int = 300

    def __post_init__(self) -> None:
        # Reject a Jev band that can never produce a decisive classification.
        if not 0 <= self.jev_lower_threshold < self.jev_upper_threshold <= 1:
            raise ValueError(
                "GUARD_JEV_LOWER_THRESHOLD must be below GUARD_JEV_UPPER_THRESHOLD within [0, 1]."
            )
        if self.model_rate_limit_attempts < 1:
            raise ValueError("GUARD_MODEL_RATE_LIMIT_ATTEMPTS must be positive.")
        if not 0 <= self.laya_lower_threshold < self.laya_upper_threshold <= 1:
            raise ValueError(
                "GUARD_LAYA_LOWER_THRESHOLD must be below GUARD_LAYA_UPPER_THRESHOLD within [0, 1]."
            )

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
            validation_max_concurrency=_positive_int("GUARD_VALIDATION_MAX_CONCURRENCY", 8),
            model_rate_limit_attempts=_positive_int("GUARD_MODEL_RATE_LIMIT_ATTEMPTS", 3),
            jev_lower_threshold=_threshold("GUARD_JEV_LOWER_THRESHOLD", 0.1),
            jev_upper_threshold=_threshold("GUARD_JEV_UPPER_THRESHOLD", 0.9),
            laya_lower_threshold=_threshold("GUARD_LAYA_LOWER_THRESHOLD", 0.1),
            laya_upper_threshold=_threshold("GUARD_LAYA_UPPER_THRESHOLD", 0.9),
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
            call_context_compress_plans=_boolean("GUARD_RUNNER_CALL_CONTEXT_COMPRESS_PLANS", False),
            call_context_capacity_fallback=_boolean("GUARD_RUNNER_CALL_CONTEXT_CAPACITY_FALLBACK", False),
            call_context_ttl_seconds=_positive_int("GUARD_RUNNER_CALL_CONTEXT_TTL_SECONDS", 300),
            runtime_log_encryption_key=runtime_log_encryption_key,
            otel_exporter_otlp_endpoint=(
                os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "").strip().rstrip("/")
                or os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "").strip().rstrip("/")
                or None
            ),
            otel_trace_sample_ratio=_ratio(
                "OTEL_TRACES_SAMPLER_ARG", 0.1,
            ),
            pyroscope_server_address=(
                os.environ.get("GUARD_PYROSCOPE_SERVER_ADDRESS", "").strip().rstrip("/")
                or None
            ),
            pyroscope_sample_rate=_positive_int("GUARD_PYROSCOPE_SAMPLE_RATE", 100),
            scan_max_body_bytes=_positive_int("GUARD_SCAN_MAX_BODY_BYTES", 1_048_576),
            scan_timeout_seconds=_positive_int("GUARD_SCAN_TIMEOUT_SECONDS", 25),
        )
