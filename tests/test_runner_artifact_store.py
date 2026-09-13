from __future__ import annotations

import base64
import hashlib
from pathlib import Path

import pytest

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from runner.toolkit.runtime.contracts import RequestContext
from runner.artifact_store import ArtifactStore
from runner import generated as protocol
from runner.protocol_codec import (
    endpoint_verification_to_proto,
    traffic_scope_to_proto,
)


FIXTURE = Path(__file__).parent / "fixtures" / "artifacts" / "local-secrets-v1"


class Registry:
    def publish_release(self, release_id, candidates):
        self.release_id = release_id

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
        routers=[protocol.RouterRoute(
            router_id="fallback",
            guardrail_id="guardrail-1",
            artifact_id="artifact-1",
            endpoint_id="endpoint-1",
            route_order=2,
            traffic_scope=traffic_scope_to_proto({"combinator": "and", "conditions": []}),
        ), protocol.RouterRoute(
            router_id="production",
            guardrail_id="guardrail-1",
            artifact_id="artifact-1",
            endpoint_id="endpoint-1",
            route_order=1,
            traffic_scope=traffic_scope_to_proto({
                "combinator": "and",
                "conditions": [{"field": "target.environment", "operator": "equals", "value": "production"}],
            }),
        )],
        endpoints=[protocol.EndpointRuntime(
            endpoint_id="endpoint-1",
            adapter="http",
            verification=endpoint_verification_to_proto({"credentials": [{
                "id": "runtime",
                "sha256": hashlib.sha256(credential.encode()).hexdigest(),
                "keyHint": "tg_run…cret",
                "createdAt": "2026-08-20T00:00:00Z",
            }]}),
        )],
    )

    desired.endpoints[0].router_id = "composed"
    desired.router_revisions.append(protocol.RouterRevision(
        router_id="composed", revision=1, assignment_algorithm="hmac-sha256-v1",
        assignment_key_id="v1", assignment_key=b"k" * 32,
        routes=[protocol.ComposedRoute(route_id=old.router_id, name=old.router_id,
            kind="normal" if old.router_id == "production" else "fallback", enabled=True,
            all_endpoints=True, traffic_scope=old.traffic_scope,
            targets=[protocol.WeightedTarget(target_id=old.router_id + "-target",
                guardrail_id=artifact.guardrail_id, guardrail_version=artifact.guardrail_version,
                artifact_id=artifact.artifact_id, weight_bps=10000)])
            for old in reversed(desired.routers)]))

    first = ArtifactStore(public_path, tmp_path / "state")
    first_registry = Registry()
    first.attach_registry(first_registry)  # type: ignore[arg-type]
    first.apply(desired)
    assert first.generation == 7
    assert first.authenticate_endpoint("endpoint-1", credential)
    assert first.endpoint_adapter("endpoint-1") == "http"
    selected = first.resolve(RequestContext(
        protocol="http",
        endpoint_id="endpoint-1",
        fields=(("target.environment", "production"),),
    ))
    assert selected.router_id == "composed"
    assert selected.route_assignment["routeId"] == "production"

    restarted = ArtifactStore(public_path, tmp_path / "state")
    restarted_registry = Registry()
    restarted.attach_registry(restarted_registry)  # type: ignore[arg-type]
    assert restarted.generation == 7
    assert restarted.endpoint_adapter("endpoint-1") == "http"
    assert restarted.resolve(RequestContext(protocol="http", endpoint_id="endpoint-1")).route_assignment["routeId"] == "fallback"
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
        endpoints=[protocol.EndpointRuntime(
            endpoint_id="endpoint-1",
            adapter="http",
            verification=endpoint_verification_to_proto({
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

    assert store.authenticate_endpoint("endpoint-1", current)
    assert store.authenticate_endpoint("endpoint-1", second)
    assert not store.authenticate_endpoint("endpoint-1", revoked)
    assert not store.authenticate_endpoint("endpoint-1", "tg_unknown")


def test_protocol_rejects_malformed_endpoint_credentials() -> None:
    with pytest.raises(TypeError):
        protocol.EndpointCredential(id="bad", sha256=42)  # type: ignore[arg-type]


def test_runner_rejects_an_artifact_compiled_for_a_different_nemo_version(
    tmp_path: Path,
) -> None:
    private_key = Ed25519PrivateKey.generate()
    public_path = tmp_path / "public.pem"
    public_path.write_bytes(private_key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ))
    artifact = _artifact()
    artifact.artifact_id = "artifact-needing-recompile"
    artifact.nemo_version = "0.0.0"
    artifact.checksum = _checksum(artifact)
    artifact.signature = _signature(private_key, artifact.checksum)
    store = ArtifactStore(public_path, tmp_path / "state")
    store.attach_registry(Registry())  # type: ignore[arg-type]

    with pytest.raises(
        ValueError,
        match=r"targets NeMo Guardrails '0\.0\.0'.*Recompile",
    ):
        store.apply(protocol.DesiredState(generation=1, artifacts=[artifact]))

    assert store.generation == 0


def _artifact() -> protocol.Artifact:
    state = protocol.DesiredState()
    state.ParseFromString(base64.b64decode(
        (FIXTURE / "desired-state.pb.b64").read_text(encoding="utf-8").strip()
    ))
    artifact = protocol.Artifact()
    artifact.CopyFrom(state.artifacts[0])
    artifact.guardrail_id = "guardrail-1"
    artifact.plan.guardrail_id = "guardrail-1"
    artifact.guardrail_version = "20260904-010000.001Z"
    artifact.generation = 7
    # The signed content changed above. The test signs it with its own ephemeral
    # key after ArtifactStore recomputes the canonical fixture checksum.
    artifact.checksum = _checksum(artifact)
    artifact.signature = ""
    return artifact


def _checksum(artifact: protocol.Artifact) -> str:
    from runner.protocol_codec import artifact_content
    import json
    return hashlib.sha256(json.dumps(
        artifact_content(artifact),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode()).hexdigest()


def _signature(private_key: Ed25519PrivateKey, checksum: str) -> str:
    import base64
    return base64.b64encode(private_key.sign(checksum.encode())).decode()
