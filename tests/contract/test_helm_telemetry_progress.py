from __future__ import annotations

import copy
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
CHART = ROOT / "charts" / "tali-guard"
FIXTURE = Path(__file__).with_name("fixtures") / "telemetry-progress-values.yaml"
pytestmark = pytest.mark.skipif(shutil.which("helm") is None, reason="helm is not installed")


def render(tmp_path: Path, values: dict):
    path = tmp_path / "progress-values.yaml"
    path.write_text(yaml.safe_dump(values))
    return subprocess.run(["helm", "template", "guard", str(CHART), "-f", str(path)],
                          capture_output=True, text=True, check=False, timeout=30)


def fixture():
    return yaml.safe_load(FIXTURE.read_text())


def documents(result):
    assert result.returncode == 0, result.stderr
    return [row for row in yaml.safe_load_all(result.stdout) if row]


def runners(rows):
    return [row for row in rows if row["kind"] == "StatefulSet"
            and row["metadata"].get("labels", {}).get("app.kubernetes.io/component") == "runner"]


def env(row):
    return {entry["name"]: entry for entry in row["spec"]["template"]["spec"]["containers"][0]["env"]}


def test_default_mode_has_no_progress_pvc_mount_or_runner_enable_flag(tmp_path: Path):
    rows = documents(render(tmp_path, {"postgresql": {"enabled": True},
        "security": {"bootstrapAdmin": {"email": "admin@example.test"}},
        "runner": {"default": {"replicaCount": 1}}}))
    for row in runners(rows):
        assert "volumeClaimTemplates" not in row["spec"]
        assert "GUARD_RUNNER_TELEMETRY_PROGRESS_ENABLED" not in env(row)
        assert "GUARD_RUNNER_TELEMETRY_PROGRESS_PATH" not in env(row)
        container = row["spec"]["template"]["spec"]["containers"][0]
        assert "telemetry-progress" not in {mount["name"] for mount in container["volumeMounts"]}
    config = next(row for row in rows if row["kind"] == "ConfigMap"
                  and "CONTROLLER_RUNNER_TELEMETRY_PROGRESS" in row.get("data", {}))
    assert config["data"]["CONTROLLER_RUNNER_TELEMETRY_PROGRESS"] == "false"


def test_scoped_mode_alone_does_not_allocate_progress_storage(tmp_path: Path):
    values = fixture()
    values["security"]["poolAuthentication"]["telemetryProgress"] = False
    rows = documents(render(tmp_path, values))
    for row in runners(rows):
        assert "volumeClaimTemplates" not in row["spec"]
        assert "GUARD_RUNNER_TELEMETRY_PROGRESS_ENABLED" not in env(row)


def test_progress_uses_existing_ephemeral_runner_state_without_pvcs(tmp_path: Path):
    rows = documents(render(tmp_path, fixture()))
    sets = runners(rows)
    assert len(sets) == 1
    assert sum(row["spec"]["replicas"] for row in sets) == 2
    assert not any(row["kind"] == "PersistentVolumeClaim" for row in rows)
    assert len({row["metadata"]["name"] for row in sets}) == 1
    for row in sets:
        assert "volumeClaimTemplates" not in row["spec"]
        variables = env(row)
        assert variables["GUARD_RUNNER_TELEMETRY_PROGRESS_ENABLED"]["value"] == "true"
        assert "GUARD_RUNNER_TELEMETRY_PROGRESS_PATH" not in variables
        assert variables["GUARD_RUNNER_ID"]["valueFrom"]["fieldRef"]["fieldPath"] == "metadata.name"
        pod = row["spec"]["template"]["spec"]
        mounts = {mount["name"]: mount for mount in pod["containers"][0]["volumeMounts"]}
        assert "telemetry-progress" not in mounts
        assert mounts["state"]["mountPath"] == "/var/lib/tasklattice/guard-runner"
        assert next(volume for volume in pod["volumes"] if volume["name"] == "state")["emptyDir"]["sizeLimit"] == "2Gi"
        assert "telemetry-progress" not in {volume["name"] for volume in pod["volumes"]}
        assert pod["securityContext"]["fsGroup"] == 65532
        assert pod["containers"][0]["resources"]["limits"]["memory"] == "256Mi"
    config = next(row for row in rows if row["kind"] == "ConfigMap"
                  and "CONTROLLER_RUNNER_TELEMETRY_PROGRESS" in row.get("data", {}))
    assert config["data"]["CONTROLLER_RUNNER_TELEMETRY_PROGRESS"] == "true"
    assert config["data"]["CONTROLLER_RUNNER_SCOPED_TELEMETRY"] == "true"
    controller = next(row for row in rows if row["kind"] == "Deployment"
                      and row["metadata"].get("labels", {}).get("app.kubernetes.io/component") == "controller")
    assert env(controller)["CONTROLLER_RUNNER_TELEMETRY_PROGRESS"]["valueFrom"]["configMapKeyRef"]["key"] == "CONTROLLER_RUNNER_TELEMETRY_PROGRESS"


@pytest.mark.parametrize("mutation", ["no_pool_auth", "no_scoped_telemetry"])
def test_progress_requires_pool_authentication_and_scoped_telemetry(tmp_path: Path, mutation: str):
    values = fixture()
    if mutation == "no_pool_auth":
        values["security"]["poolAuthentication"]["enabled"] = False
    else:
        values["security"]["poolAuthentication"]["scopedTelemetry"] = False
    result = render(tmp_path, values)
    assert result.returncode != 0
    assert "telemetryProgress" in result.stderr or "scopedTelemetry" in result.stderr


@pytest.mark.parametrize("path,value", [
    (("security", "poolAuthentication", "telemetryProgress"), "true"),
    (("security", "poolAuthentication", "telemetryProgress"), {}),
])
def test_invalid_progress_values_are_rejected_by_template_validation(tmp_path: Path, path: tuple, value):
    values = copy.deepcopy(fixture())
    cursor = values
    for part in path[:-1]:
        cursor = cursor[part]
    cursor[path[-1]] = value
    result = render(tmp_path, values)
    assert result.returncode != 0
    assert "telemetryProgress" in result.stderr
