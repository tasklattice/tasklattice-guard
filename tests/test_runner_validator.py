from __future__ import annotations

import pytest

from runner.compiler import DefaultRunnerCompiler
from runner import generated as protocol
from runner.protocol_codec import plan_to_proto, validation_test_to_proto
from runner.validator import DefaultRunnerValidator


@pytest.mark.asyncio
async def test_default_runner_validates_cases_through_the_real_nemo_runtime() -> None:
    plan = {
        "guardrail_id": "guardrail-1",
        "guardrail_version": "20260904-010000.001Z",
        "compiler_version": "tasklattice-controller-plan-v3",
        "safety_level": "balanced",
        "output_delivery": "full_buffered",
        "steps": [{
            "id": "secrets:exact",
            "capability": "secrets",
            "contract_ref": "tali.guard.secrets.exact.v1",
            "phases": ["input", "output"],
            "on_unsafe": "block",
            "trigger": {"type": "always", "verdicts": []},
            "parameters": [],
        }],
        "modules": [{
            "id": "data_protection:input",
            "module": "data_protection",
            "phase": "input",
            "step_ids": ["secrets:exact"],
            "depends_on": [],
            "input_view": "original",
            "required_for_release": True,
            "timeout_ms": 750,
            "failure_mode": "fail_closed",
        }, {
            "id": "data_protection:output",
            "module": "data_protection",
            "phase": "output",
            "step_ids": ["secrets:exact"],
            "depends_on": [],
            "input_view": "original",
            "required_for_release": True,
            "timeout_ms": 750,
            "failure_mode": "fail_closed",
        }],
        "reasoning_policies": [],
        "policy_versions": [],
        "policy_bindings": [],
    }
    cases = [{
        "id": "safe",
        "name": "Safe prompt",
        "policyId": "builtin-secrets",
        "phase": "input",
        "content": "Summarize the quarterly report.",
        "expectedDecision": "allow",
        "required": True,
        "coveredRuleIds": [],
    }, {
        "id": "blocked",
        "name": "Credential prompt",
        "policyId": "builtin-secrets",
        "phase": "input",
        "content": "api_key=abcdefghijklmnop",
        "expectedDecision": "block",
        "required": True,
        "coveredRuleIds": [],
    }]

    progress = []

    async def on_progress(phase, completed, passed):
        progress.append((phase, completed, passed))

    status, metrics, results = await DefaultRunnerValidator(DefaultRunnerCompiler()).validate(
        protocol.ValidationRequest(
            run_id="validation-1",
            guardrail_id="guardrail-1",
            candidate_version="20260904-010000.001Z",
            source_draft_revision=1,
            plan=plan_to_proto(plan),
            runtime_profile="auto",
            test_cases=[validation_test_to_proto({
                **case,
                "trustedInstruction": "",
                "targetSource": "user_input",
                "groundingSources": [],
                "caseType": "scenario",
            }) for case in cases],
        ),
        on_progress=on_progress,
    )

    assert status == "passed"
    assert progress[0:2] == [("preparing", 0, 0), ("executing", 0, 0)]
    assert progress[-2:] == [("executing", 2, 2), ("finalizing", 2, 2)]
    assert all(a[1] <= b[1] for a, b in zip(progress, progress[1:]))
    assert metrics["total"] == 2
    assert metrics["passed"] == 2
    assert metrics["complianceRate"] == 100
    assert [(item["caseId"], item["actualDecision"], item["passed"]) for item in results] == [
        ("safe", "allow", True),
        ("blocked", "block", True),
    ]
    assert results[1]["findings"][0]["risk"] == "secrets"


@pytest.mark.asyncio
async def test_local_cases_allow_progress_to_flush_before_the_suite_finishes(monkeypatch) -> None:
    import asyncio
    import itertools
    from types import SimpleNamespace
    import runner.validator as module

    class Runtime:
        def __init__(self, _registry):
            pass

        async def shutdown(self):
            pass

    async def prepared(*_args, **_kwargs):
        return None, None

    monkeypatch.setattr(module, "NeMoRuntime", Runtime)
    monkeypatch.setattr(module, "prepare", prepared)
    monkeypatch.setattr(module, "validation_test_from_proto", lambda item: item.id)
    monkeypatch.setattr(module, "_metrics", lambda results: {"total": len(results)})
    monkeypatch.setattr(module, "time", SimpleNamespace(monotonic=lambda: next(ticks)))
    ticks = itertools.count()
    validator = DefaultRunnerValidator(DefaultRunnerCompiler())
    finished = []

    async def local_case(_runtime, _plan, case):
        # Like local detectors, this asynchronous function need not yield.
        finished.append(case)
        return {"caseId": case, "required": True, "passed": int(case) % 2 == 0}

    monkeypatch.setattr(validator, "_evaluate", local_case)
    outgoing = asyncio.Queue()
    flushed = []

    async def report(phase, completed, passed):
        outgoing.put_nowait((phase, completed, passed))

    async def sender():
        while True:
            observation = await outgoing.get()
            flushed.append((*observation, len(finished)))
            if observation[0] == "finalizing":
                return

    sending = asyncio.create_task(sender())
    status, metrics, results = await validator.validate(protocol.ValidationRequest(
        test_cases=[protocol.ValidationTestCase(id=str(index)) for index in range(32)],
    ), on_progress=report)
    await sending
    assert any(phase == "executing" and 0 < completed < 32 and at_flush < 32
               for phase, completed, _passed, at_flush in flushed)
    assert flushed[-1] == ("finalizing", 32, 16, 32)
    assert [result["caseId"] for result in results] == list(map(str, range(32)))
    assert status == "failed"
    assert metrics["total"] == 32
