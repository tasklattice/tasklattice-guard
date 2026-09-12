"""Independent execution of signed Policy-owned phrases; never compiles a plan."""
from pathlib import Path

import pytest

from runner.output_streaming import OutputStreamSessionStore
from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext
from runner.toolkit.runtime.service import GuardrailRuntimeService
from tests.data_plane.test_artifact_execution import _runtime

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "artifacts" / "configured-phrases-v1"


@pytest.mark.asyncio
async def test_signed_phrase_policy_executes_both_directions_without_other_policies(tmp_path):
    store, registry, engine = _runtime(tmp_path, FIXTURE)
    runtime = GuardrailRuntimeService(engine, store)
    context = RequestContext(protocol="litellm", endpoint_id="fixture-endpoint")
    try:
        assert registry.readiness()["ready"]
        for phase in ("input", "output"):
            for source, expected, decision in [
                ("normal reply", "normal reply", "allow"),
                ("internal-name", "public-name", "transform"),
                ("内部代号", "公开名称", "transform"),
                ("confidential", None, "block"),
            ]:
                result = await runtime.evaluate(ProtectionRequest(phase=phase, texts=(source,), context=context))
                assert result.decision == decision, result
                assert result.usage.model_invocations == 0 and not result.usage.fail_closed
                if expected is not None:
                    assert (result.texts or (source,)) == (expected,)
                if decision != "allow":
                    assert any(f.policy_id == "configured-phrase-filter" and f.rule_id == "configured/phrases" for f in result.findings)
        streams = OutputStreamSessionStore(window_characters=4)
        request = ProtectionRequest(phase="output", texts=("",), call_id="split-phrase", context=context)
        assert runtime.output_delivery(request, allow_new_output=True) == "full_buffered"
        first = await streams.process(stream_key="split", sequence=0, text="internal-", final=False, mode="full_buffered", request=request, evaluate=runtime.evaluate)
        assert first.released_text == ""
        last = await streams.process(stream_key="split", sequence=1, text="name", final=True, mode="full_buffered", request=request, evaluate=runtime.evaluate)
        assert last.released_text == "public-name" and not last.terminate
    finally:
        await engine.shutdown()
