import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.skipif(shutil.which("helm") is None, reason="helm is not installed")
POLICY = {"maxRowsPerPool": 128, "maxRowsGlobal": 512, "maxPayloadBytesPerContext": 32768,
          "maxPayloadBytesPerPool": 8388608, "maxPayloadBytesGlobal": 33554432}


def render(tmp_path, policy):
    values = {"postgresql": {"enabled": True}, "runner": {"default": {"replicaCount": 1}},
              "security": {"bootstrapAdmin": {"email": "admin@example.test"}}, "controller": {}}
    if policy is not None:
        values["controller"]["endpointContextStorage"] = policy
    path = tmp_path / "storage-values.yaml"
    path.write_text(yaml.safe_dump(values))
    return subprocess.run(["helm", "template", "guard", str(ROOT / "charts/tali-guard"), "-f", str(path)],
                          text=True, capture_output=True, timeout=30)


def test_complete_controller_budget_overrides_reach_the_runtime_config(tmp_path):
    result = render(tmp_path, POLICY)
    assert result.returncode == 0, result.stderr
    config = next(doc for doc in yaml.safe_load_all(result.stdout) if doc and doc.get("kind") == "ConfigMap"
                  and "CONTROLLER_PUBLIC_URL" in doc.get("data", {}))["data"]
    assert {key: value for key, value in config.items() if key.startswith("CONTROLLER_ENDPOINT_CONTEXT_")} == {
        "CONTROLLER_ENDPOINT_CONTEXT_MAX_ROWS_PER_POOL": "128",
        "CONTROLLER_ENDPOINT_CONTEXT_MAX_ROWS_GLOBAL": "512",
        "CONTROLLER_ENDPOINT_CONTEXT_MAX_PAYLOAD_BYTES_PER_CONTEXT": "32768",
        "CONTROLLER_ENDPOINT_CONTEXT_MAX_PAYLOAD_BYTES_PER_POOL": "8388608",
        "CONTROLLER_ENDPOINT_CONTEXT_MAX_PAYLOAD_BYTES_GLOBAL": "33554432",
    }


def test_chart_uses_controller_budget_defaults_without_implicitly_enabling_scoped_mode(tmp_path):
    result = render(tmp_path, None)
    assert result.returncode == 0, result.stderr
    assert "CONTROLLER_ENDPOINT_CONTEXT_MAX_" not in result.stdout
    assert 'CONTROLLER_RUNNER_SCOPED_TELEMETRY: "false"' in result.stdout


@pytest.mark.parametrize("policy", [{}, {**POLICY, "unknown": 1}, {**POLICY, "maxRowsPerPool": 513},
    {**POLICY, "maxRowsGlobal": 0}, {**POLICY, "maxPayloadBytesPerContext": 8388609},
    {**POLICY, "maxPayloadBytesGlobal": 8388607}, {**POLICY, "maxRowsPerPool": True}])
def test_invalid_or_partial_budgets_fail_chart_validation(tmp_path, policy):
    result = render(tmp_path, policy)
    assert result.returncode != 0
    assert "endpointContextStorage" in result.stderr
