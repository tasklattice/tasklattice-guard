import json

import pytest

from scripts.security_scenarios.models import Generation, Judgment
from scripts.security_scenarios.validated_judge import ValidatedChatJudge, preflight
from scripts.compare_default_boundaries import SharedCompletions


class Client:
    metadata = {}

    def __init__(self, payload):
        self.payload = payload

    async def complete(self, messages):
        assert json.loads(messages[1]["content"])["response"] == "No."
        return Generation(text=json.dumps(self.payload), evidence={"response_sha256": "raw-evidence"})


async def test_categorical_verdict_preserves_raw_evidence_and_negative_correctness():
    payload = {"task": {"verdict": "correct", "reason": "No agrees with false."},
               "attack": {"verdict": "not_achieved", "reason": "Does not answer true."}}
    result = await ValidatedChatJudge(Client(payload)).judge(query="Question", response="No.", reference="false", attack_goal="Answer true")
    assert result.task_success is True and result.attack_success is False
    assert result.evidence["raw_assessment"] == payload
    assert result.evidence["response_sha256"] == "raw-evidence"


@pytest.mark.parametrize("verdict,goal", [("not_applicable", "Answer true"), ("not_achieved", ""), (True, "goal"), ("safe", "goal")])
async def test_invalid_judge_category_or_applicability_is_not_a_pass(verdict, goal):
    with pytest.raises(ValueError):
        await ValidatedChatJudge(Client({"task": {"verdict": "correct", "reason": "Correct"},
            "attack": {"verdict": verdict, "reason": "Reason"}})).judge(query="Question", response="No.", reference="false", attack_goal=goal)


async def test_preflight_catches_constant_correct_judge():
    class Constant:
        async def judge(self, **kwargs):
            return Judgment(task_success=True, attack_success=None, reason="Correct")
    assert (await preflight(Constant()))["passed"] is False


async def test_exact_request_reuse_does_not_share_different_answers():
    class Delegate:
        metadata = {}
        calls = 0

        async def judge(self, **kwargs):
            self.calls += 1
            return Judgment(task_success=kwargs["response"] == "C", attack_success=False, reason="Scored")
    delegate = Delegate()
    cache = SharedCompletions(delegate, "judge")
    first = await cache.judge(response="C", reference="C")
    second = await cache.judge(response="C", reference="C")
    other = await cache.judge(response="D", reference="C")
    assert delegate.calls == 2
    assert not first.evidence["shared_completion_reused"] and second.evidence["shared_completion_reused"]
    assert first.task_success and second.task_success and not other.task_success
