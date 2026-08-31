from __future__ import annotations

import hashlib

import pytest

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from runner.toolkit.runtime.contracts import RequestContext
from runner.artifact_store import ArtifactStore
from runner.compiler import DefaultRunnerCompiler
from runner import generated as protocol
from runner.protocol_codec import (
    integration_verification_to_proto,
    plan_to_proto,
    traffic_scope_to_proto,
)


class Registry:
    def __init__(self) -> None:
        self.reloads = 0

    def validate(self, _plan, _config) -> None:
        return None

    def reload(self) -> None:
        self.reloads += 1


def test_runner_verifies_and_restores_complete_last_known_good(tmp_path):
    private_key = Ed25519PrivateKey.generate()
    public_path = tmp_path / "public.pem"
    public_path.write_bytes(private_key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ))
    artifact = _artifact()
    artifact.artifact_id = "artifact-1"
    artifact.signature = _signature(private_key, artifact.checksum)
    credential = "tg_runtime_secret"
    desired = protocol.DesiredState(
        generation=7,
        artifacts=[artifact],
        deployments=[protocol.DeploymentRoute(
            deployment_id="fallback",
            guardrail_id="guardrail-1",
            artifact_id="artifact-1",
            integration_id="integration-1",
            route_order=2,
            traffic_scope=traffic_scope_to_proto({"combinator": "and", "conditions": []}),
        ), protocol.DeploymentRoute(
            deployment_id="production",
            guardrail_id="guardrail-1",
            artifact_id="artifact-1",
            integration_id="integration-1",
            route_order=1,
            traffic_scope=traffic_scope_to_proto({
                "combinator": "and",
                "conditions": [{"field": "target.environment", "operator": "equals", "value": "production"}],
            }),
        )],
        integrations=[protocol.IntegrationRuntime(
            integration_id="integration-1",
            adapter="http",
            verification=integration_verification_to_proto({"credentials": [{
                "id": "runtime",
                "sha256": hashlib.sha256(credential.encode()).hexdigest(),
                "keyHint": "tg_run…cret",
                "createdAt": "2026-08-20T00:00:00Z",
            }]}),
        )],
    )

    first = ArtifactStore(public_path, tmp_path / "state")
    first_registry = Registry()
    first.attach_registry(first_registry)  # type: ignore[arg-type]
    first.apply(desired)
    assert first.generation == 7
    assert first.authenticate_integration("integration-1", credential)
    assert first.integration_adapter("integration-1") == "http"
    selected = first.resolve(RequestContext(
        protocol="http",
        integration_id="integration-1",
        fields=(("target.environment", "production"),),
    ))
    assert selected.deployment_id == "production"

    restarted = ArtifactStore(public_path, tmp_path / "state")
    restarted_registry = Registry()
    restarted.attach_registry(restarted_registry)  # type: ignore[arg-type]
    assert restarted.generation == 7
    assert restarted.integration_adapter("integration-1") == "http"
    assert restarted.resolve(RequestContext(protocol="http", integration_id="integration-1")).deployment_id == "fallback"
    assert restarted_registry.reloads == 1


def test_runner_accepts_active_multi_credentials_and_rejects_revoked_credentials(tmp_path):
    private_key = Ed25519PrivateKey.generate()
    public_path = tmp_path / "public.pem"
    public_path.write_bytes(private_key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ))
    current = "tg_current_secret"
    second = "tg_second_secret"
    revoked = "tg_revoked_secret"
    store = ArtifactStore(public_path, tmp_path / "state")
    store.attach_registry(Registry())  # type: ignore[arg-type]
    store.apply(protocol.DesiredState(
        generation=1,
        integrations=[protocol.IntegrationRuntime(
            integration_id="integration-1",
            adapter="http",
            verification=integration_verification_to_proto({
                "credentials": [
                    {
                        "id": "current",
                        "sha256": hashlib.sha256(current.encode()).hexdigest(),
                        "keyHint": "tg_cur…cret",
                        "createdAt": "2026-08-20T00:00:00Z",
                        "revokedAt": None,
                    },
                    {
                        "id": "second",
                        "sha256": hashlib.sha256(second.encode()).hexdigest(),
                        "keyHint": "tg_sec…cret",
                        "createdAt": "2026-08-20T00:00:00Z",
                    },
                    {
                        "id": "revoked",
                        "sha256": hashlib.sha256(revoked.encode()).hexdigest(),
                        "keyHint": "tg_rev…cret",
                        "createdAt": "2026-08-20T00:00:00Z",
                        "revokedAt": "2026-08-20T00:00:00Z",
                    },
                ],
            }),
        )],
    ))

    assert store.authenticate_integration("integration-1", current)
    assert store.authenticate_integration("integration-1", second)
    assert not store.authenticate_integration("integration-1", revoked)
    assert not store.authenticate_integration("integration-1", "tg_unknown")


def test_protocol_rejects_malformed_integration_credentials() -> None:
    with pytest.raises(TypeError):
        protocol.IntegrationCredential(id="bad", sha256=42)  # type: ignore[arg-type]


def _artifact() -> protocol.Artifact:
    plan = {
        "guardrail_id": "guardrail-1",
        "guardrail_version": 1,
        "compiler_version": "tasklattice-controller-plan-v1",
        "safety_level": "balanced",
        "output_delivery": "full_buffered",
        "steps": [{
            "id": "secrets:deterministic", "risk": "secrets", "stage": "deterministic",
            "phases": ["input", "output"], "on_unsafe": "redact", "escalation": "never", "parameters": [],
        }],
        "modules": [{
            "id": "data_protection:input", "module": "data_protection", "phase": "input",
            "step_ids": ["secrets:deterministic"], "depends_on": [], "input_view": "original",
            "required_for_release": True, "timeout_ms": 750, "failure_mode": "fail_closed",
        }, {
            "id": "data_protection:output", "module": "data_protection", "phase": "output",
            "step_ids": ["secrets:deterministic"], "depends_on": [], "input_view": "original",
            "required_for_release": True, "timeout_ms": 750, "failure_mode": "fail_closed",
        }],
        "reasoning_policies": [], "policy_versions": [], "policy_bindings": [],
    }
    return DefaultRunnerCompiler().compile(protocol.CompileRequest(
        compile_id="compile-1",
        guardrail_id="guardrail-1",
        guardrail_version=1,
        generation=7,
        plan=plan_to_proto(plan),
        runtime_profile="auto",
    ))


def _signature(private_key: Ed25519PrivateKey, checksum: str) -> str:
    import base64
    return base64.b64encode(private_key.sign(checksum.encode())).decode()
