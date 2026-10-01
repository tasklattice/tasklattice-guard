"""Grounding context prerequisites at the runtime Action boundary; no authoring."""
import json
import time

import httpx
import pytest

from runner.toolkit.nemo.actions.contracts import ActionRequest
from runner.toolkit.nemo.actions.grounding import GroundingActionProvider
from runner.toolkit.runtime.contracts import GuardContentBlock, GuardrailPlanSnapshot, NeMoActionBinding


def request_with_context(query, source):
    blocks = [GuardContentBlock(id="answer", text="The account balance is 100.",
        role="model_output", trust="untrusted", source="response")]
    for qualifier, text in (("query", query), ("grounding_source", source)):
        if text is not None:
            blocks.append(GuardContentBlock(id=qualifier, text=text, role="user_input",
                trust="untrusted", source="request", qualifiers=(qualifier,)))
    plan = GuardrailPlanSnapshot(guardrail_id="grounding", guardrail_version="1",
        compiler_version="fixture", safety_level="balanced", output_delivery="full_buffered", steps=())
    return ActionRequest(content=blocks[0].text, rail_type="output", guardrail_id="grounding",
        guardrail_version="1", policy_id=None, policy_version=None, trusted_context=(),
        content_blocks=tuple(blocks), active_block_id="answer", deadline=time.monotonic() + 5,
        parameters=(), capability="contextual_grounding", proposed_action="block", plan=plan,
        binding=NeMoActionBinding(id="grounding", capability="contextual_grounding",
            contract_ref="tali.guard.contextual-grounding.v1", phases=("output",), on_unsafe="block"))


def grounding_provider(calls):
    def respond(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({
            "grounding_score": 1.0, "relevance_score": 1.0, "claims": [], "reason": "Grounded"})}}]})
    return GroundingActionProvider(base_url="https://grounding.test/v1", model="test-grounding",
        api_key="test-only", transport=httpx.MockTransport(respond))


@pytest.mark.parametrize("missing", [None, "", " \t\n", "\u3000"])
@pytest.mark.parametrize("field", ["query", "grounding_source"])
async def test_absent_or_blank_grounding_context_does_not_call_or_pass(field, missing):
    calls = []
    request = request_with_context(missing if field == "query" else "What is the balance?",
        missing if field == "grounding_source" else "The account balance is 100.")
    result = await grounding_provider(calls).execute(request)
    assert result.verdict == "unknown"
    assert "requires" in result.reason
    assert result.findings[0].recommended_action == "block"
    assert result.usage.model_invocations == 0
    assert calls == []


async def test_nonempty_grounding_context_still_calls_the_judge():
    calls = []
    result = await grounding_provider(calls).execute(request_with_context(
        "What is the balance?", "The account balance is 100."))
    assert result.verdict == "not_matched"
    assert result.usage.model_invocations == 1
    assert len(calls) == 1
    content = json.loads(calls[0]["messages"][1]["content"])
    assert content["queries"][0]["text"] == "What is the balance?"
    assert content["grounding_sources"][0]["text"] == "The account balance is 100."
