"""Contract for the test-only LiteLLM chart and its separation from the product chart."""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
import yaml

pytestmark = pytest.mark.contract

ROOT = Path(__file__).resolve().parent.parent
CHART = ROOT / "charts" / "tali-litellm-dev"
GUARD_CHART = ROOT / "charts" / "tali-guard"
UPSTREAM = (
    "--set-string", "model.upstream.apiBase=https://api.example/v1",
    "--set-string", "model.upstream.apiKey=sk-test",
    "--set-string", "model.upstream.model=gpt-test",
)


def render(*values: str) -> list[dict]:
    output = subprocess.run(
        ["helm", "template", "tali-litellm-dev", str(CHART), "--namespace", "tali", "--values", str(CHART / "values-dev.yaml"), *values],
        check=True, capture_output=True, text=True,
    ).stdout
    return [item for item in yaml.safe_load_all(output) if item]


def find(docs: list[dict], kind: str, suffix: str = "") -> dict:
    return next(item for item in docs if item["kind"] == kind and item["metadata"]["name"].endswith(suffix))


def litellm_config(docs: list[dict]) -> dict:
    secret = find(docs, "Secret", "tali-litellm-dev")
    return yaml.safe_load(secret["stringData"]["litellm-config.yaml"])


def test_product_chart_carries_no_litellm_resources():
    output = subprocess.run(
        ["helm", "template", "tali-guard", str(GUARD_CHART), "--namespace", "tali", "--values", str(GUARD_CHART / "values-dev.yaml")],
        check=True, capture_output=True, text=True,
    ).stdout
    assert "litellm" not in output.lower()
    assert not (GUARD_CHART / "templates" / "litellm.yaml").exists()


def test_dev_stack_has_gateway_database_and_mock_model_by_default():
    docs = render()
    deployment = find(docs, "Deployment", "tali-litellm-dev")
    container = deployment["spec"]["template"]["spec"]["containers"][0]
    # Published by tasklattice-litellm-guard at an exact <litellm>-guard.<n> tag.
    assert container["image"] == "ghcr.io/tasklattice/tali-litellm:1.87.0-guard.3"
    assert container["imagePullPolicy"] == "IfNotPresent"
    env = {item["name"]: item for item in container["env"]}
    for name, key in (("TASKLATTICE_GUARD_API_BASE", "api-base"), ("TASKLATTICE_GUARD_API_KEY", "api-key")):
        assert env[name]["valueFrom"]["secretKeyRef"] == {"name": "tali-litellm-dev-guard", "key": key}
    assert "LITELLM_UPSTREAM_API_KEY" not in env
    assert find(docs, "StatefulSet", "postgresql")["spec"]["replicas"] == 1
    mock = find(docs, "Deployment", "mock-model")["spec"]["template"]["spec"]["containers"][0]
    assert mock["image"] == "ghcr.io/tasklattice/tali-guard-runner:dev"
    assert mock["command"] == ["python", "/opt/mock/mock_openai_model.py"]
    assert find(docs, "ConfigMap", "mock-model")["data"]["mock_openai_model.py"] == (CHART / "files" / "mock_openai_model.py").read_text()
    service = find(docs, "Service", "tali-litellm-dev")
    assert service["spec"]["type"] == "LoadBalancer" and service["spec"]["ports"][0]["port"] == 38083


def test_litellm_config_pins_the_tasklattice_guard_provider_fail_closed():
    config = litellm_config(render())
    [guardrail] = config["guardrails"]
    params = guardrail["litellm_params"]
    assert params["guardrail"] == "tasklattice_guard"
    assert set(params["mode"]) == {"pre_call", "post_call"}
    assert params["unreachable_fallback"] == "fail_closed"
    assert params["default_on"] is True
    assert params["api_base"] == "os.environ/TASKLATTICE_GUARD_API_BASE"
    assert params["credential_name"] == config["credential_list"][0]["credential_name"]
    assert config["credential_list"][0]["credential_values"]["api_key"] == "os.environ/TASKLATTICE_GUARD_API_KEY"
    [model] = config["model_list"]
    assert model["model_name"] == "guarded-model"
    assert model["litellm_params"]["api_base"] == "http://tali-litellm-dev-mock-model.tali.svc.cluster.local:8097/v1"
    assert config["general_settings"]["master_key"] == "os.environ/LITELLM_MASTER_KEY"


def test_complete_upstream_provider_replaces_the_mock_model():
    docs = render(*UPSTREAM)
    assert not [item for item in docs if item["metadata"]["name"].endswith("mock-model")]
    [model] = litellm_config(docs)["model_list"]
    assert model["litellm_params"] == {"model": "openai/gpt-test", "api_base": "https://api.example/v1", "api_key": "os.environ/LITELLM_UPSTREAM_API_KEY", "num_retries": 0}
    container = find(docs, "Deployment", "tali-litellm-dev")["spec"]["template"]["spec"]["containers"][0]
    env = {item["name"]: item for item in container["env"]}
    assert env["LITELLM_UPSTREAM_API_KEY"]["valueFrom"]["secretKeyRef"]["key"] == "upstream-api-key"
    assert find(docs, "Secret", "tali-litellm-dev")["stringData"]["upstream-api-key"] == "sk-test"


def test_partial_upstream_keeps_the_mock_model():
    docs = render("--set-string", "model.upstream.apiBase=https://api.example/v1")
    assert find(docs, "Deployment", "mock-model")
    assert litellm_config(docs)["model_list"][0]["litellm_params"]["model"] == "openai/mock-model"


def test_disabling_the_mock_without_an_upstream_fails_rendering():
    result = subprocess.run(
        ["helm", "template", "tali-litellm-dev", str(CHART), "--set", "model.mock.enabled=false"],
        capture_output=True, text=True,
    )
    assert result.returncode != 0
    assert "model.upstream" in result.stderr
