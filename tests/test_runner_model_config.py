from __future__ import annotations


import json
from types import SimpleNamespace

import pytest

from runner.config import RunnerSettings

def test_runner_names_follow_the_immutable_project_and_replica_index(monkeypatch):
    _required_runner_env(monkeypatch)
    monkeypatch.setenv("GUARD_RUNNER_POOL_ID", "support-search")
    monkeypatch.setenv("GUARD_RUNNER_ID", "runner-support-search-0")
    assert RunnerSettings.from_env().runner_id == "runner-support-search-0"
    for name in ["runner-default-0", "runner-support-search-01", "runner-support-search--1", "runner-support-search-2147483648"]:
        monkeypatch.setenv("GUARD_RUNNER_ID", name)
        with pytest.raises(ValueError, match="GUARD_RUNNER_ID"):
            RunnerSettings.from_env()
    monkeypatch.delenv("GUARD_RUNNER_ID")
    monkeypatch.setenv("GUARD_RUNNER_INDEX", "3")
    assert RunnerSettings.from_env().runner_id == "runner-support-search-3"
    monkeypatch.setenv("GUARD_RUNNER_POOL_ID", "Support Search")
    with pytest.raises(ValueError, match="canonical Project name"):
        RunnerSettings.from_env()

def test_model_operating_points_are_validated_per_runtime():
    from runner.toolkit.safety.providers import ModelRuntimeConfig
    base = dict(id="laya", base_url="https://laya.test/v1", model="auto")
    model = ModelRuntimeConfig(**base, lower_threshold=0, upper_threshold=.6, rate_limit_attempts=1)
    assert (model.lower_threshold, model.upper_threshold, model.rate_limit_attempts) == (0, .6, 1)
    for lower, upper in [(.6, .6), (.9, .2), (float("nan"), .9), (-.1, .9), (.1, 1.1)]:
        with pytest.raises(ValueError, match="lower_threshold"):
            ModelRuntimeConfig(**base, lower_threshold=lower, upper_threshold=upper)
    for attempts in [0, 11, 1.5, True]:
        with pytest.raises(ValueError, match="rate-limit attempts"):
            ModelRuntimeConfig(**base, rate_limit_attempts=attempts)


@pytest.mark.parametrize("setting", ["GUARD_RUNNER_CONTROL_TOKEN", "GUARD_CONTROLLER_HTTP_TOKEN"])
def test_pool_credentials_are_required_and_validated(monkeypatch, setting):
    _required_runner_env(monkeypatch)
    monkeypatch.delenv(setting)
    with pytest.raises(ValueError, match=setting):
        RunnerSettings.from_env()
    for value in ("", "short", "control-token-with-at-least-32-characters extra"):
        monkeypatch.setenv(setting, value)
        with pytest.raises(ValueError, match=setting):
            RunnerSettings.from_env()


def test_pool_credentials_must_differ_between_roles(monkeypatch):
    _required_runner_env(monkeypatch)
    settings = RunnerSettings.from_env()
    assert settings.control_token == "runner-control-token-with-at-least-32-characters"
    assert settings.controller_http_token == "runner-inbound-http-token-with-at-least-32-characters"
    monkeypatch.setenv("GUARD_CONTROLLER_HTTP_TOKEN", settings.control_token)
    with pytest.raises(ValueError, match="GUARD_CONTROLLER_HTTP_TOKEN must differ"):
        RunnerSettings.from_env()


def test_pool_credentials_reject_non_ascii_and_control_characters_without_exposing_values(monkeypatch):
    _required_runner_env(monkeypatch)
    control = "pool-a-control-token-with-at-least-32-characters"
    # An in-memory environment also covers lone surrogates and NUL, which the
    # operating system cannot represent as environment-variable values.
    import runner.config as config_module

    environment = dict(config_module.os.environ)
    environment["GUARD_RUNNER_CONTROL_TOKEN"] = control
    for suffix in ("\u00e9", "\ud800", "\ud801", "\udfff", "\ufffd", "\U0001f600", "\x00", "\x1f", "\x7f", " ", "\t", "\n"):
        token = "s" * 32 + suffix
        for setting in ("GUARD_RUNNER_CONTROL_TOKEN", "GUARD_CONTROLLER_HTTP_TOKEN"):
            with monkeypatch.context() as context:
                context.setattr(config_module, "os", SimpleNamespace(environ={**environment, setting: token}))
                with pytest.raises(ValueError, match=f"{setting}.*printable ASCII") as error:
                    RunnerSettings.from_env()
                assert token not in str(error.value)
    ascii_token = "!" + "a" * 30 + "~"
    monkeypatch.setenv("GUARD_RUNNER_CONTROL_TOKEN", control)
    monkeypatch.setenv("GUARD_CONTROLLER_HTTP_TOKEN", ascii_token)
    assert RunnerSettings.from_env().controller_http_token == ascii_token


def test_experimental_lease_enforcement_is_explicit(monkeypatch):
    _required_runner_env(monkeypatch)
    monkeypatch.delenv("GUARD_RUNNER_EXPERIMENTAL_LEASE_ENFORCEMENT", raising=False)
    assert not RunnerSettings.from_env().experimental_lease_enforcement
    monkeypatch.setenv("GUARD_RUNNER_EXPERIMENTAL_LEASE_ENFORCEMENT", "true")
    assert RunnerSettings.from_env().experimental_lease_enforcement
    monkeypatch.setenv("GUARD_RUNNER_EXPERIMENTAL_LEASE_ENFORCEMENT", "maybe")
    with pytest.raises(ValueError, match="must be a boolean"):
        RunnerSettings.from_env()


def test_project_admission_is_off_by_default_and_requires_complete_explicit_configuration(monkeypatch):
    _required_runner_env(monkeypatch)
    monkeypatch.delenv("GUARD_RUNNER_PROJECT_ADMISSION_ENABLED", raising=False)
    monkeypatch.delenv("GUARD_RUNNER_PROJECT_ADMISSION_JSON", raising=False)
    assert RunnerSettings.from_env().project_admission is None
    monkeypatch.setenv("GUARD_RUNNER_PROJECT_ADMISSION_ENABLED", "true")
    with pytest.raises(ValueError, match="requires GUARD_RUNNER_PROJECT_ADMISSION_JSON"):
        RunnerSettings.from_env()
    raw = json.dumps(dict(capacity=2, project_limits={"projectA": 1, "projectB": 1}, max_queued=3,
                          max_queued_per_project=2, queue_timeout_seconds=0.25))
    monkeypatch.setenv("GUARD_RUNNER_PROJECT_ADMISSION_JSON", raw)
    configured = RunnerSettings.from_env().project_admission
    assert configured.capacity == 2
    assert configured.project_limits == {"projectA": 1, "projectB": 1}
    assert configured.queue_timeout_seconds == 0.25
    monkeypatch.setenv("GUARD_RUNNER_PROJECT_ADMISSION_ENABLED", "false")
    with pytest.raises(ValueError, match="requires GUARD_RUNNER_PROJECT_ADMISSION_ENABLED"):
        RunnerSettings.from_env()


def test_distributed_rate_admission_requires_explicit_matching_trusted_policy(monkeypatch):
    _required_runner_env(monkeypatch)
    monkeypatch.delenv("GUARD_RUNNER_DISTRIBUTED_RATE_ENABLED", raising=False)
    monkeypatch.delenv("GUARD_RUNNER_DISTRIBUTED_RATE_JSON", raising=False)
    assert RunnerSettings.from_env().distributed_rate_admission is None
    monkeypatch.setenv("GUARD_RUNNER_DISTRIBUTED_RATE_ENABLED", "true")
    with pytest.raises(ValueError, match="requires strict rate JSON"):
        RunnerSettings.from_env()
    local = dict(capacity=2, project_limits={"projectA": 1}, max_queued=2, max_queued_per_project=1, queue_timeout_seconds=0.25)
    rate = dict(pool_id="default", revision="v1", window_ms=1000, pool_limit=5, project_limits={"projectA": 3})
    monkeypatch.setenv("GUARD_RUNNER_PROJECT_ADMISSION_ENABLED", "true")
    monkeypatch.setenv("GUARD_RUNNER_PROJECT_ADMISSION_JSON", json.dumps(local))
    monkeypatch.setenv("GUARD_RUNNER_DISTRIBUTED_RATE_JSON", json.dumps(rate))
    monkeypatch.setenv("GUARD_RUNNER_CALL_CONTEXT_REDIS_URL", "redis://127.0.0.1:6379/0")
    settings = RunnerSettings.from_env()
    assert settings.distributed_rate_admission.pool_limit == 5
    for required in ("GUARD_RUNNER_CALL_CONTEXT_REDIS_URL", "GUARD_RUNNER_PROJECT_ADMISSION_ENABLED"):
        with monkeypatch.context() as missing:
            missing.delenv(required, raising=False)
            with pytest.raises(ValueError):
                RunnerSettings.from_env()
    for field, invalid in [("pool_id", "another-pool"), ("project_limits", {"other": 3})]:
        monkeypatch.setenv("GUARD_RUNNER_DISTRIBUTED_RATE_JSON", json.dumps({**rate, field: invalid}))
        with pytest.raises(ValueError, match="must match the trusted Runner pool"):
            RunnerSettings.from_env()
    monkeypatch.setenv("GUARD_RUNNER_DISTRIBUTED_RATE_ENABLED", "false")
    with pytest.raises(ValueError, match="requires GUARD_RUNNER_DISTRIBUTED_RATE_ENABLED"):
        RunnerSettings.from_env()


def test_call_plan_compression_requires_explicit_rollout_opt_in(monkeypatch):
    _required_runner_env(monkeypatch)
    monkeypatch.delenv("GUARD_RUNNER_CALL_CONTEXT_COMPRESS_PLANS", raising=False)
    assert RunnerSettings.from_env().call_context_compress_plans is False
    monkeypatch.setenv("GUARD_RUNNER_CALL_CONTEXT_COMPRESS_PLANS", "true")
    assert RunnerSettings.from_env().call_context_compress_plans is True
    monkeypatch.setenv("GUARD_RUNNER_CALL_CONTEXT_COMPRESS_PLANS", "invalid")
    with pytest.raises(ValueError, match="must be a boolean"):
        RunnerSettings.from_env()


def test_context_capacity_fallback_and_ttl_are_explicit(monkeypatch):
    _required_runner_env(monkeypatch)
    monkeypatch.delenv("GUARD_RUNNER_CALL_CONTEXT_CAPACITY_FALLBACK", raising=False)
    monkeypatch.delenv("GUARD_RUNNER_CALL_CONTEXT_TTL_SECONDS", raising=False)
    assert RunnerSettings.from_env().call_context_capacity_fallback is False
    assert RunnerSettings.from_env().call_context_ttl_seconds == 300
    monkeypatch.setenv("GUARD_RUNNER_CALL_CONTEXT_CAPACITY_FALLBACK", "true")
    assert RunnerSettings.from_env().call_context_capacity_fallback is True
    monkeypatch.setenv("GUARD_RUNNER_CALL_CONTEXT_TTL_SECONDS", "0")
    with pytest.raises(ValueError): RunnerSettings.from_env()


def test_runner_validates_the_optional_metrics_token(monkeypatch: pytest.MonkeyPatch) -> None:
    _required_runner_env(monkeypatch)
    monkeypatch.setenv("GUARD_METRICS_TOKEN", "metrics-token-that-is-at-least-32-characters")
    assert RunnerSettings.from_env().metrics_token == "metrics-token-that-is-at-least-32-characters"
    monkeypatch.setenv("GUARD_METRICS_TOKEN", "short")
    with pytest.raises(ValueError, match="GUARD_METRICS_TOKEN"):
        RunnerSettings.from_env()


def test_runner_requires_metrics_authentication_with_production_mtls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _required_runner_env(monkeypatch)
    monkeypatch.setenv("GUARD_CONTROLLER_CA_PATH", "/tmp/ca.crt")
    monkeypatch.setenv("GUARD_RUNNER_CLIENT_CERT_PATH", "/tmp/runner.crt")
    monkeypatch.setenv("GUARD_RUNNER_CLIENT_KEY_PATH", "/tmp/runner.key")
    with pytest.raises(ValueError, match="GUARD_METRICS_TOKEN"):
        RunnerSettings.from_env()


def test_runner_uses_standard_opentelemetry_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _required_runner_env(monkeypatch)
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://tempo.monitoring:4318/")
    monkeypatch.setenv("OTEL_TRACES_SAMPLER_ARG", "0.25")
    settings = RunnerSettings.from_env()
    assert settings.otel_exporter_otlp_endpoint == "http://tempo.monitoring:4318"
    assert settings.otel_trace_sample_ratio == 0.25


def _required_runner_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "MODEL_GUARDRAILS_MODEL_RUNTIMES_JSON",
        "MODEL_GUARDRAILS_EVALUATOR_BINDINGS_JSON", "QWEN_GUARD_KEY",
        "MISSING_GUARD_KEY", "GUARD_METRICS_TOKEN", "GUARD_CONTROLLER_CA_PATH",
        "GUARD_RUNNER_CLIENT_CERT_PATH", "GUARD_RUNNER_CLIENT_KEY_PATH",
        "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
        "OTEL_TRACES_SAMPLER_ARG", "GUARD_OTEL_EXPORTER_OTLP_ENDPOINT",
        "GUARD_OTEL_TRACE_SAMPLE_RATIO",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("GUARD_RUNNER_ID", "runner-default-0")
    monkeypatch.setenv("GUARD_RUNNER_POOL_ID", "default")
    monkeypatch.setenv("GUARD_RUNNER_CONTROL_TOKEN", "runner-control-token-with-at-least-32-characters")
    monkeypatch.setenv("GUARD_CONTROLLER_HTTP_TOKEN", "runner-inbound-http-token-with-at-least-32-characters")
    monkeypatch.setenv("GUARD_ARTIFACT_PUBLIC_KEY_PATH", "/tmp/public-key.pem")
