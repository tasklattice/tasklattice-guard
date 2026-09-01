from __future__ import annotations

import json

import pytest

from runner.compiler import DefaultRunnerCompiler
from runner.config import RunnerSettings
from runner import generated as protocol
from runner.protocol_codec import action_bindings_from_proto, plan_to_proto
from runner.providers import runtime_action_providers
from runner.toolkit.nemo.actions.names import ACTION_EVALUATE
from runner.toolkit.evaluation.contracts import (
    CONTRACT_CONTENT_SAFETY,
    CONTRACT_JAILBREAK,
    CONTRACT_PII_EXACT,
    CONTRACT_PII_SEMANTIC,
)


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
    compiler = DefaultRunnerCompiler(settings)

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

    plan = {
        "safety_level": "balanced", "output_delivery": "full_buffered",
        "steps": [{
            "id": "content_safety:primary", "capability": "content_safety",
            "contract_ref": CONTRACT_CONTENT_SAFETY, "phases": ["input"],
            "on_unsafe": "reject", "trigger": {"type": "always"}, "parameters": [],
        }],
        "modules": [{
            "id": "interaction_safety:input", "module": "interaction_safety",
            "phase": "input", "step_ids": ["content_safety:primary"],
            "depends_on": [], "input_view": "original", "required_for_release": True,
            "timeout_ms": 2_500, "failure_mode": "fail_closed",
        }],
        "reasoning_policies": [], "policy_versions": [], "policy_bindings": [],
    }
    artifact = compiler.compile(protocol.CompileRequest(
        compile_id="compile-tali-safety", guardrail_id="guardrail-tali-safety",
        guardrail_version=1, generation=1, plan=plan_to_proto(plan),
        runtime_profile="auto",
    ))
    bindings = action_bindings_from_proto(artifact.action_bindings)

    assert artifact.compiler_version == "tasklattice-nemo-config-v11"
    assert bindings[0]["action_name"] == ACTION_EVALUATE
    assert "nvidia" not in artifact.config_yaml.casefold()
    assert "Qwen/Qwen3Guard-Gen-8B" not in artifact.config_yaml


def test_runner_rejects_invalid_provider_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _required_runner_env(monkeypatch)
    monkeypatch.setenv("MODEL_GUARDRAILS_MODEL_RUNTIMES_JSON", "not-json")
    with pytest.raises(ValueError, match="valid JSON"):
        RunnerSettings.from_env()

    monkeypatch.setenv("MODEL_GUARDRAILS_MODEL_RUNTIMES_JSON", json.dumps([{
        "id": "guard-runtime",
        "base_url": "http://guard.internal/v1", "model": "Qwen/Qwen3Guard-Gen-8B",
        "api_key_env_var": "MISSING_GUARD_KEY",
    }]))
    with pytest.raises(ValueError, match="MISSING_GUARD_KEY"):
        RunnerSettings.from_env()


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
