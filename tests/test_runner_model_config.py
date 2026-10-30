from __future__ import annotations


import pytest

from runner.config import RunnerSettings
def test_laya_settings_are_independent_and_reject_invalid_operating_points(monkeypatch):
    _required_runner_env(monkeypatch)
    monkeypatch.setenv("GUARD_JEV_LOWER_THRESHOLD", "0.1")
    monkeypatch.setenv("GUARD_JEV_UPPER_THRESHOLD", "0.85")
    monkeypatch.setenv("GUARD_LAYA_LOWER_THRESHOLD", "0")
    monkeypatch.setenv("GUARD_LAYA_UPPER_THRESHOLD", "0.6")
    settings = RunnerSettings.from_env()
    assert (settings.jev_lower_threshold, settings.jev_upper_threshold) == (.1, .85)
    assert (settings.laya_lower_threshold, settings.laya_upper_threshold) == (0, .6)
    for lower, upper in [(".6", ".6"), (".9", ".2"), ("nan", ".9"), ("-.1", ".9"), (".1", "1.1")]:
        monkeypatch.setenv("GUARD_LAYA_LOWER_THRESHOLD", lower)
        monkeypatch.setenv("GUARD_LAYA_UPPER_THRESHOLD", upper)
        with pytest.raises(ValueError, match="GUARD_LAYA"):
            RunnerSettings.from_env()


def test_validation_concurrency_can_be_reduced_without_changing_serving(monkeypatch):
    _required_runner_env(monkeypatch)
    monkeypatch.setenv("GUARD_VALIDATION_MAX_CONCURRENCY", "1")
    settings = RunnerSettings.from_env()
    assert settings.validation_max_concurrency == 1
    assert settings.max_concurrency == 64
    monkeypatch.setenv("GUARD_VALIDATION_MAX_CONCURRENCY", "0")
    with pytest.raises(ValueError, match="must be positive"):
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
    monkeypatch.setenv("GUARD_RUNNER_ID", "runner-test")
    monkeypatch.setenv("GUARD_RUNNER_POOL_ID", "default")
    monkeypatch.setenv("GUARD_CONTROLLER_TOKEN", "runner-token-that-is-at-least-32-characters")
    monkeypatch.setenv("GUARD_ARTIFACT_PUBLIC_KEY_PATH", "/tmp/public-key.pem")
