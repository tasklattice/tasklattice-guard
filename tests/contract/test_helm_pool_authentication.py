from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
CHART = ROOT / "charts" / "tali-guard"
pytestmark = pytest.mark.skipif(shutil.which("helm") is None, reason="helm is not installed")


def render(tmp_path: Path, pool_auth: dict | None = None, *, pools: bool = False, http_auth: dict | None = None):
    values = {
        "postgresql": {"enabled": True},
        "security": {"bootstrapAdmin": {"email": "admin@example.test"}},
        "runner": {"default": {"replicaCount": 1}},
    }
    if pools:
        values["runner"]["pools"] = [{"name": "batch", "replicaCount": 1, "maxConcurrency": 4,
                                      "resources": {"requests": {"memory": "1Gi"}, "limits": {"memory": "2Gi"}}}]
    if pool_auth is not None:
        values["security"]["poolAuthentication"] = pool_auth
    if http_auth is not None:
        values["security"]["runnerHttpAuthentication"] = http_auth
    path = tmp_path / "values.yaml"
    path.write_text(yaml.safe_dump(values))
    return subprocess.run(["helm", "template", "guard", str(CHART), "-f", str(path)],
                          capture_output=True, text=True, check=False, timeout=30)


def auth_refs():
    return {"enabled": True, "controllerSecret": "controller-pool-map", "controllerKey": "map.json",
            "runnerSecrets": {"default": {"name": "default-pool-token", "key": "token"},
                              "batch": {"name": "batch-pool-token", "key": "token"}}}


def http_refs():
    return {"enabled": True, "controllerSecret": "controller-http-map", "controllerKey": "http-map.json",
            "runnerSecrets": {"default": {"name": "default-http-token", "key": "token"},
                              "batch": {"name": "batch-http-token", "key": "token"}}}


def env(document, name):
    entries = document["spec"]["template"]["spec"]["containers"][0]["env"]
    return next(item for item in entries if item["name"] == name)


def test_legacy_chart_does_not_enable_scoped_authentication(tmp_path: Path):
    result = render(tmp_path)
    assert result.returncode == 0, result.stderr
    assert "CONTROLLER_RUNNER_POOL_TOKENS_JSON" not in result.stdout
    assert "GUARD_RUNNER_CONTROL_TOKEN" not in result.stdout
    assert "GUARD_CONTROLLER_HTTP_TOKEN" not in result.stdout
    assert "CONTROLLER_RUNNER_HTTP_TOKENS_JSON" not in result.stdout


def test_pool_tokens_are_injected_only_as_secret_references(tmp_path: Path):
    result = render(tmp_path, auth_refs(), pools=True)
    assert result.returncode == 0, result.stderr
    documents = [doc for doc in yaml.safe_load_all(result.stdout) if doc]
    controller = next(doc for doc in documents if doc.get("kind") == "Deployment"
                      and doc["metadata"]["labels"].get("app.kubernetes.io/component") == "controller")
    statefulsets = [doc for doc in documents if doc.get("kind") == "StatefulSet"
                    and doc["metadata"]["labels"].get("app.kubernetes.io/component") == "runner"]

    assert env(controller, "CONTROLLER_RUNNER_POOL_TOKENS_JSON")["valueFrom"]["secretKeyRef"] == {
        "name": "controller-pool-map", "key": "map.json"}
    assert len(statefulsets) == 2
    for item in statefulsets:
        pool = item["metadata"]["labels"]["tasklattice.io/runner-pool"]
        assert env(item, "GUARD_RUNNER_CONTROL_TOKEN")["valueFrom"]["secretKeyRef"] == auth_refs()["runnerSecrets"][pool]


@pytest.mark.parametrize("mutation", ["missing_pool", "unknown_pool", "duplicate_key", "controller_key", "missing_map", "disabled_refs"])
def test_invalid_or_partial_pool_configuration_fails_closed(tmp_path: Path, mutation: str):
    refs = auth_refs()
    if mutation == "missing_pool":
        del refs["runnerSecrets"]["batch"]
    elif mutation == "unknown_pool":
        refs["runnerSecrets"]["typo"] = {"name": "other-token", "key": "token"}
    elif mutation == "duplicate_key":
        refs["runnerSecrets"]["batch"] = refs["runnerSecrets"]["default"].copy()
    elif mutation == "controller_key":
        refs["runnerSecrets"]["batch"] = {"name": refs["controllerSecret"], "key": refs["controllerKey"]}
    elif mutation == "missing_map":
        refs["controllerSecret"] = ""
    else:
        refs["enabled"] = False
    result = render(tmp_path, refs, pools=True)
    assert result.returncode != 0
    assert "security.poolAuthentication" in result.stderr or "each Runner pool" in result.stderr


@pytest.mark.parametrize("scoped_telemetry", [False, True])
def test_inbound_http_authority_uses_separate_per_pool_secret_refs(tmp_path: Path, scoped_telemetry: bool):
    control = auth_refs()
    control["scopedTelemetry"] = scoped_telemetry
    result = render(tmp_path, control, pools=True, http_auth=http_refs())
    assert result.returncode == 0, result.stderr
    documents = [doc for doc in yaml.safe_load_all(result.stdout) if doc]
    controller = next(doc for doc in documents if doc.get("kind") == "Deployment"
                      and doc["metadata"]["labels"].get("app.kubernetes.io/component") == "controller")
    assert env(controller, "CONTROLLER_RUNNER_HTTP_TOKENS_JSON")["valueFrom"]["secretKeyRef"] == {
        "name": "controller-http-map", "key": "http-map.json"}
    config = next(doc for doc in documents if doc.get("kind") == "ConfigMap" and "CONTROLLER_RUNNER_SCOPED_TELEMETRY" in doc.get("data", {}))
    assert config["data"]["CONTROLLER_RUNNER_SCOPED_TELEMETRY"] == str(scoped_telemetry).lower()
    for runner in [doc for doc in documents if doc.get("kind") == "StatefulSet"
                   and doc["metadata"]["labels"].get("app.kubernetes.io/component") == "runner"]:
        pool = runner["metadata"]["labels"]["tasklattice.io/runner-pool"]
        assert env(runner, "GUARD_CONTROLLER_HTTP_TOKEN")["valueFrom"]["secretKeyRef"] == http_refs()["runnerSecrets"][pool]
        assert env(runner, "GUARD_RUNNER_CONTROL_TOKEN")["valueFrom"]["secretKeyRef"] == control["runnerSecrets"][pool]
        names = {item["name"] for item in runner["spec"]["template"]["spec"]["containers"][0]["env"]}
        assert ("GUARD_CONTROLLER_TOKEN" not in names) == scoped_telemetry
        assert ("GUARD_RUNNER_SCOPED_TELEMETRY" in names) == scoped_telemetry


@pytest.mark.parametrize("mutation", ["missing_pool", "unknown_pool", "duplicate_key", "controller_key", "control_role_key", "control_map_key", "missing_map", "disabled_refs", "missing_control_mode"])
def test_invalid_http_roles_fail_closed(tmp_path: Path, mutation: str):
    control = auth_refs()
    inbound = http_refs()
    if mutation == "missing_pool":
        del inbound["runnerSecrets"]["batch"]
    elif mutation == "unknown_pool":
        inbound["runnerSecrets"]["typo"] = {"name": "unused", "key": "token"}
    elif mutation == "duplicate_key":
        inbound["runnerSecrets"]["batch"] = inbound["runnerSecrets"]["default"].copy()
    elif mutation == "controller_key":
        inbound["runnerSecrets"]["batch"] = {"name": inbound["controllerSecret"], "key": inbound["controllerKey"]}
    elif mutation == "control_role_key":
        inbound["runnerSecrets"]["batch"] = control["runnerSecrets"]["batch"].copy()
    elif mutation == "control_map_key":
        inbound["controllerSecret"], inbound["controllerKey"] = control["controllerSecret"], control["controllerKey"]
    elif mutation == "missing_map":
        inbound["controllerSecret"] = ""
    elif mutation == "disabled_refs":
        inbound["enabled"] = False
    else:
        control = None
    result = render(tmp_path, control, pools=True, http_auth=inbound)
    assert result.returncode != 0


def test_scoped_telemetry_cannot_be_enabled_without_pool_credentials(tmp_path: Path):
    result = render(tmp_path, {"enabled": False, "scopedTelemetry": True}, pools=True)
    assert result.returncode != 0
    assert "scopedTelemetry" in result.stderr
