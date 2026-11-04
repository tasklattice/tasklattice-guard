from __future__ import annotations

import os
import re
import base64
from dataclasses import dataclass
from pathlib import Path
from .project_admission import ProjectAdmissionConfiguration
from .distributed_rate_admission import DistributedRateConfiguration
from .group_rate_admission import GroupRateConfiguration

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
    # Pool credential for gRPC and model-credential resolution.
    control_token: str | None = None
    # Optional distinct Controller-to-Runner HTTP credential.
    controller_http_token: str | None = None
    scoped_telemetry: bool = False
    # Experimental cooperative request fencing; allocation moves still need
    # Controller-side drain/epoch coordination and verified timing assumptions.
    experimental_lease_enforcement: bool = False
    # Local process caps; absent unless explicitly enabled with strict config.
    project_admission: ProjectAdmissionConfiguration | None = None
    # Sliding-window starts across replicas of this pool, not concurrency.
    distributed_rate_admission: DistributedRateConfiguration | None = None
    group_rate_admission: GroupRateConfiguration | None = None
    telemetry_progress_enabled: bool = False
    telemetry_progress_state_path: Path | None = None
    call_context_compress_plans: bool = False
    call_context_capacity_fallback: bool = False
    call_context_ttl_seconds: int = 300

    @property
    def telemetry_token(self) -> str:
        # from_env validates this requirement; keep it fail closed for settings
        # built programmatically too.
        if self.scoped_telemetry:
            if not self.control_token:
                raise ValueError("Scoped telemetry requires a Runner pool token.")
            return self.control_token
        return self.controller_token

    @classmethod
    def from_env(cls) -> "RunnerSettings":
        pool_id = os.environ.get("GUARD_RUNNER_POOL_ID", "default").strip()
        project_name = pool_id
        if len(project_name) > 45 or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", project_name):
            raise ValueError("GUARD_RUNNER_POOL_ID must be a canonical Project name of up to 45 characters.")
        runner_id = os.environ.get("GUARD_RUNNER_ID", f"runner-{project_name}-{os.environ.get('GUARD_RUNNER_INDEX', '0')}")
        prefix = f"runner-{project_name}-"
        ordinal = runner_id.removeprefix(prefix)
        if not runner_id.startswith(prefix) or not re.fullmatch(r"0|[1-9][0-9]*", ordinal) or int(ordinal) > 2_147_483_647:
            raise ValueError(f"GUARD_RUNNER_ID must be {prefix}<index>, with an integer index starting at 0.")
        legacy_token = os.environ.get("GUARD_CONTROLLER_TOKEN")
        token = legacy_token or ""
        control_token = os.environ.get("GUARD_RUNNER_CONTROL_TOKEN")
        controller_http_token = os.environ.get("GUARD_CONTROLLER_HTTP_TOKEN")
        metrics_token = os.environ.get("GUARD_METRICS_TOKEN", "").strip()
        public_key = os.environ.get("GUARD_ARTIFACT_PUBLIC_KEY_PATH", "").strip()
        if not runner_id or not pool_id:
            raise ValueError("GUARD_RUNNER_ID and GUARD_RUNNER_POOL_ID cannot be empty.")
        if control_token is not None and (
            len(control_token) < 32 or any(not ("!" <= character <= "~") for character in control_token)
        ):
            raise ValueError("GUARD_RUNNER_CONTROL_TOKEN must contain at least 32 printable ASCII characters without whitespace when configured.")
        if controller_http_token is not None and (
            len(controller_http_token) < 32 or any(not ("!" <= character <= "~") for character in controller_http_token) or
            not control_token or controller_http_token in {token, control_token}
        ):
            raise ValueError("GUARD_CONTROLLER_HTTP_TOKEN requires a pool control token and must contain at least 32 printable ASCII characters without whitespace distinct from the legacy and control tokens.")
        scoped_telemetry = _boolean("GUARD_RUNNER_SCOPED_TELEMETRY", False)
        if scoped_telemetry and not control_token:
            raise ValueError("GUARD_RUNNER_SCOPED_TELEMETRY requires GUARD_RUNNER_CONTROL_TOKEN.")
        telemetry_progress_enabled = _boolean("GUARD_RUNNER_TELEMETRY_PROGRESS_ENABLED", False)
        if telemetry_progress_enabled and not scoped_telemetry:
            raise ValueError("GUARD_RUNNER_TELEMETRY_PROGRESS_ENABLED requires scoped telemetry and a pool control token.")
        if telemetry_progress_enabled and _positive_int("GUARD_RUNNER_TELEMETRY_BATCH_SIZE", 100) > 1000:
            raise ValueError("Authenticated telemetry progress batch size must not exceed 1000.")
        if legacy_token is None:
            if not (control_token and controller_http_token and scoped_telemetry):
                raise ValueError("GUARD_CONTROLLER_TOKEN is required unless pool control, distinct Controller HTTP authentication and scoped telemetry are all configured.")
        elif len(token) < 32 or any(character.isspace() for character in token):
            raise ValueError("GUARD_CONTROLLER_TOKEN must contain at least 32 non-whitespace characters when configured.")
        experimental_lease_enforcement = _boolean("GUARD_RUNNER_EXPERIMENTAL_LEASE_ENFORCEMENT", False)
        if experimental_lease_enforcement and not control_token:
            raise ValueError("GUARD_RUNNER_EXPERIMENTAL_LEASE_ENFORCEMENT requires GUARD_RUNNER_CONTROL_TOKEN.")
        admission_enabled = _boolean("GUARD_RUNNER_PROJECT_ADMISSION_ENABLED", False)
        admission_json = os.environ.get("GUARD_RUNNER_PROJECT_ADMISSION_JSON")
        if admission_enabled and not admission_json:
            raise ValueError("GUARD_RUNNER_PROJECT_ADMISSION_ENABLED requires GUARD_RUNNER_PROJECT_ADMISSION_JSON.")
        if not admission_enabled and admission_json is not None:
            raise ValueError("GUARD_RUNNER_PROJECT_ADMISSION_JSON requires GUARD_RUNNER_PROJECT_ADMISSION_ENABLED=true.")
        project_admission = ProjectAdmissionConfiguration.from_json(admission_json) if admission_enabled else None
        rate_enabled = _boolean("GUARD_RUNNER_DISTRIBUTED_RATE_ENABLED", False)
        rate_json = os.environ.get("GUARD_RUNNER_DISTRIBUTED_RATE_JSON")
        redis_url = os.environ.get("GUARD_RUNNER_CALL_CONTEXT_REDIS_URL", "").strip() or None
        if rate_enabled and (not rate_json or project_admission is None or not redis_url or not control_token):
            raise ValueError("GUARD_RUNNER_DISTRIBUTED_RATE_ENABLED requires strict rate JSON, local project admission, Redis and a Runner pool control token.")
        if not rate_enabled and rate_json is not None:
            raise ValueError("GUARD_RUNNER_DISTRIBUTED_RATE_JSON requires GUARD_RUNNER_DISTRIBUTED_RATE_ENABLED=true.")
        distributed_rate_admission = DistributedRateConfiguration.from_json(rate_json) if rate_enabled else None
        if distributed_rate_admission is not None and (
            distributed_rate_admission.pool_id != pool_id or
            set(distributed_rate_admission.project_limits) != set(project_admission.project_limits)
        ):
            raise ValueError("Distributed rate pool_id and project IDs must match the trusted Runner pool and local admission configuration.")
        group_rate_enabled = _boolean("GUARD_RUNNER_GROUP_RATE_ENABLED", False)
        group_rate_json = os.environ.get("GUARD_RUNNER_GROUP_RATE_JSON")
        if group_rate_enabled and (not group_rate_json or project_admission is None or not redis_url or not control_token or rate_enabled):
            raise ValueError("GUARD_RUNNER_GROUP_RATE_ENABLED requires strict group JSON, local admission, Redis, pool control authentication and v1 distributed rate disabled.")
        if not group_rate_enabled and group_rate_json is not None:
            raise ValueError("GUARD_RUNNER_GROUP_RATE_JSON requires GUARD_RUNNER_GROUP_RATE_ENABLED=true.")
        group_rate_admission = GroupRateConfiguration.from_json(group_rate_json) if group_rate_enabled else None
        if group_rate_admission is not None:
            group_rate_admission.validate_runner(pool_id, project_admission.project_limits)
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
            control_token=control_token,
            controller_http_token=controller_http_token,
            scoped_telemetry=scoped_telemetry,
            telemetry_progress_enabled=telemetry_progress_enabled,
            telemetry_progress_state_path=Path(os.environ.get("GUARD_RUNNER_TELEMETRY_PROGRESS_PATH", "").strip()
                or os.environ.get("GUARD_RUNNER_STATE_PATH", "/var/lib/tasklattice/guard-runner")),
            experimental_lease_enforcement=experimental_lease_enforcement,
            project_admission=project_admission,
            distributed_rate_admission=distributed_rate_admission,
            group_rate_admission=group_rate_admission,
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
            call_context_redis_url=redis_url,
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
