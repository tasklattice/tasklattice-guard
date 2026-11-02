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
    values["runner"]["telemetryProgress"]["persistence"]["enabled"] = False
    rows = documents(render(tmp_path, values))
    for row in runners(rows):
        assert "volumeClaimTemplates" not in row["spec"]
        assert "GUARD_RUNNER_TELEMETRY_PROGRESS_ENABLED" not in env(row)


def test_rendered_rollout_provisions_a_separate_bounded_claim_per_stable_runner_replica(tmp_path: Path):
    rows = documents(render(tmp_path, fixture()))
    sets = runners(rows)
    assert len(sets) == 2
    assert sum(row["spec"]["replicas"] for row in sets) == 3
    assert sum(row["spec"]["replicas"] * 64 for row in sets) == 192  # Mi of requested PVC storage
    assert len({row["metadata"]["name"] for row in sets}) == 2
    for row in sets:
        claim, = row["spec"]["volumeClaimTemplates"]
        assert claim["metadata"]["name"] == "telemetry-progress"
        assert claim["spec"]["resources"]["requests"]["storage"] == "64Mi"
        assert claim["spec"]["storageClassName"] == "test-persistent-rwo"
        assert claim["spec"]["accessModes"] == ["ReadWriteOnce"]
        variables = env(row)
        assert variables["GUARD_RUNNER_TELEMETRY_PROGRESS_ENABLED"]["value"] == "true"
        assert variables["GUARD_RUNNER_TELEMETRY_PROGRESS_PATH"]["value"] == "/var/lib/tasklattice/telemetry-progress"
        assert variables["GUARD_RUNNER_ID"]["valueFrom"]["fieldRef"]["fieldPath"] == "metadata.name"
        pod = row["spec"]["template"]["spec"]
        mounts = {mount["name"]: mount for mount in pod["containers"][0]["volumeMounts"]}
        assert mounts["telemetry-progress"]["mountPath"] == variables["GUARD_RUNNER_TELEMETRY_PROGRESS_PATH"]["value"]
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


def test_storage_class_defaults_to_cluster_selection_and_size_is_configurable(tmp_path: Path):
    values = fixture()
    values["runner"]["telemetryProgress"]["persistence"].update(size="128Mi", storageClass="")
    for row in runners(documents(render(tmp_path, values))):
        claim, = row["spec"]["volumeClaimTemplates"]
        assert "storageClassName" not in claim["spec"]
        assert claim["spec"]["resources"]["requests"]["storage"] == "128Mi"


@pytest.mark.parametrize("mutation", ["no_pool_auth", "no_scoped_telemetry", "no_persistence", "storage_without_progress"])
def test_incomplete_or_ephemeral_rollout_fails_before_creating_a_runner(tmp_path: Path, mutation: str):
    values = fixture()
    if mutation == "no_pool_auth":
        values["security"]["poolAuthentication"]["enabled"] = False
    elif mutation == "no_scoped_telemetry":
        values["security"]["poolAuthentication"]["scopedTelemetry"] = False
    elif mutation == "no_persistence":
        values["runner"]["telemetryProgress"]["persistence"]["enabled"] = False
    else:
        values["security"]["poolAuthentication"]["telemetryProgress"] = False
    result = render(tmp_path, values)
    assert result.returncode != 0
    assert "telemetryProgress" in result.stderr or "scopedTelemetry" in result.stderr


@pytest.mark.parametrize("path,value", [
    (("security", "poolAuthentication", "telemetryProgress"), "true"),
    (("runner", "telemetryProgress", "persistence", "enabled"), "true"),
    (("runner", "telemetryProgress", "persistence", "size"), "0Mi"),
    (("runner", "telemetryProgress", "persistence", "size"), "64"),
    (("runner", "telemetryProgress", "persistence", "size"), "64Mi\nvolume: injected"),
    (("runner", "telemetryProgress", "persistence", "storageClass"), []),
])
def test_invalid_progress_values_are_rejected_by_schema(tmp_path: Path, path: tuple, value):
    values = copy.deepcopy(fixture())
    cursor = values
    for part in path[:-1]:
        cursor = cursor[part]
    cursor[path[-1]] = value
    result = render(tmp_path, values)
    assert result.returncode != 0
    assert "values don't meet the specifications" in result.stderr
