from dataclasses import asdict

import pytest

from runner.toolkit.nemo.evaluators.contracts import ModelCallUsage
from runner.toolkit.nemo.runtime import _model_call_usage_from_payload, _provider_work_ms
from runner.toolkit.runtime.contracts import ProtectionDecision, RuntimeUsage
from runner.toolkit.runtime.outcome import finalize_decision
from tests.classifier_cases import jailbreak_request


@pytest.mark.parametrize("sent", [False, True, None])
def test_colang_model_call_payload_preserves_dispatch_and_queue_evidence(sent):
    call = ModelCallUsage(
        provider="fixture", model="judge", operation="classify", result="timeout",
        duration_ms=120, queue_duration_ms=100, request_sent=sent, call_id="queue-call",
    )
    payload = asdict(call)
    if sent is None:
        # Previously published Actions can return evidence without admission fields.
        payload.pop("request_sent")
    decoded = _model_call_usage_from_payload(jailbreak_request().binding, payload)
    assert decoded == call
    decision = finalize_decision(ProtectionDecision(
        decision="block", action="block",
        usage=RuntimeUsage(model_calls=(decoded,), model_invocations=1),
    ))
    assert decision.usage.model_invocations == (0 if sent is False else 1)
    assert decision.model_status == ("not_called" if sent is False else "error")
    assert _provider_work_ms((), (decoded,)) == (0 if sent is False else 20)


def test_colang_model_call_payload_rejects_ambiguous_dispatch_flag():
    payload = asdict(ModelCallUsage(
        provider="fixture", model="judge", operation="classify", result="timeout", duration_ms=120,
    ))
    payload["request_sent"] = "false"
    with pytest.raises(RuntimeError, match="invalid model-call dispatch evidence"):
        _model_call_usage_from_payload(jailbreak_request().binding, payload)
