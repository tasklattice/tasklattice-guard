"""Independent execution of signed Policy-owned phrases; never compiles a plan."""
from pathlib import Path

import pytest

from tests.stream_client import service_stream
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
                    assert any(f.policy_id == "configured-phrase-filter" and f.rule_id.startswith("configured/phrases/") and f.risk_severity == "low" for f in result.findings)
        request = ProtectionRequest(phase="output", texts=("",), call_id="split-phrase", context=context)
        result, text, decisions, contract = await service_stream(runtime, request, ["internal-", "name"])
        assert contract.effective_mode == "full_buffered"
        assert text == "public-name" and result.status == "completed" and result.transformed
    finally:
        await engine.shutdown()
