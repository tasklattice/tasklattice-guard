"""Contract for the optional litellm-provider settings in the Guard chart."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
import yaml

pytestmark = pytest.mark.contract

ROOT = Path(__file__).resolve().parent.parent
CHART = ROOT / "charts" / "tali-guard"
UPSTREAM = (
    "--set-string", "litellm-provider.model.upstream.apiBase=https://api.example/v1",
    "--set-string", "litellm-provider.model.upstream.existingSecret=upstream",
    "--set-string", "litellm-provider.model.upstream.model=gpt-test",
)


def render(*values: str) -> list[dict]:
    output = subprocess.run(
        ["helm", "template", "tali-guard", str(CHART), "--namespace", "tali", "--values", str(CHART / "values-dev-uat.yaml"), "--set", "litellm-provider.enabled=true", *values],
        check=True, capture_output=True, text=True,
    ).stdout
    return [item for item in yaml.safe_load_all(output) if item]


def find(docs: list[dict], kind: str, suffix: str = "") -> dict:
    return next(item for item in docs if item["kind"] == kind and item["metadata"]["name"].endswith(suffix))


def litellm_config(docs: list[dict]) -> dict:
    config = find(docs, "ConfigMap", "tali-guard-litellm-config")
    return yaml.safe_load(config["data"]["litellm-config.yaml"])


def test_provider_is_disabled_by_default_and_can_be_disabled_after_enabling():
    output = subprocess.run(
        ["helm", "template", "tali-guard", str(CHART), "--namespace", "tali", "--values", str(CHART / "values-dev-uat.yaml")],
        check=True, capture_output=True, text=True,
    ).stdout
    assert "litellm" not in output.lower()
    assert render("--set", "litellm-provider.enabled=false") == [item for item in yaml.safe_load_all(output) if item]


def test_dev_stack_has_gateway_database_and_mock_model_by_default():
    docs = render()
    deployment = find(docs, "Deployment", "tali-guard-litellm")
    container = deployment["spec"]["template"]["spec"]["containers"][0]
    # Published by tasklattice-litellm-guard at an exact <litellm>-guard.<n> tag.
    assert container["image"] == "ghcr.io/tasklattice/tali-litellm:1.87.0-guard.3"
    assert container["imagePullPolicy"] == "Never"
    env = {item["name"]: item for item in container["env"]}
    for name, key in (("TASKLATTICE_GUARD_API_BASE", "api-base"), ("TASKLATTICE_GUARD_API_KEY", "api-key")):
        assert env[name]["valueFrom"]["secretKeyRef"] == {"name": "tali-guard-litellm-guard", "key": key}
    assert "LITELLM_UPSTREAM_API_KEY" not in env
    assert find(docs, "StatefulSet", "litellm-postgresql")["spec"]["replicas"] == 1
    mock = find(docs, "Deployment", "mock-model")["spec"]["template"]["spec"]["containers"][0]
    assert mock["image"] == "ghcr.io/tasklattice/tali-guard-runner:dev"
    assert mock["command"] == ["python", "/opt/mock/mock_openai_model.py"]
    assert find(docs, "ConfigMap", "mock-model")["data"]["mock_openai_model.py"] == (CHART / "files" / "litellm" / "mock_openai_model.py").read_text()
    service = find(docs, "Service", "tali-guard-litellm")
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
    assert model["litellm_params"]["api_base"] == "http://tali-guard-litellm-mock-model.tali.svc.cluster.local:8097/v1"
    assert config["general_settings"]["master_key"] == "os.environ/LITELLM_MASTER_KEY"


def test_complete_upstream_provider_replaces_the_mock_model():
    docs = render(*UPSTREAM)
    assert not [item for item in docs if item["metadata"]["name"].endswith("mock-model")]
    [model] = litellm_config(docs)["model_list"]
    assert model["litellm_params"] == {"model": "openai/gpt-test", "api_base": "https://api.example/v1", "api_key": "os.environ/LITELLM_UPSTREAM_API_KEY", "num_retries": 0}
    container = find(docs, "Deployment", "tali-guard-litellm")["spec"]["template"]["spec"]["containers"][0]
    env = {item["name"]: item for item in container["env"]}
    assert env["LITELLM_UPSTREAM_API_KEY"]["valueFrom"]["secretKeyRef"] == {"name": "upstream", "key": "api-key"}
    assert not any(item["kind"] == "Secret" for item in docs)


def test_partial_upstream_keeps_the_mock_model():
    docs = render("--set-string", "litellm-provider.model.upstream.apiBase=https://api.example/v1")
    assert find(docs, "Deployment", "mock-model")
    assert litellm_config(docs)["model_list"][0]["litellm_params"]["model"] == "openai/mock-model"


def test_disabling_the_mock_without_an_upstream_fails_rendering():
    result = subprocess.run(
        ["helm", "template", "tali-guard", str(CHART), "--values", str(CHART / "values-dev-uat.yaml"), "--set", "litellm-provider.enabled=true", "--set", "litellm-provider.model.mock.enabled=false"],
        capture_output=True, text=True,
    )
    assert result.returncode != 0
    assert "litellm-provider.model.upstream.existingSecret" in result.stderr


def test_provider_helpers_reuse_guard_controller_and_runner_images():
    docs = render("--set", "controller.image.repository=registry.example/controller", "--set-string", "controller.image.tag=custom", "--set", "runner.image.repository=registry.example/runner", "--set-string", "runner.image.tag=custom")
    container = find(docs, "Job")["spec"]["template"]["spec"]["containers"][0]
    assert container["image"] == "registry.example/controller:custom"
    assert container["command"] == ["node", "/opt/tasklattice/guard-controller/scripts/runtime/bootstrap-secrets.mjs"]
    mock = find(docs, "Deployment", "mock-model")["spec"]["template"]["spec"]["containers"][0]
    assert mock["image"] == "registry.example/runner:custom"


def test_all_gateway_credentials_are_initialized_in_cluster():
    docs = render()
    assert not any(item["kind"] == "Secret" for item in docs)
    [job] = [item for item in docs if item["kind"] == "Job"]
    assert job["metadata"]["annotations"]["helm.sh/hook"] == "pre-install,pre-upgrade,pre-rollback"
    container = job["spec"]["template"]["spec"]["containers"][0]
    assert container["image"] == "ghcr.io/tasklattice/tali-guard-controller:dev"
    specs = json.loads(next(item["value"] for item in container["env"] if item["name"] == "BOOTSTRAP_SECRETS"))
    gateway_specs = [item for item in specs if item["name"].startswith("tali-guard-litellm")]
    assert [item["kind"] for item in gateway_specs] == ["database", "litellm"]
    assert gateway_specs[1]["databaseSecret"] == gateway_specs[0]["name"]
    assert any(item["name"] == "tali-guard-postgresql-init" for item in specs)
    role = find(docs, "Role")
    assert set(role["rules"][0]["resourceNames"]) == {item["name"] for item in specs}


@pytest.mark.parametrize("field", ["masterKey", "saltKey", "ui.password", "postgresql.password", "model.upstream.apiKey"])
def test_gateway_ignores_inline_credential_values(field):
    assert render("--set", f"litellm-provider.{field}=unsupported") == render()


def test_platform_metadata_does_not_block_gateway_rendering(tmp_path):
    labels = {"company.example/team": "platform"}
    overrides = tmp_path / "platform-values.yaml"
    overrides.write_text(yaml.safe_dump({
        "global": {"labels": labels, "deploymentId": 123},
        "commonLabels": labels,
        "litellm-provider": {
            "ui": {"labels": labels},
            "postgresql": {"labels": labels},
            "model": {"upstream": {"labels": labels}},
        },
    }))
    assert render("--values", str(overrides)) == render()


def test_gateway_services_select_only_their_own_workloads():
    docs = render()
    workloads = [item for item in docs if item["kind"] in {"Deployment", "StatefulSet"}]
    for service in [item for item in docs if item["kind"] == "Service" and "postgresql" in item["metadata"]["name"]]:
        selector = service["spec"]["selector"]
        selected = [item["metadata"]["name"] for item in workloads if selector.items() <= item["spec"]["template"]["metadata"]["labels"].items()]
        assert selected == [service["metadata"]["name"]]
    for item in docs:
        if "litellm" in item["metadata"]["name"]:
            assert item["metadata"]["labels"]["app.kubernetes.io/instance"] == "tali-guard"


def test_gateway_requires_shared_secret_initialization():
    result = subprocess.run(
        ["helm", "template", "tali-guard", str(CHART), "--set", "litellm-provider.enabled=true", "--set", "security.bootstrap.enabled=false"],
        capture_output=True, text=True,
    )
    assert result.returncode != 0
    assert "litellm-provider.enabled requires security.bootstrap.enabled" in result.stderr
