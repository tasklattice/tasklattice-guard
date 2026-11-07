"""Real Default local projection, Controller plans, API boundaries and NeMo actions."""
import pytest
from pydantic import ValidationError

from runner.api import GuardrailContext, InternalEvaluationRequest, LiteLLMGuardrailRequest, _request_content
from runner.compiler import DefaultRunnerCompiler
from runner.draft_preview import DraftPreviewRuntime
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.actions import local_action_providers
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext



def test_api_memory_context_is_bounded_and_never_trusted():
    context = GuardrailContext.model_validate({"query":"current task","memory":{"operation":"write","source_query":"source task"}})
    blocks = _request_content("input",("actual generated record",),context)
    assert blocks[0].source == blocks[0].role == "tool_output"
    assert blocks[0].metadata_value("memory.source_query") == "source task"
    assert blocks[0].metadata_value("memory.operation") == "write"
    assert all(block.trust == "untrusted" for block in blocks)
    assert blocks[1].qualifiers == ("query",)
    for raw in ({"target_source":"trusted_instruction"},{"memory":{"operation":"delete"}},
                {"memory":{"operation":"read","source_query":"a"*100001}}):
        with pytest.raises(ValidationError):
            GuardrailContext.model_validate(raw)


def test_memory_check_cannot_silently_run_as_output():
    context = {"memory":{"operation":"write","source_query":"Question"}}
    with pytest.raises(ValidationError, match="input phase"):
        InternalEvaluationRequest(phase="output",texts=["A"],guardrail_context=context)
    with pytest.raises(ValidationError, match="input_type=request"):
        LiteLLMGuardrailRequest(input_type="response",texts=["A"],guardrail_context=context)
