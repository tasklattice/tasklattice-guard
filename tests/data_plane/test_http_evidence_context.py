from runner.api import GuardrailContext, _request_content
from runner.toolkit.runtime.contracts import ProtectionDecision, ProtectionRequest, RequestContext
from runner.toolkit.runtime.service import GuardrailRuntimeService
from tests.data_plane.test_composed_routing import Resolver


async def test_context_is_visible_to_detector_but_never_released_as_transformed_text():
    calls = []

    class Engine:
        async def evaluate(self, request):
            calls.append(request)
            return ProtectionDecision(decision="transform", action="redact", texts=("[REDACTED]",))

    service = GuardrailRuntimeService(Engine(), Resolver())
    context = GuardrailContext(query="Warranty?", grounding_sources=["One year."])
    request = ProtectionRequest(phase="output", texts=("Private answer",),
        context=RequestContext(protocol="litellm", endpoint_id="endpoint"),
        content_blocks=_request_content("output", ("Private answer",), context))
    result = await service.evaluate(request)
    assert len(calls) == 1
    assert [block.role for block in calls[0].content_view.blocks] == ["model_output", "query", "grounding_source"]
    assert result.texts == ("[REDACTED]",)
