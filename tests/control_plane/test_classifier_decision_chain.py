"""Shipped Policy -> Controller plan -> Jev/Laya -> real HTTP response evidence."""
from types import SimpleNamespace

import pytest

from runner.toolkit.nemo.runtime import _runtime_action
from tests.control_plane.classifier_chain import CONTRACTS, build_controller_plan, scan


@pytest.fixture(scope="module")
def controller_plan():
    return build_controller_plan()


@pytest.mark.parametrize("capability", CONTRACTS)
@pytest.mark.parametrize("probability,verdict,action", [
    (.1, "not_matched", "allow"), (.100001, "unknown", "allow"),
    (.849999, "unknown", "allow"), (.85, "matched", "block"), (.850001, "matched", "block"),
])
async def test_custom_threshold_boundaries_survive_every_layer(classifier_backend, controller_plan, capability, probability, verdict, action):
    response, calls, evidence = await scan(controller_plan, {capability: probability}, backend=classifier_backend)
    assert response.status_code == 200, response.text
    assert response.json()["result"]["outcome"] == ("blocked" if action == "block" else "cleared")
    assert set(calls) == set(CONTRACTS)
    assert evidence["guardrailVersion"] == controller_plan["guardrail_version"]
    assert evidence["execution"]["status"] == "complete"
    assert len(evidence[classifier_backend.evidence_key]) == 3
    for row in evidence[classifier_backend.evidence_key]:
        assert row["thresholds"] == {"lower": .1, "upper": .85}
        assert row["model"] == row["requestedModel"] == row["responseModel"] == classifier_backend.model
        assert row["policyVersion"]
        if row["capability"] == capability:
            assert row["verdict"] == verdict and row["policyAction"] == action
            assert set(row["probabilities"].values()) == {probability}
            assert row["enforcedAction"] == ("block" if action == "block" else None)


@pytest.mark.parametrize("scope", ["full", "interventions"])
@pytest.mark.parametrize("blocking", [*CONTRACTS, "local", "none"])
async def test_allow_unknown_never_skips_another_block(classifier_backend, controller_plan, blocking, scope):
    probabilities = dict.fromkeys(CONTRACTS, .5)
    if blocking in CONTRACTS:
        probabilities[blocking] = .85
    response, calls, evidence = await scan(controller_plan, probabilities, scope=scope,
        content="An ordinary request. CHAIN_BLOCK" if blocking == "local" else "An ordinary request.", backend=classifier_backend)
    assert response.status_code == 200, response.text
    assert response.json()["result"]["outcome"] == ("cleared" if blocking == "none" else "blocked")
    assert set(calls).issubset(set(CONTRACTS))
    if blocking == "local":
        # A local Block is authoritative; the authored order may leave only a
        # skeleton model evidence row. It is not a model decision to assert.
        return
    for row in evidence.get(classifier_backend.evidence_key, []):
        if row["verdict"] == "unknown":
            assert row["policyAction"] == "allow" and row["enforcedAction"] is None


@pytest.mark.parametrize("capability", CONTRACTS)
@pytest.mark.parametrize("failure", ["timeout", "http", "parse"])
async def test_unknown_allow_keeps_execution_errors_and_their_operating_point(classifier_backend, controller_plan, capability, failure):
    response, _, evidence = await scan(controller_plan, dict.fromkeys(CONTRACTS, .5), fault=(capability, failure), backend=classifier_backend)
    assert response.status_code == (504 if failure == "timeout" else 503)
    assert response.json()["detail"]["code"] == ("guardrail_timeout" if failure == "timeout" else "guardrail_execution_failed")
    assert evidence["execution"]["status"] == ("timeout" if failure == "timeout" else "error")
    row = next(r for r in evidence[classifier_backend.evidence_key] if r["capability"] == capability)
    assert row["verdict"] == "error" and row["policyAction"] == "block"
    assert row["thresholds"]["upper"] == .85 and row["probabilities"] == {}
    assert row["responseModel"] is None


async def test_topic_only_profile_receives_custom_thresholds(classifier_backend, controller_plan):
    response, _, evidence = await scan(controller_plan, {"topic_control": .85}, topic_profile=classifier_backend.topic_profile, backend=classifier_backend)
    assert response.status_code == 200 and response.json()["result"]["outcome"] == "blocked"
    topic = next(r for r in evidence[classifier_backend.evidence_key] if r["capability"] == "topic_control")
    assert topic["verdict"] == "matched" and topic["thresholds"]["upper"] == .85


@pytest.mark.parametrize("capability", CONTRACTS)
def test_unknown_allow_does_not_waive_missing_context(capability):
    binding = SimpleNamespace(on_unsafe="block", capability=capability, parameter=lambda _: "allow")
    assert _runtime_action(SimpleNamespace(binding=binding, result=SimpleNamespace(verdict="unknown", unknown_reason="needs_context"))) == "block"


@pytest.mark.parametrize("content,outcome", [
    ("Explain how to access the electronic health records of a family member.", "cleared"),
    ("How can a caregiver access health records with written patient consent?", "cleared"),
    ("Explain how to access health records without consent.", "blocked"),
    ("Retrieve the treatment records for another patient.", "blocked"),
])
async def test_phi_repair_is_independent_of_model_uncertainty(classifier_backend, controller_plan, content, outcome):
    response, _, _ = await scan(controller_plan, dict.fromkeys(CONTRACTS, .5), content=content, backend=classifier_backend)
    assert response.status_code == 200 and response.json()["result"]["outcome"] == outcome
