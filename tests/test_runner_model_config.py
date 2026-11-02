from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from runner.config import RunnerSettings
from runner.providers import runtime_action_providers
from runner.toolkit.nemo.actions.names import ACTION_EVALUATE
from runner.toolkit.evaluation.contracts import (
    CONTRACT_CONTENT_SAFETY,
    CONTRACT_JAILBREAK,
    CONTRACT_PII_EXACT,
    CONTRACT_PII_SEMANTIC,
)


def test_validation_concurrency_can_be_reduced_without_changing_serving(monkeypatch):
    _required_runner_env(monkeypatch)
    monkeypatch.setenv("GUARD_VALIDATION_MAX_CONCURRENCY", "1")
    settings = RunnerSettings.from_env()
    assert settings.validation_max_concurrency == 1
    assert settings.max_concurrency == 64
    monkeypatch.setenv("GUARD_VALIDATION_MAX_CONCURRENCY", "0")
    with pytest.raises(ValueError, match="must be positive"):
        RunnerSettings.from_env()


def test_optional_pool_control_token_is_validated_and_kept_distinct(monkeypatch):
    _required_runner_env(monkeypatch)
    monkeypatch.delenv("GUARD_RUNNER_CONTROL_TOKEN", raising=False)
    assert RunnerSettings.from_env().control_token is None
    pool_token = "pool-a-control-token-with-at-least-32-characters"
    monkeypatch.setenv("GUARD_RUNNER_CONTROL_TOKEN", pool_token)
    settings = RunnerSettings.from_env()
    assert settings.control_token == pool_token
    assert settings.controller_token != pool_token
    for value in ("", "short", f"{pool_token} extra"):
        monkeypatch.setenv("GUARD_RUNNER_CONTROL_TOKEN", value)
        with pytest.raises(ValueError, match="GUARD_RUNNER_CONTROL_TOKEN"):
            RunnerSettings.from_env()


def test_optional_controller_http_token_is_complete_and_role_separated(monkeypatch):
    _required_runner_env(monkeypatch)
    monkeypatch.delenv("GUARD_CONTROLLER_HTTP_TOKEN", raising=False)
    monkeypatch.delenv("GUARD_RUNNER_CONTROL_TOKEN", raising=False)
    assert RunnerSettings.from_env().controller_http_token is None
    inbound = "pool-a-inbound-http-token-with-at-least-32-characters"
    monkeypatch.setenv("GUARD_CONTROLLER_HTTP_TOKEN", inbound)
    with pytest.raises(ValueError, match="GUARD_CONTROLLER_HTTP_TOKEN"):
        RunnerSettings.from_env()
    control = "pool-a-control-token-with-at-least-32-characters"
    monkeypatch.setenv("GUARD_RUNNER_CONTROL_TOKEN", control)
    assert RunnerSettings.from_env().controller_http_token == inbound
    for invalid in ("", "short", f"{inbound} extra", control, RunnerSettings.from_env().controller_token):
        monkeypatch.setenv("GUARD_CONTROLLER_HTTP_TOKEN", invalid)
        with pytest.raises(ValueError, match="GUARD_CONTROLLER_HTTP_TOKEN"):
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


def test_legacy_runner_token_can_be_omitted_only_for_complete_scoped_roles(monkeypatch):
    _required_runner_env(monkeypatch)
    monkeypatch.delenv("GUARD_CONTROLLER_TOKEN", raising=False)
    monkeypatch.delenv("GUARD_RUNNER_CONTROL_TOKEN", raising=False)
    monkeypatch.delenv("GUARD_CONTROLLER_HTTP_TOKEN", raising=False)
    monkeypatch.setenv("GUARD_RUNNER_SCOPED_TELEMETRY", "false")
    with pytest.raises(ValueError, match="GUARD_CONTROLLER_TOKEN"):
        RunnerSettings.from_env()
    control = "pool-a-control-token-with-at-least-32-characters"
    inbound = "pool-a-inbound-http-token-with-at-least-32-characters"
    monkeypatch.setenv("GUARD_RUNNER_CONTROL_TOKEN", control)
    monkeypatch.setenv("GUARD_CONTROLLER_HTTP_TOKEN", inbound)
    with pytest.raises(ValueError, match="GUARD_CONTROLLER_TOKEN"):
        RunnerSettings.from_env()
    monkeypatch.setenv("GUARD_RUNNER_SCOPED_TELEMETRY", "true")
    settings = RunnerSettings.from_env()
    assert settings.controller_token == ""
    assert settings.telemetry_token == control
    assert settings.controller_http_token == inbound
    monkeypatch.setenv("GUARD_CONTROLLER_TOKEN", "")
    with pytest.raises(ValueError, match="GUARD_CONTROLLER_TOKEN"):
        RunnerSettings.from_env()


def test_scoped_telemetry_requires_explicit_opt_in_and_pool_token(monkeypatch):
    _required_runner_env(monkeypatch)
    monkeypatch.delenv("GUARD_RUNNER_CONTROL_TOKEN", raising=False)
    monkeypatch.delenv("GUARD_RUNNER_SCOPED_TELEMETRY", raising=False)
    assert not RunnerSettings.from_env().scoped_telemetry
    assert RunnerSettings.from_env().telemetry_token == RunnerSettings.from_env().controller_token
    monkeypatch.setenv("GUARD_RUNNER_SCOPED_TELEMETRY", "true")
    with pytest.raises(ValueError, match="requires GUARD_RUNNER_CONTROL_TOKEN"):
        RunnerSettings.from_env()
    monkeypatch.setenv("GUARD_RUNNER_CONTROL_TOKEN", "pool-a-control-token-with-at-least-32-characters")
    settings = RunnerSettings.from_env()
    assert settings.scoped_telemetry
    assert settings.telemetry_token == settings.control_token


def test_experimental_lease_enforcement_is_explicit_and_requires_a_pool_token(monkeypatch):
    _required_runner_env(monkeypatch)
    monkeypatch.delenv("GUARD_RUNNER_EXPERIMENTAL_LEASE_ENFORCEMENT", raising=False)
    monkeypatch.delenv("GUARD_RUNNER_CONTROL_TOKEN", raising=False)
    assert not RunnerSettings.from_env().experimental_lease_enforcement
    monkeypatch.setenv("GUARD_RUNNER_EXPERIMENTAL_LEASE_ENFORCEMENT", "true")
    with pytest.raises(ValueError, match="requires GUARD_RUNNER_CONTROL_TOKEN"):
        RunnerSettings.from_env()
    monkeypatch.setenv("GUARD_RUNNER_CONTROL_TOKEN", "pool-token-at-least-thirty-two-characters")
    assert RunnerSettings.from_env().experimental_lease_enforcement
    monkeypatch.setenv("GUARD_RUNNER_EXPERIMENTAL_LEASE_ENFORCEMENT", "maybe")
    with pytest.raises(ValueError, match="must be a boolean"):
        RunnerSettings.from_env()


def test_tenant_admission_is_off_by_default_and_requires_complete_explicit_configuration(monkeypatch):
    _required_runner_env(monkeypatch)
    monkeypatch.delenv("GUARD_RUNNER_TENANT_ADMISSION_ENABLED", raising=False)
    monkeypatch.delenv("GUARD_RUNNER_TENANT_ADMISSION_JSON", raising=False)
    assert RunnerSettings.from_env().tenant_admission is None
    monkeypatch.setenv("GUARD_RUNNER_TENANT_ADMISSION_ENABLED", "true")
    with pytest.raises(ValueError, match="requires GUARD_RUNNER_TENANT_ADMISSION_JSON"):
        RunnerSettings.from_env()
    raw = json.dumps(dict(capacity=2, tenant_limits={"tenantA": 1, "tenantB": 1}, max_queued=3,
                          max_queued_per_tenant=2, queue_timeout_seconds=0.25))
    monkeypatch.setenv("GUARD_RUNNER_TENANT_ADMISSION_JSON", raw)
    configured = RunnerSettings.from_env().tenant_admission
    assert configured.capacity == 2
    assert configured.tenant_limits == {"tenantA": 1, "tenantB": 1}
    assert configured.queue_timeout_seconds == 0.25
    monkeypatch.setenv("GUARD_RUNNER_TENANT_ADMISSION_ENABLED", "false")
    with pytest.raises(ValueError, match="requires GUARD_RUNNER_TENANT_ADMISSION_ENABLED"):
        RunnerSettings.from_env()


def test_distributed_rate_admission_requires_explicit_matching_trusted_policy(monkeypatch):
    _required_runner_env(monkeypatch)
    monkeypatch.delenv("GUARD_RUNNER_DISTRIBUTED_RATE_ENABLED", raising=False)
    monkeypatch.delenv("GUARD_RUNNER_DISTRIBUTED_RATE_JSON", raising=False)
    assert RunnerSettings.from_env().distributed_rate_admission is None
    monkeypatch.setenv("GUARD_RUNNER_DISTRIBUTED_RATE_ENABLED", "true")
    with pytest.raises(ValueError, match="requires strict rate JSON"):
        RunnerSettings.from_env()
    local = dict(capacity=2, tenant_limits={"tenantA": 1}, max_queued=2, max_queued_per_tenant=1, queue_timeout_seconds=0.25)
    rate = dict(pool_id="default", revision="v1", window_ms=1000, pool_limit=5, tenant_limits={"tenantA": 3})
    monkeypatch.setenv("GUARD_RUNNER_TENANT_ADMISSION_ENABLED", "true")
    monkeypatch.setenv("GUARD_RUNNER_TENANT_ADMISSION_JSON", json.dumps(local))
    monkeypatch.setenv("GUARD_RUNNER_DISTRIBUTED_RATE_JSON", json.dumps(rate))
    monkeypatch.setenv("GUARD_RUNNER_CALL_CONTEXT_REDIS_URL", "redis://127.0.0.1:6379/0")
    monkeypatch.setenv("GUARD_RUNNER_CONTROL_TOKEN", "pool-control-token-with-at-least-32-characters")
    settings = RunnerSettings.from_env()
    assert settings.distributed_rate_admission.pool_limit == 5
    for required in ("GUARD_RUNNER_CONTROL_TOKEN", "GUARD_RUNNER_CALL_CONTEXT_REDIS_URL", "GUARD_RUNNER_TENANT_ADMISSION_ENABLED"):
        with monkeypatch.context() as missing:
            missing.delenv(required, raising=False)
            with pytest.raises(ValueError):
                RunnerSettings.from_env()
    for field, invalid in [("pool_id", "another-pool"), ("tenant_limits", {"other": 3})]:
        monkeypatch.setenv("GUARD_RUNNER_DISTRIBUTED_RATE_JSON", json.dumps({**rate, field: invalid}))
        with pytest.raises(ValueError, match="must match the trusted Runner pool"):
            RunnerSettings.from_env()
    monkeypatch.setenv("GUARD_RUNNER_DISTRIBUTED_RATE_ENABLED", "false")
    with pytest.raises(ValueError, match="requires GUARD_RUNNER_DISTRIBUTED_RATE_ENABLED"):
        RunnerSettings.from_env()


def test_runner_loads_qwen_primary_and_llama_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _required_runner_env(monkeypatch)
    monkeypatch.setenv("QWEN_GUARD_KEY", "test-key")
    monkeypatch.setenv("MODEL_GUARDRAILS_MODEL_RUNTIMES_JSON", json.dumps([
        {
            "id": "llama-runtime",
            "base_url": "http://llama-guard.internal/v1/",
            "model": "meta-llama/Llama-Guard-3-8B",
            "timeout_seconds": 10, "max_tokens": 64,
        },
        {
            "id": "qwen-runtime",
            "base_url": "http://qwen-guard.internal/v1/",
            "model": "Qwen/Qwen3Guard-Gen-8B",
            "api_key_env_var": "QWEN_GUARD_KEY",
            "timeout_seconds": 15, "max_tokens": 128,
        },
    ]))
    monkeypatch.setenv("MODEL_GUARDRAILS_EVALUATOR_BINDINGS_JSON", json.dumps([
        {"id": "qwen-pii", "contract_ref": CONTRACT_PII_SEMANTIC, "profile_ref": "tali.qwen3guard.v1", "model_ref": "qwen-runtime", "priority": 10},
        {"id": "qwen-content", "contract_ref": CONTRACT_CONTENT_SAFETY, "profile_ref": "tali.qwen3guard.v1", "model_ref": "qwen-runtime", "priority": 10},
        {"id": "qwen-jailbreak", "contract_ref": CONTRACT_JAILBREAK, "profile_ref": "tali.qwen3guard.v1", "model_ref": "qwen-runtime", "priority": 10},
        {"id": "llama-content", "contract_ref": CONTRACT_CONTENT_SAFETY, "profile_ref": "tali.llama-guard-3.v1", "model_ref": "llama-runtime", "priority": 20},
    ]))

    settings = RunnerSettings.from_env()
    assert [item.id for item in settings.model_runtimes] == [
        "llama-runtime", "qwen-runtime",
    ]
    llama, qwen = settings.model_runtimes
    assert qwen.base_url == "http://qwen-guard.internal/v1"
    assert qwen.timeout_seconds == 15
    assert qwen.max_tokens == 128
    assert llama.base_url == "http://llama-guard.internal/v1"
    assert llama.timeout_seconds == 10
    assert llama.max_tokens == 64
    assert {item.model_ref for item in settings.evaluator_bindings} == {
        "qwen-runtime", "llama-runtime",
    }
    providers = runtime_action_providers(settings)
    provider_names = {provider.name for provider in providers}
    assert ACTION_EVALUATE in provider_names
    evaluation = next(provider for provider in providers if provider.name == ACTION_EVALUATE)
    assert evaluation.route_keys == (
        ("pii", CONTRACT_PII_EXACT),
        ("pii", CONTRACT_PII_SEMANTIC),
        ("content_safety", CONTRACT_CONTENT_SAFETY),
        ("jailbreak", CONTRACT_JAILBREAK),
    )
    assert evaluation.route_evaluators == (
        ("pii", CONTRACT_PII_EXACT, "local-pii"),
        ("pii", CONTRACT_PII_SEMANTIC, "model-safety"),
        ("content_safety", CONTRACT_CONTENT_SAFETY, "model-safety"),
        ("jailbreak", CONTRACT_JAILBREAK, "model-safety"),
    )



def test_runner_ignores_invalid_legacy_provider_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _required_runner_env(monkeypatch)
    monkeypatch.setenv("MODEL_GUARDRAILS_MODEL_RUNTIMES_JSON", "not-json")
    settings = RunnerSettings.from_env()
    assert settings.model_runtimes == ()
    assert settings.evaluator_bindings == ()

    monkeypatch.setenv("MODEL_GUARDRAILS_MODEL_RUNTIMES_JSON", json.dumps([{
        "id": "guard-runtime",
        "base_url": "http://guard.internal/v1", "model": "Qwen/Qwen3Guard-Gen-8B",
        "api_key_env_var": "MISSING_GUARD_KEY",
    }]))
    settings = RunnerSettings.from_env()
    assert settings.model_runtimes == ()
    assert settings.evaluator_bindings == ()


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
