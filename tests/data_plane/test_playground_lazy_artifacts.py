"""Historical versions are isolated, bounded, verified and replica-independent."""
from __future__ import annotations

import asyncio
import base64
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import FastAPI

from runner import generated as protocol
from runner.api import RunnerAPI
from runner.artifact_store import ArtifactStore
from runner.metrics import RunnerMetrics
from runner.preparation import prepare
from runner.protocol_codec import artifact_digest
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.actions import local_action_providers
from runner.toolkit.nemo.registry import NeMoRuntimeRegistry
from runner.toolkit.nemo.runtime import NeMoRuntime
from runner.toolkit.runtime.service import GuardrailRuntimeService
from tests.data_plane.test_artifact_execution import FIXTURE, Telemetry, _desired_state


def signed_artifact(**changes):
    artifact = protocol.Artifact()
    artifact.CopyFrom(_desired_state().artifacts[0])
    for key, value in changes.items():
        setattr(artifact, key, value)
        if key == "guardrail_version":
            artifact.plan.guardrail_version = value
    artifact.checksum = artifact_digest(artifact)
    # The fixture generator deliberately uses this public, test-only key.
    key = Ed25519PrivateKey.from_private_bytes(bytes(range(1, 33)))
    artifact.signature = base64.b64encode(key.sign(artifact.checksum.encode())).decode()
    return artifact


@asynccontextmanager
async def replica(path, *, capacity=32):
    store = ArtifactStore(FIXTURE / "public-key.pem", path)
    registry = NeMoRuntimeRegistry(store, action_providers(*local_action_providers()), max_playground_entries=capacity)
    store.attach_registry(registry)
    await prepare(store.apply, protocol.DesiredState(generation=1))
    app = FastAPI()
    app.include_router(RunnerAPI(GuardrailRuntimeService(NeMoRuntime(registry), store), store,
        RunnerMetrics(4), Telemetry(), "lazy-runner", "controller-token").router)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
            yield client, store, registry
    finally:
        await registry.shutdown()


async def evaluate(client, artifact, *, phase="input", credential="controller-token", encoded=None, version=None):
    return await client.post(f"/internal/v1/guardrails/{artifact.guardrail_id}/evaluate",
        headers={"authorization": f"Bearer {credential}"}, json={
            "phase": phase, "texts": ["Hello world"], "call_id": "playground:lazy-test",
            "guardrail_version": version or artifact.guardrail_version,
            "artifact_b64": encoded if encoded is not None else base64.b64encode(artifact.SerializeToString()).decode(),
        })


async def test_history_loads_on_either_replica_without_changing_durable_state(tmp_path):
    artifact = signed_artifact()
    async with replica(tmp_path / "a") as (a, store_a, registry_a), replica(tmp_path / "b") as (b, store_b, registry_b):
        before = (tmp_path / "a" / "last-known-good.json").read_bytes()
        assert store_a.observability_counts() == (0, 0, 0)
        assert (await evaluate(a, artifact, credential="wrong")).status_code == 401
        assert not registry_a._current.prepared.candidates
        response = await evaluate(a, artifact)
        assert response.status_code == 200, response.text
        assert response.json()["guardrail_version"] == artifact.guardrail_version
        response = await evaluate(b, artifact, phase="output")
        assert response.status_code == 200, response.text
        for store, registry in [(store_a, registry_a), (store_b, registry_b)]:
            assert store.observability_counts() == (0, 0, 0)
            assert registry.readiness()["ready"]
            assert not registry._current.prepared.candidates
            assert sum(entry.playground for entry in registry._releases.values()) == 1
        assert (tmp_path / "a" / "last-known-good.json").read_bytes() == before
    # A fresh process restores only serving state, never temporary history.
    async with replica(tmp_path / "a") as (_, store, registry):
        assert store.observability_counts() == (0, 0, 0)
        assert not any(entry.playground for entry in registry._releases.values())


@pytest.mark.parametrize("invalid", ["signature", "nemo", "contract", "identity", "encoding"])
async def test_rejects_untrusted_or_incompatible_history_without_poisoning_serving(tmp_path, invalid):
    artifact = signed_artifact(**({"nemo_version": "0.24.0"} if invalid == "nemo" else
                                 {"compiler_version": "unsupported-compiler"} if invalid == "contract" else {}))
    if invalid == "signature":
        artifact.signature = base64.b64encode(bytes(64)).decode()
    async with replica(tmp_path) as (client, store, registry):
        response = await evaluate(client, artifact, encoded="not base64!" if invalid == "encoding" else None,
                                  version="20260101-000000.000Z" if invalid == "identity" else None)
        assert response.status_code == 409, response.text
        assert registry.readiness()["ready"]
        assert not any(entry.playground for entry in registry._releases.values())
        assert store.observability_counts() == (0, 0, 0)


async def test_routed_version_reuses_serving_release_and_model_changes_invalidate_history(tmp_path):
    artifact = signed_artifact()
    async with replica(tmp_path) as (client, store, registry):
        await prepare(store.apply, _desired_state())
        assert (await evaluate(client, artifact)).status_code == 200
        assert not any(entry.playground for entry in registry._releases.values())
        await prepare(store.apply, protocol.DesiredState(generation=store.generation + 1))
        assert (await evaluate(client, artifact)).status_code == 200
        first = next(key for key, entry in registry._releases.items() if entry.playground)
        state = protocol.DesiredState(generation=store.generation + 1)
        state.model_configuration.revision_id = "new-model-revision"
        await prepare(store.apply, state)
        assert (await evaluate(client, artifact)).status_code == 200
        assert len([key for key, entry in registry._releases.items() if entry.playground and key != first]) == 1
        assert store.model_revision_id == "new-model-revision"


async def test_cache_coalesces_loads_and_reclaims_only_after_leases_and_requests_drain(tmp_path, monkeypatch):
    artifact = signed_artifact()
    other = signed_artifact(guardrail_version="20260101-000000.000Z")
    async with replica(tmp_path, capacity=1) as (client, store, registry):
        builds = []
        original = registry._build_with_logging
        def build(*args):
            builds.append(1)
            return original(*args)
        monkeypatch.setattr(registry, "_build_with_logging", build)
        results = await asyncio.gather(*(evaluate(client, artifact) for _ in range(4)))
        assert all(result.status_code == 200 for result in results)
        assert len(builds) == 1
        assert (await evaluate(client, other)).status_code == 503
        entry = next(entry for entry in registry._releases.values() if entry.playground)
        item = next(iter(entry.prepared.items.values()))
        close = AsyncMock(wraps=item.rails.shutdown)
        monkeypatch.setattr(item.rails, "shutdown", close)
        await registry.collect_retired()
        close.assert_not_awaited()
        entry.expires_at = 0
        entry.used_until.clear()
        await prepare(store.prepare_playground_artifact, artifact, artifact.guardrail_id, artifact.guardrail_version)
        await registry.collect_retired()
        close.assert_not_awaited()
        assert (await evaluate(client, artifact)).status_code == 200
        assert len(builds) == 1
        entry.expires_at = 0
        entry.used_until.clear()
        item.active_requests = 1
        await registry.collect_retired()
        close.assert_not_awaited()
        item.active_requests = 0
        await registry.collect_retired()
        close.assert_awaited_once()
        assert not any(entry.playground for entry in registry._releases.values())
        assert (await evaluate(client, other)).status_code == 200
        assert store.observability_counts() == (0, 0, 0)
