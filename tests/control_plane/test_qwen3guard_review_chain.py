"""Controller-built Policy plans through native gray review and public evidence."""
import pytest

from tests.control_plane.classifier_chain import build_controller_plan, scan


@pytest.fixture(scope="module", params=[("input", False), ("output", False), ("input", True), ("output", True)])
def native_plan(request):
    phase, pii_only = request.param
    return phase, pii_only, build_controller_plan(phase=phase, pii_only=pii_only)


@pytest.mark.parametrize("answer,outcome,verdict", [
    ("no", "cleared", "not_matched"), ("yes", "blocked", "matched"), ("unknown", "blocked", "unknown"),
])
async def test_native_review_controls_only_the_gray_check_and_preserves_scores(classifier_backend, native_plan, answer, outcome, verdict):
    phase, pii_only, plan = native_plan
    capability = "pii" if pii_only else "content_safety"
    response, calls, evidence = await scan(plan, {capability: .5}, backend=classifier_backend,
        phase=phase, pii_only=pii_only, review={capability: answer}, reviewer_profile="tali.qwen3guard.v1")
    assert response.status_code == 200, response.text
    expected = "redacted" if pii_only and answer == "yes" else outcome
    assert response.json()["result"]["outcome"] == expected
    assert calls.count("review:" + capability) == 1
    row = next(row for row in evidence[classifier_backend.evidence_key] if row["capability"] == capability)
    assert row["verdict"] == "unknown" and set(row["probabilities"].values()) == {.5}
    assert row["decisionSource"] == "review" and row["review"]["verdict"] == verdict
    assert row["review"]["profileRef"] == "tali.qwen3guard.v1"
    assert row["review"]["nativeVerdict"] == {"no":"safe", "yes":"unsafe", "unknown":"controversial"}[answer]
    assert row["review"]["nativeCategories"] == ([] if answer == "no" else ["PII" if pii_only else "Violent"])
    assert row["review"]["coverage"] == "native_safety_policy" and row["review"]["answers"] == {}
    assert evidence["execution"]["status"] == "complete"
    if pii_only and answer == "yes":
        assert "[PII_REDACTED]" in str(response.json())


@pytest.fixture(scope="module")
def input_plan():
    return build_controller_plan()


async def test_direct_jailbreak_review_uses_native_category(classifier_backend, input_plan):
    response, calls, evidence = await scan(input_plan, {"jailbreak": .5}, backend=classifier_backend,
        review={"jailbreak":"yes"}, reviewer_profile="tali.qwen3guard.v1")
    assert response.status_code == 200 and response.json()["result"]["outcome"] == "blocked"
    row = next(row for row in evidence[classifier_backend.evidence_key] if row["capability"] == "jailbreak")
    assert row["review"]["nativeCategories"] == ["Jailbreak"]
    assert calls.count("review:jailbreak") == 1


async def test_unassigned_topic_review_preserves_the_primary_result(classifier_backend, input_plan):
    response, calls, evidence = await scan(input_plan, {"topic_control": .5}, backend=classifier_backend,
        review={"topic_control":"no"}, reviewer_profile="tali.qwen3guard.v1")
    assert response.status_code == 200 and response.json()["result"]["outcome"] == "cleared"
    assert not any(call.startswith("review:") for call in calls)
    row = next(row for row in evidence[classifier_backend.evidence_key] if row["capability"] == "topic_control")
    assert row["verdict"] == "unknown" and "review" not in row
    assert evidence["execution"]["status"] == "complete"
