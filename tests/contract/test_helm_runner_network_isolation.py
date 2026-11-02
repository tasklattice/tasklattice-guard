from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.skipif(shutil.which("helm") is None, reason="helm is not installed")


def render(tmp_path: Path, isolation: dict, **overrides):
    values = {
        "postgresql": {"enabled": True}, "redis": {"enabled": True},
        "security": {"bootstrapAdmin": {"email": "admin@example.test"}},
        "runner": {"default": {"replicaCount": 1}, "pools": [
            {"name": "isolated", "replicaCount": 1, "maxConcurrency": 2,
             "resources": {"requests": {"memory": "256Mi"}, "limits": {"memory": "512Mi"}}}]},
        "networkPolicy": {"enabled": True, "runnerIsolation": isolation},
    }
    values.update(overrides)
    path = tmp_path / "network-values.yaml"
    path.write_text(yaml.safe_dump(values))
    return subprocess.run(["helm", "template", "guard", str(ROOT / "charts/tali-guard"), "-f", str(path)],
                          text=True, capture_output=True, check=False, timeout=30)


def policies(output: str):
    return [doc for doc in yaml.safe_load_all(output) if doc and doc.get("kind") == "NetworkPolicy"
            and doc["spec"]["podSelector"]["matchLabels"].get("app.kubernetes.io/component") == "runner"]


def test_default_does_not_isolate_runtime_ingress_or_egress(tmp_path: Path):
    result = render(tmp_path, {"enabled": False})
    assert result.returncode == 0, result.stderr
    assert policies(result.stdout) == []


def test_each_pool_denies_unlisted_peers_and_database_egress(tmp_path: Path):
    result = render(tmp_path, {"enabled": True})
    assert result.returncode == 0, result.stderr
    rendered = policies(result.stdout)
    assert len(rendered) == 2
    assert {doc["spec"]["podSelector"]["matchLabels"]["tasklattice.io/runner-pool"] for doc in rendered} == {"default", "isolated"}
    for doc in rendered:
        spec = doc["spec"]
        assert spec["policyTypes"] == ["Ingress", "Egress"]
        assert all(rule.get("from") and rule.get("ports") for rule in spec["ingress"])
        assert spec["ingress"][0]["from"][0]["podSelector"]["matchLabels"] == {
            "app.kubernetes.io/instance": "guard", "app.kubernetes.io/component": "controller"}
        assert spec["ingress"][0]["ports"] == [{"protocol": "TCP", "port": 8091}]
        assert all(rule.get("to") and rule.get("ports") for rule in spec["egress"])
        ports = {port["port"] for rule in spec["egress"] for port in rule["ports"]}
        assert ports == {8080, 9090, 6379, 53}
        assert not any(peer.get("podSelector", {}).get("matchLabels", {}).get("app.kubernetes.io/component") == "runner"
                       for rule in spec["egress"] for peer in rule["to"])
        dns = next(rule for rule in spec["egress"] if rule["ports"][0]["port"] == 53)
        assert dns["to"][0]["namespaceSelector"]["matchLabels"] == {"kubernetes.io/metadata.name": "kube-system"}
        assert dns["to"][0]["podSelector"]["matchLabels"] == {"k8s-app": "kube-dns"}


def test_gateway_ingress_and_provider_exception_are_explicit_and_pool_specific(tmp_path: Path):
    gateway = {"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "gateway"}},
               "podSelector": {"matchLabels": {"app": "trusted-runtime-gateway"}}}
    provider = {"to": [{"ipBlock": {"cidr": "192.0.2.9/32"}}], "ports": [{"protocol": "TCP", "port": 443}]}
    result = render(tmp_path, {"enabled": True, "ingressPeers": [gateway], "poolEgress": {"isolated": [provider]}})
    assert result.returncode == 0, result.stderr
    for doc in policies(result.stdout):
        spec = doc["spec"]
        assert spec["ingress"][1]["from"] == [gateway]
        pool = spec["podSelector"]["matchLabels"]["tasklattice.io/runner-pool"]
        assert (provider in spec["egress"]) == (pool == "isolated")


@pytest.mark.parametrize("isolation", [
    {"enabled": True, "poolEgress": {"typo": []}},
    {"enabled": True, "poolEgress": {"default": [{}]}},
    {"enabled": True, "poolEgress": {"default": [{"to": [], "ports": []}]}},
    {"enabled": True, "ingressPeers": [{}]},
    {"enabled": True, "dnsPeers": [{"ipBlock": {"cidr": "192.0.2.0/24"}, "podSelector": {}}]},
])
def test_ambiguous_or_incomplete_exceptions_are_rejected(tmp_path: Path, isolation: dict):
    result = render(tmp_path, isolation)
    assert result.returncode != 0
    assert "runnerIsolation" in result.stderr


def test_runner_isolation_cannot_claim_to_enable_when_base_policies_are_disabled(tmp_path: Path):
    result = render(tmp_path, {}, networkPolicy={"enabled": False, "runnerIsolation": {"enabled": True}})
    assert result.returncode != 0
    assert "runnerIsolation requires networkPolicy.enabled=true" in result.stderr
