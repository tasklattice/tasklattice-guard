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
LEGACY_FIXTURE = Path(__file__).parent / "fixtures" / "unsupported-artifacts" / "pre-v16-local-secrets"


def legacy_state():
    state = protocol.DesiredState()
    state.ParseFromString(base64.b64decode((LEGACY_FIXTURE / "desired-state.pb.b64").read_text()))
    return state


@pytest.mark.parametrize("operation", ["verify", "admit", "apply"])
def test_real_old_signed_artifact_is_rejected_before_runtime_preparation(tmp_path, operation):
    from runner.protocol_codec import artifact_digest
    state = legacy_state()
    artifact = state.artifacts[0]
    assert artifact_digest(artifact) == artifact.checksum == "0e3ba069d8507b667523dae40c42a4dd272232cea98389e10fe813cc4fe6c2b2"
    key = serialization.load_pem_public_key((LEGACY_FIXTURE / "public-key.pem").read_bytes())
    key.verify(base64.b64decode(artifact.signature), artifact.checksum.encode())
    assert not artifact.action_bindings[0].parameters
    before = state.SerializeToString()
    store = ArtifactStore(LEGACY_FIXTURE / "public-key.pem", tmp_path)
    registry = Registry()
    store.attach_registry(registry)
    with pytest.raises(ValueError, match="artifact_recompile_required.*Recompile"):
        getattr(store, operation)(state if operation == "apply" else artifact)
    assert state.SerializeToString() == before
    assert registry.preparations == store.generation == 0
    assert not (tmp_path / "last-known-good.json").exists()


def test_old_generation_cannot_replace_current_last_known_good_or_restore_after_upgrade(tmp_path, caplog):
    import json
    current = protocol.DesiredState()
    current.ParseFromString(base64.b64decode((FIXTURE / "desired-state.pb.b64").read_text()))
    assert (FIXTURE / "public-key.pem").read_bytes() == (LEGACY_FIXTURE / "public-key.pem").read_bytes()
    store = ArtifactStore(FIXTURE / "public-key.pem", tmp_path)
    registry = Registry()
    store.attach_registry(registry)
    store.apply(current)
    saved = (tmp_path / "last-known-good.json").read_bytes()
    old = legacy_state()
    old.generation = current.generation + 1
    with pytest.raises(ValueError, match="artifact_recompile_required"):
        store.apply(old)
    assert store.generation == current.generation
    assert registry.preparations == 1
    assert (tmp_path / "last-known-good.json").read_bytes() == saved
    # A cold upgrade has no accepted current runtime to retain. Old cache stays
    # available for diagnosis, but cannot make the new Runner ready.
    (tmp_path / "last-known-good.json").write_text(json.dumps({
        "generation": old.generation,
        "desired_state_b64": base64.b64encode(old.SerializeToString()).decode(),
    }))
    rejected_cache = (tmp_path / "last-known-good.json").read_bytes()
    restarted = ArtifactStore(LEGACY_FIXTURE / "public-key.pem", tmp_path)
    cold_registry = Registry()
    restarted.attach_registry(cold_registry)
    assert restarted.generation == cold_registry.preparations == 0
    assert "artifact_recompile_required" in caplog.text
    assert (tmp_path / "last-known-good.json").read_bytes() == rejected_cache


@pytest.mark.parametrize("target,views", [("step", []), ("action", []), ("action", ["original", "previous_output"]), ("action", ["implicit"])])
def test_current_version_labels_do_not_hide_invalid_views(tmp_path, target, views):
    from runner.protocol_codec import artifact_digest
    key = Ed25519PrivateKey.generate()
    public = tmp_path / "public.pem"
    public.write_bytes(key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
    artifact = _artifact()
    item = artifact.plan.steps[0] if target == "step" else artifact.action_bindings[0]
    others = [entry for entry in item.parameters if entry.key != "evaluation_view"]
    del item.parameters[:]
    item.parameters.extend(others)
    for view in views:
        item.parameters.add(key="evaluation_view", value=view)
    artifact.checksum = artifact_digest(artifact)
    artifact.signature = _signature(key, artifact.checksum)
    store = ArtifactStore(public, tmp_path / "state")
    with pytest.raises(ValueError, match="artifact_recompile_required.*evaluation_view"):
        store.verify(artifact)


class Registry:
    def publish_release(self, release_id, candidates, publish):
        self.release_id = release_id
        publish()

    def __init__(self) -> None:
        self.preparations = 0

    def prepare_release(self, candidates, active, **_kwargs):
        self.preparations += 1
        return candidates

    def discard_prepared(self, prepared):
        pass


def test_scan_default_is_backward_compatible_atomic_and_restored(tmp_path):
    store = ArtifactStore(FIXTURE / "public-key.pem", tmp_path / "state")
    store.attach_registry(Registry())
    desired = protocol.DesiredState(generation=1, endpoints=[protocol.EndpointRuntime(endpoint_id="scan", adapter="f5-scan")])
    store.apply(desired)
    assert store.endpoint_scan_flag_only_default("scan") is True
    desired.generation = 2
    desired.endpoints[0].scan_flag_only_default = False
    store.apply(desired)
    assert store.endpoint_scan_flag_only_default("scan") is False
    restarted = ArtifactStore(FIXTURE / "public-key.pem", tmp_path / "state")
    restarted.attach_registry(Registry())
    assert restarted.endpoint_scan_flag_only_default("scan") is False
    desired.generation = 3
    desired.endpoints[0].scan_flag_only_default = True
    # Duplicate Router IDs reject the snapshot without changing the active default.
    desired.router_revisions.extend([protocol.RouterRevision(router_id="bad"), protocol.RouterRevision(router_id="bad")])
    with pytest.raises(ValueError):
        store.apply(desired)
    assert store.endpoint_scan_flag_only_default("scan") is False
    del desired.router_revisions[:]
    store.apply(desired)
    assert store.endpoint_scan_flag_only_default("scan") is True


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
    routes = [
        ("production", "normal", {
            "combinator": "and",
            "conditions": [{"field": "target.environment", "operator": "equals", "value": "production"}],
        }),
        ("fallback", "fallback", {"combinator": "and", "conditions": []}),
    ]
    desired = protocol.DesiredState(
        generation=7,
        artifacts=[artifact],
        endpoints=[protocol.EndpointRuntime(
            endpoint_id="endpoint-1",
            adapter="litellm-generic-guardrail",
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
        routes=[protocol.ComposedRoute(route_id=route_id, name=route_id,
            kind=kind, enabled=True,
            all_endpoints=True, traffic_scope=traffic_scope_to_proto(scope),
            targets=[protocol.WeightedTarget(target_id=route_id + "-target",
                guardrail_id=artifact.guardrail_id, guardrail_version=artifact.guardrail_version,
                artifact_id=artifact.artifact_id, weight_bps=10000)])
            for route_id, kind, scope in routes]))

    first = ArtifactStore(public_path, tmp_path / "state")
    first_registry = Registry()
    first.attach_registry(first_registry)  # type: ignore[arg-type]
    first.apply(desired)
    assert first.generation == 7
    assert first.authenticate_endpoint("endpoint-1", credential)
    assert first.endpoint_adapter("endpoint-1") == "litellm-generic-guardrail"
    selected = first.resolve(RequestContext(
        protocol="litellm",
        endpoint_id="endpoint-1",
        fields=(("target.environment", "production"),),
    ))
    assert selected.router_id == "composed"
    assert selected.route_assignment["routeId"] == "production"

    restarted = ArtifactStore(public_path, tmp_path / "state")
    restarted_registry = Registry()
    restarted.attach_registry(restarted_registry)  # type: ignore[arg-type]
    assert restarted.generation == 7
    assert restarted.endpoint_adapter("endpoint-1") == "litellm-generic-guardrail"
    assert restarted.resolve(RequestContext(protocol="litellm", endpoint_id="endpoint-1")).route_assignment["routeId"] == "fallback"
    assert restarted_registry.preparations == 1


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
            adapter="litellm-generic-guardrail",
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
    from runner.protocol_codec import artifact_digest
    return artifact_digest(artifact)


def _signature(private_key: Ed25519PrivateKey, checksum: str) -> str:
    import base64
    return base64.b64encode(private_key.sign(checksum.encode())).decode()


@pytest.mark.parametrize("severity", [False, True])
def test_content_digest_excludes_delivery_envelope_and_survives_restart(tmp_path, severity):
    """The same signed content verifies under any local generation or Artifact ID."""

    private_key = Ed25519PrivateKey.generate()
    public_path = tmp_path / "public.pem"
    public_path.write_bytes(private_key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo,
    ))
    artifact = _artifact()
    binding = artifact.plan.policy_bindings.add(policy_id="policy-1", policy_version="1", enabled_rule_ids=["rule-1"])
    if severity:
        binding.rule_severities.add(key="rule-1", value="high")
    artifact.plan.reasoning_policies.add(id="reasoning-1", policy_id="policy-1", policy_version="1", confidence_threshold=1.0)
    artifact.checksum = _checksum(artifact)
    artifact.signature = _signature(private_key, artifact.checksum)
    promoted = protocol.Artifact()
    promoted.CopyFrom(artifact)
    promoted.generation = 912
    promoted.artifact_id = "promoted-local-artifact"
    assert _checksum(promoted) == artifact.checksum
    desired = protocol.DesiredState(generation=7, artifacts=[promoted])
    store = ArtifactStore(public_path, tmp_path / "state")
    store.attach_registry(Registry())
    original_wire = desired.SerializeToString()
    store.apply(desired)
    assert store.generation == 7
    assert desired.SerializeToString() == original_wire

    restored = ArtifactStore(public_path, tmp_path / "state")
    restored.attach_registry(Registry())
    assert restored.generation == 7
    assert restored.plan(artifact.guardrail_id, artifact.guardrail_version).policy_bindings[0].rule_severities == (
        (("rule-1", "high"),) if severity else ()
    )


@pytest.mark.parametrize("tamper", ["content", "severity", "signature"])
def test_signed_artifact_rejects_tampering(tmp_path, tamper):
    from cryptography.exceptions import InvalidSignature

    key = Ed25519PrivateKey.generate()
    public_path = tmp_path / "public.pem"
    public_path.write_bytes(key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo,
    ))
    artifact = _artifact()
    artifact.plan.policy_bindings.add(policy_id="policy-1", policy_version="1", enabled_rule_ids=["rule-1"])
    artifact.checksum = _checksum(artifact)
    artifact.signature = _signature(key, artifact.checksum)
    store = ArtifactStore(public_path, tmp_path / "state")
    store.attach_registry(Registry())
    store.apply(protocol.DesiredState(generation=7, artifacts=[artifact]))
    if tamper == "content":
        artifact.config_yaml += "\n# changed after signing\n"
    elif tamper == "severity":
        artifact.plan.policy_bindings[0].rule_severities.add(key="rule-1", value="low")
    else:
        artifact.signature = _signature(Ed25519PrivateKey.generate(), artifact.checksum)
    with pytest.raises((ValueError, InvalidSignature)):
        store.apply(protocol.DesiredState(generation=8, artifacts=[artifact]))
    assert store.generation == 7


@pytest.mark.parametrize("fixture", ["local-secrets-v1", "custom-symbol-ownership-v1"])
def test_admission_check_builds_the_runtime_without_serving_it(tmp_path, fixture):
    from runner.toolkit.nemo.action_registry import action_providers
    from runner.toolkit.nemo.actions import local_action_providers
    from runner.toolkit.nemo.registry import NeMoRuntimeRegistry

    path = Path(__file__).parent / "fixtures" / "artifacts" / fixture
    artifact = protocol.DesiredState.FromString(base64.b64decode((path / "desired-state.pb.b64").read_bytes())).artifacts[0]
    store = ArtifactStore(path / "public-key.pem", tmp_path / "state")
    registry = NeMoRuntimeRegistry(store, action_providers(*local_action_providers()))
    store.attach_registry(registry)

    store.admit(artifact)

    assert store.generation == 0
    assert registry.stats()["entries"] == 0
    assert not (tmp_path / "state" / "last-known-good.json").exists()


@pytest.mark.parametrize("change", ["content", "signature", "runtime"])
def test_admission_check_rejects_what_a_real_load_would_reject(tmp_path, change):
    from cryptography.exceptions import InvalidSignature
    from runner.toolkit.nemo.action_registry import action_providers
    from runner.toolkit.nemo.registry import NeMoRuntimeRegistry

    key = Ed25519PrivateKey.generate()
    public_path = tmp_path / "public.pem"
    public_path.write_bytes(key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo,
    ))
    artifact = protocol.DesiredState.FromString(base64.b64decode((FIXTURE / "desired-state.pb.b64").read_bytes())).artifacts[0]
    artifact.signature = _signature(key, artifact.checksum)
    if change == "content":
        artifact.config_yaml += "\n# changed after signing\n"
    elif change == "signature":
        artifact.signature = _signature(Ed25519PrivateKey.generate(), artifact.checksum)
    store = ArtifactStore(public_path, tmp_path / "state")
    # "runtime": a Runner without the Actions this Artifact pins cannot serve it.
    store.attach_registry(NeMoRuntimeRegistry(store, action_providers()))
    expected = {"content": ValueError, "signature": InvalidSignature, "runtime": Exception}[change]
    with pytest.raises(expected) as failure:
        store.admit(artifact)
    if change == "runtime":
        assert "Action providers are unavailable" in str(failure.value)


def test_protection_modes_are_atomic_persisted_and_independent_of_artifacts(tmp_path):
    store = ArtifactStore(FIXTURE / "public-key.pem", tmp_path / "state")
    # No registry or Artifact is necessary to apply the emergency setting.
    store.apply_protection_modes(protocol.GuardrailProtectionState(generation=7, modes={"g": "bypass"}))
    assert store.protection_mode("g") == "bypass" and store.generation == 0
    for generation, mode in [(6, "enforce"), (7, "monitor"), (8, "invalid")]:
        with pytest.raises(ValueError):
            store.apply_protection_modes(protocol.GuardrailProtectionState(generation=generation, modes={"g": mode}))
        assert store.protection_mode("g") == "bypass" and store.protection_generation == 7
    restarted = ArtifactStore(FIXTURE / "public-key.pem", tmp_path / "state")
    assert restarted.protection_mode("g") == "bypass" and restarted.protection_generation == 7
    restarted.apply_protection_modes(protocol.GuardrailProtectionState(generation=8))
    assert restarted.protection_mode("g") == "enforce"
