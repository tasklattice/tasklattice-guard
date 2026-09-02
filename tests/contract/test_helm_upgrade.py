from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import textwrap
import uuid

import pytest


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "helm-upgrade.sh"


@pytest.fixture
def fake_helm(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    log = tmp_path / "helm-calls.jsonl"
    executable = tmp_path / "helm"
    executable.write_text(
        f"#!{sys.executable}\n" + textwrap.dedent("""\
        import json
        import os
        import sys

        with open(os.environ["HELM_TEST_LOG"], "a") as log:
            log.write(json.dumps(sys.argv[1:]) + "\\n")
        if sys.argv[1] == "status":
            status = os.environ.get("HELM_TEST_STATUS", "deployed")
            if status == "missing":
                print("Error: release: not found", file=sys.stderr)
                sys.exit(1)
            if status == "error":
                print(os.environ["HELM_TEST_ERROR"], file=sys.stderr)
                sys.exit(7)
            print(f"NAME: guard\\nSTATUS: {status}\\nREVISION: 2")
        else:
            sys.exit(int(os.environ.get("HELM_TEST_ACTION_EXIT", "0")))
        """)
    )
    executable.chmod(0o755)
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("HELM_TEST_LOG", str(log))
    return log


def run_helper() -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "bash", str(SCRIPT), "guard", "chart with spaces", "local-context", "guard-ns",
            "--values", "values with spaces.yaml", "--set-string", "message=two words",
            "--timeout", "30s",
        ],
        capture_output=True,
        text=True,
        check=False,
    )


def read_calls(log: Path) -> list[list[str]]:
    return [json.loads(line) for line in log.read_text().splitlines()]


@pytest.mark.parametrize(
    ("status", "action"),
    [
        ("deployed", ["upgrade"]),
        ("failed", ["upgrade"]),
        ("pending-upgrade", ["upgrade"]),
        ("missing", ["install", "--create-namespace"]),
        ("uninstalled", ["install", "--replace", "--create-namespace"]),
    ],
)
def test_selects_explicit_action_with_client_side_apply(
    fake_helm: Path, monkeypatch: pytest.MonkeyPatch, status: str, action: list[str],
):
    monkeypatch.setenv("HELM_TEST_STATUS", status)

    result = run_helper()

    assert result.returncode == 0, result.stderr
    assert read_calls(fake_helm) == [
        ["status", "guard", "--kube-context", "local-context", "--namespace", "guard-ns"],
        [
            *action, "guard", "chart with spaces",
            "--kube-context", "local-context", "--namespace", "guard-ns",
            "--values", "values with spaces.yaml", "--set-string", "message=two words",
            "--timeout", "30s", "--server-side=false",
        ],
    ]


@pytest.mark.parametrize(
    "error",
    [
        "Error: Kubernetes cluster unreachable: connection refused",
        "Error: query: failed to query with labels: secrets is forbidden",
        "Error: context local-context not found",
    ],
)
def test_cluster_errors_never_trigger_install(
    fake_helm: Path, monkeypatch: pytest.MonkeyPatch, error: str,
):
    monkeypatch.setenv("HELM_TEST_STATUS", "error")
    monkeypatch.setenv("HELM_TEST_ERROR", error)

    result = run_helper()

    assert result.returncode == 7
    assert error in result.stderr
    assert len(read_calls(fake_helm)) == 1


@pytest.mark.parametrize("status", ["deployed", "missing"])
def test_deployment_errors_are_returned_without_reinstall_or_force(
    fake_helm: Path, monkeypatch: pytest.MonkeyPatch, status: str,
):
    monkeypatch.setenv("HELM_TEST_STATUS", status)
    monkeypatch.setenv("HELM_TEST_ACTION_EXIT", "9")

    assert run_helper().returncode == 9
    assert len(read_calls(fake_helm)) == 2


@pytest.mark.parametrize("suffix", ["", "-debug"])
def test_make_install_builds_then_upserts_and_waits_for_readiness(suffix: str):
    result = subprocess.run(
        ["make", "--no-print-directory", "-n", f"install{suffix}", "HELM_ROLLOUT_REVISION=regression"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.count("bash scripts/helm-upgrade.sh") == 1
    assert result.stdout.index("docker build") < result.stdout.index("bash scripts/helm-upgrade.sh")
    assert "helm upgrade --install" not in result.stdout
    assert "--wait" in result.stdout
    assert "--timeout 5m" in result.stdout
    if suffix:
        assert "--values charts/tali-guard/values-debug.yaml" in result.stdout


@pytest.mark.skipif(
    not os.environ.get("GUARD_HELM_TEST_CONTEXT"),
    reason="Set GUARD_HELM_TEST_CONTEXT for the isolated Kubernetes lifecycle regression.",
)
def test_real_cluster_install_upgrade_and_retained_secret_reinstall(tmp_path: Path):
    """No application workloads or provider keys; only test-owned Secret/ConfigMap."""
    context = os.environ["GUARD_HELM_TEST_CONTEXT"]
    namespace = f"guard-helm-regression-{uuid.uuid4().hex[:12]}"
    release = "guard-regression"
    cluster_args = ["--kube-context", context, "--namespace", namespace]
    templates = tmp_path / "templates"
    templates.mkdir()
    (tmp_path / "Chart.yaml").write_text(
        "apiVersion: v2\nname: guard-helm-regression\nversion: 0.1.0\n"
    )
    (templates / "resources.yaml").write_text(textwrap.dedent("""\
        {{- $existing := lookup "v1" "Secret" .Release.Namespace "retained-token" }}
        apiVersion: v1
        kind: Secret
        metadata:
          name: retained-token
          annotations:
            helm.sh/resource-policy: keep
        type: Opaque
        data:
          token: {{ if $existing }}{{ index $existing.data "token" }}{{ else }}{{ randAlphaNum 32 | b64enc }}{{ end }}
        ---
        apiVersion: v1
        kind: ConfigMap
        metadata:
          name: deployment-marker
        data:
          marker: {{ .Values.marker | quote }}
        """))

    def run(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(args, check=True, capture_output=True, text=True, timeout=60)

    def deploy(marker: str):
        run(
            "bash", str(SCRIPT), release, str(tmp_path), context, namespace,
            "--set-string", f"marker={marker}", "--timeout", "30s",
        )
        result = run(
            "kubectl", "--context", context, "--namespace", namespace,
            "get", "configmap", "deployment-marker", "-o", "json",
        )
        assert json.loads(result.stdout)["data"]["marker"] == marker

    def retained_secret() -> tuple[str, dict]:
        result = run(
            "kubectl", "--context", context, "--namespace", namespace,
            "get", "secret", "retained-token", "-o", "json",
        )
        secret = json.loads(result.stdout)
        return secret["metadata"]["uid"], secret["data"]

    try:
        deploy("first-install")
        original_secret = retained_secret()
        deploy("upgrade")
        assert retained_secret() == original_secret

        run("helm", "uninstall", release, *cluster_args, "--timeout", "30s")
        deploy("reinstall-with-kept-secret")
        assert retained_secret() == original_secret

        run("helm", "uninstall", release, *cluster_args, "--keep-history", "--timeout", "30s")
        deploy("reinstall-with-kept-history")
        assert retained_secret() == original_secret
    finally:
        # The random namespace contains only this test's resources, including
        # the deliberately retained Secret and Helm release records.
        run(
            "kubectl", "--context", context, "delete", "namespace", namespace,
            "--ignore-not-found", "--wait=false",
        )
