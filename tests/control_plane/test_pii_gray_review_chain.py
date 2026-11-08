"""Pinned PII policy -> independent review binding -> actual F5 redaction."""
from copy import deepcopy
import pytest

from tests.control_plane.classifier_chain import build_controller_plan, scan


@pytest.fixture(scope="module", params=["input", "output"])
def pii_plan(request):
    return request.param, build_controller_plan(review=True, phase=request.param, pii_only=True)


@pytest.mark.parametrize("score,answer,outcome,calls", [
    (.01, "yes", "cleared", 1), (.9, "no", "redacted", 1),
    (.5, "yes", "redacted", 2), (.5, "no", "cleared", 2),
])
async def test_reviewed_pii_uses_trusted_redaction_and_preserves_both_decisions(
        classifier_backend, pii_plan, score, answer, outcome, calls):
    phase, plan = pii_plan
    response, observed, evidence = await scan(plan, {"pii": score}, phase=phase,
        backend=classifier_backend, pii_only=True, review={"pii": answer}, reviewer_profile="generic-chat",
        content="My name is Alice Morgan.")
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    assert result["outcome"] == outcome
    assert len(observed) == calls
    if outcome == "redacted":
        assert response.json()["redactedInput"] == "[PII_REDACTED]"
    row = evidence[classifier_backend.evidence_key][0]
    if calls == 2:
        assert row["verdict"] == "unknown" and row["decisionSource"] == "review"
        assert row["finalPolicyAction"] == ("transform" if answer == "yes" else "allow")
        assert row["review"]["model"] == "review-model-v1"
        assert row["review"]["verdict"] == ("matched" if answer == "yes" else "not_matched")
    else:
        assert "review" not in row


@pytest.mark.parametrize("failure", ["unknown", "malformed", "timeout", "http", "missing-binding"])
async def test_pii_review_failure_never_releases_unredacted_content(classifier_backend, pii_plan, failure):
    phase, plan = pii_plan
    response, calls, evidence = await scan(plan, {"pii": .5}, phase=phase,
        backend=classifier_backend, pii_only=True, review={"pii": "unknown"},
        review_fault=("pii", failure) if failure in {"malformed", "timeout", "http"} else None,
        reviewer_binding=failure != "missing-binding", require_evidence=failure != "missing-binding")
    assert response.status_code >= 400, response.text
    if failure == "missing-binding":
        assert not calls
    else:
        assert evidence["execution"]["status"] in {"error", "timeout"}
        row = evidence[classifier_backend.evidence_key][0]
        assert row["verdict"] == "unknown"
        assert row["review"]["verdict"] == ("unknown" if failure == "unknown" else "error")


@pytest.mark.parametrize("on_unknown,outcome", [("allow", "cleared"), ("block", "blocked")])
async def test_disabling_pii_review_preserves_the_pinned_unknown_action(classifier_backend, pii_plan, on_unknown, outcome):
    phase, original = pii_plan
    plan = deepcopy(original)
    for step in plan["steps"]:
        step["parameters"] = [[k, "false" if k == "review_unknown" else on_unknown if k == "on_unknown" else v]
                              for k, v in step["parameters"]]
    response, calls, _ = await scan(plan, {"pii": .5}, phase=phase, pii_only=True,
        backend=classifier_backend, review={"pii": "yes"})
    assert response.status_code == 200 and response.json()["result"]["outcome"] == outcome
    assert calls == ["pii"]


async def test_pii_primary_error_does_not_call_review(classifier_backend, pii_plan):
    phase, plan = pii_plan
    response, calls, _ = await scan(plan, {}, phase=phase, pii_only=True,
        backend=classifier_backend, review={"pii": "no"}, fault=("pii", "http"))
    assert response.status_code >= 400 and calls == ["pii"]
