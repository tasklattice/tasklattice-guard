from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
CHART = ROOT / "charts" / "tali-guard"
pytestmark = pytest.mark.skipif(shutil.which("helm") is None, reason="helm is not installed")


def render(tmp_path: Path, pool_auth: dict | None = None, *, http_auth: dict | None = None):
    values = {
        "postgresql": {"enabled": True},
        "security": {"bootstrapAdmin": {"email": "admin@example.test"}},
        "runner": {"default": {"replicaCount": 1}},
    }
    if pool_auth is not None:
        values["security"]["poolAuthentication"] = pool_auth
    if http_auth is not None:
        values["security"]["runnerHttpAuthentication"] = http_auth
    path = tmp_path / "values.yaml"
    path.write_text(yaml.safe_dump(values))
    return subprocess.run(["helm", "template", "guard", str(CHART), "-f", str(path)],
                          capture_output=True, text=True, check=False, timeout=30)


def auth_refs():
    return {"controllerSecret": "controller-pool-map", "controllerKey": "map.json",
            "runnerSecrets": {"default": {"name": "default-pool-token", "key": "token"}}}


def http_refs():
    return {"controllerSecret": "controller-http-map", "controllerKey": "http-map.json",
            "runnerSecrets": {"default": {"name": "default-http-token", "key": "token"}}}


def runner_auth_refs(documents):
    workloads = {doc["metadata"]["labels"]["app.kubernetes.io/component"]: doc
                 for doc in documents if doc["kind"] in {"Deployment", "StatefulSet"}}
    names = {
        "controller": ("CONTROLLER_RUNNER_POOL_TOKENS_JSON", "CONTROLLER_RUNNER_HTTP_TOKENS_JSON"),
        "runner": ("GUARD_RUNNER_CONTROL_TOKEN", "GUARD_CONTROLLER_HTTP_TOKEN"),
    }
    return {
        env["name"]: env["valueFrom"]["secretKeyRef"]
        for role, keys in names.items()
        for env in workloads[role]["spec"]["template"]["spec"]["containers"][0]["env"]
        if env["name"] in keys
    }


def bootstrap_specs(documents):
    job = next(doc for doc in documents if doc["kind"] == "Job")
    env = job["spec"]["template"]["spec"]["containers"][0]["env"]
    return json.loads(next(item["value"] for item in env if item["name"] == "BOOTSTRAP_SECRETS"))


def test_default_pool_uses_matching_managed_secret_references(tmp_path: Path):
    result = render(tmp_path)
    assert result.returncode == 0, result.stderr
    documents = [doc for doc in yaml.safe_load_all(result.stdout) if doc]
    secret = next(spec for spec in bootstrap_specs(documents) if spec["kind"] == "runnerAuth")["name"]
    assert runner_auth_refs(documents) == {
        "CONTROLLER_RUNNER_POOL_TOKENS_JSON": {"name": secret, "key": "pool-tokens.json"},
        "CONTROLLER_RUNNER_HTTP_TOKENS_JSON": {"name": secret, "key": "pool-http-tokens.json"},
        "GUARD_RUNNER_CONTROL_TOKEN": {"name": secret, "key": "runner-control-token"},
        "GUARD_CONTROLLER_HTTP_TOKEN": {"name": secret, "key": "controller-http-token"},
    }
    assert all(doc["kind"] != "Secret" or doc["metadata"]["name"] != secret for doc in documents)
    role = next(doc for doc in documents if doc["kind"] == "Role")
    assert secret in role["rules"][0]["resourceNames"]


def test_external_runner_roles_use_only_the_referenced_secret_keys(tmp_path: Path):
    control = auth_refs()
    inbound = http_refs()
    result = render(tmp_path, control, http_auth=inbound)
    assert result.returncode == 0, result.stderr
    documents = [doc for doc in yaml.safe_load_all(result.stdout) if doc]
    assert runner_auth_refs(documents) == {
        "CONTROLLER_RUNNER_POOL_TOKENS_JSON": {"name": control["controllerSecret"], "key": control["controllerKey"]},
        "CONTROLLER_RUNNER_HTTP_TOKENS_JSON": {"name": inbound["controllerSecret"], "key": inbound["controllerKey"]},
        "GUARD_RUNNER_CONTROL_TOKEN": control["runnerSecrets"]["default"],
        "GUARD_CONTROLLER_HTTP_TOKEN": inbound["runnerSecrets"]["default"],
    }
    assert all(spec["kind"] != "runnerAuth" for spec in bootstrap_specs(documents))


@pytest.mark.parametrize("role", ["control", "http"])
@pytest.mark.parametrize("mutation", ["missing_pool", "unknown_pool", "controller_key", "missing_map"])
def test_invalid_external_runner_roles_fail_render(tmp_path: Path, role: str, mutation: str):
    control, inbound = auth_refs(), http_refs()
    refs = control if role == "control" else inbound
    if mutation == "missing_pool":
        del refs["runnerSecrets"]["default"]
    elif mutation == "unknown_pool":
        refs["runnerSecrets"]["typo"] = {"name": "other-token", "key": "token"}
    elif mutation == "controller_key":
        refs["runnerSecrets"]["default"] = {"name": refs["controllerSecret"], "key": refs["controllerKey"]}
    else:
        refs["controllerSecret"] = ""
    result = render(tmp_path, control, http_auth=inbound)
    assert result.returncode != 0


def test_runner_roles_require_distinct_secret_keys(tmp_path: Path):
    control, inbound = auth_refs(), http_refs()
    inbound["runnerSecrets"]["default"] = control["runnerSecrets"]["default"]
    result = render(tmp_path, control, http_auth=inbound)
    assert result.returncode != 0
    assert "distinct Secret keys" in result.stderr
