from __future__ import annotations

import pytest

from runner.compiler import DefaultRunnerCompiler
from runner import generated as protocol
from runner.protocol_codec import artifact_digest, plan_to_proto, validation_test_to_proto
from runner.validator import DefaultRunnerValidator, _blocking_superseders


@pytest.mark.asyncio
async def test_default_runner_validates_cases_through_the_real_nemo_runtime() -> None:
    plan = {
        "guardrail_id": "guardrail-1",
        "guardrail_version": "20260904-010000.001Z",
        "compiler_version": "tasklattice-controller-plan-v1",
        "safety_level": "balanced",
        "output_delivery": "full_buffered",
        "steps": [{
            "id": "secrets:exact",
            "capability": "secrets",
            "contract_ref": "tali.guard.secrets.exact.v1",
            "phases": ["input", "output"],
            "on_unsafe": "block",
            "trigger": {"type": "always", "verdicts": []},
            "parameters": [["evaluation_view", "original"], ["precedence", "0"]],
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

    compiler = DefaultRunnerCompiler()
    outcome = await DefaultRunnerValidator(compiler).run(
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
    status, metrics, results = outcome.status, outcome.metrics, outcome.results

    assert status == "passed"
    # The tested candidate is the exact offline-compiled content: publication
    # can reuse it without compiling again.
    expected = compiler.compile(protocol.CompileRequest(
        guardrail_id="guardrail-1", guardrail_version="20260904-010000.001Z",
        plan=plan_to_proto(plan), runtime_profile="auto",
    ))
    assert outcome.artifact.checksum == expected.checksum == artifact_digest(outcome.artifact)
    assert outcome.artifact.generation == 0
    assert not outcome.artifact.signature and not outcome.artifact.artifact_id
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
        return None, None, protocol.Artifact(checksum="a" * 64)

    monkeypatch.setattr(module, "NeMoRuntime", Runtime)
    monkeypatch.setattr(module, "prepare", prepared)
    monkeypatch.setattr(module, "validation_test_from_proto", lambda item: {"id": item.id})
    monkeypatch.setattr(module, "_metrics", lambda results: {"total": len(results)})
    monkeypatch.setattr(module, "time", SimpleNamespace(monotonic=lambda: next(ticks)))
    ticks = itertools.count()
    validator = DefaultRunnerValidator(DefaultRunnerCompiler())
    finished = []

    async def local_case(_runtime, _plan, case):
        # Like local detectors, this asynchronous function need not yield.
        finished.append(case["id"])
        return {"caseId": case["id"], "required": True, "passed": int(case["id"]) % 2 == 0}

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


def test_validation_accuracy_does_not_count_failure_or_unknown_as_detector_errors():
    from runner.validator import _metrics

    base = {"expectedDecision": "allow", "actualDecision": "block", "passed": False,
            "actualFailure": None, "findings": [], "trace": [], "escalated": True, "latencyMs": 10}
    results = [
        {**base, "actualFailure": "timeout", "latencyMs": 30000},
        {**base, "actualFailure": "provider_failure", "expectedDecision": "block", "actualDecision": "allow"},
        {**base, "findings": [{"verdict": "unknown"}]},
        {**base, "trace": [{"verdict": "unknown"}], "expectedDecision": "block", "actualDecision": "allow"},
        {**base, "findings": [{"verdict": "matched"}]},
        {**base, "expectedDecision": "block", "actualDecision": "allow"},
        {**base, "actualDecision": "allow", "passed": True, "escalated": False},
        {**base, "actualDecision": "allow", "passed": True, "escalated": False},
    ]
    assert _metrics(results) == {"total": 8, "skipped": 0, "executed": 8, "passed": 2, "complianceRate": 25,
                                "falsePositiveRate": 12.5, "falseNegativeRate": 12.5,
                                "escalationRate": 75, "p95LatencyMs": 30000}


def test_block_rule_preempting_a_covered_transform_rule_is_composition_evidence():
    from types import SimpleNamespace

    def step(id, rule):
        return SimpleNamespace(id=id, capability="builtin_content_filter", phases=["input"],
                               parameters=(("policy_id", "local-credentials"), ("rule_id", rule)))
    plan = SimpleNamespace(
        policy_bindings=[SimpleNamespace(policy_id="local-credentials", policy_version="1.0.0",
            enabled_rule_ids=["credentials-api-keys/github_token", "pattern/github_token"],
            enabled_rails=["input"])],
        steps=[
            step("block", "credentials-api-keys/github_token"),
            step("transform", "pattern/github_token"),
        ],
        policy_versions=[],
    )
    findings = [
        {"policy_id": "local-credentials", "rule_id": "credentials-api-keys/github_token",
         "verdict": "matched", "recommended_action": "block"},
        {"policy_id": "local-credentials", "rule_id": "pattern/github_token",
         "verdict": "matched", "recommended_action": "transform"},
        {"policy_id": "builtin-content-safety", "rule_id": "model/content-safety",
         "verdict": "matched", "recommended_action": "block"},
    ]
    superseders = _blocking_superseders(
        plan, {"sourcePolicyId": "local-credentials", "coveredRuleIds": ["pattern/github_token"]},
        "input", findings, {"pattern/github_token"}, "local-credentials",
    )
    assert [(item["policy_id"], item["rule_id"]) for item in superseders] == [
        ("local-credentials", "credentials-api-keys/github_token"),
    ]


@pytest.mark.asyncio
async def test_shadowed_transform_rule_acceptance_passes_with_block_precedence():
    from types import SimpleNamespace
    from runner.toolkit.runtime.contracts import ProtectionDecision, RiskFinding

    def step(id, rule):
        return SimpleNamespace(
            id=id, capability="builtin_content_filter", phases=["input"],
            parameters=(("policy_id", "local-credentials"), ("rule_id", rule)),
            trigger=SimpleNamespace(type="always", verdicts=[]),
        )
    plan = SimpleNamespace(
        guardrail_id="guardrail-1", guardrail_version="v1", output_delivery="full_buffered",
        policy_bindings=[SimpleNamespace(
            policy_id="local-credentials", policy_version="1.0.0",
            enabled_rule_ids=["credentials-api-keys/github_token", "pattern/github_token"],
            enabled_rails=["input"], action="transform", rule_actions=(),
        )],
        steps=[
            step("block", "credentials-api-keys/github_token"),
            step("transform", "pattern/github_token"),
        ],
        policy_versions=[], modules=[],
    )
    case = {
        "id": "case", "policyId": "local-credentials", "sourcePolicyId": "local-credentials",
        "sourcePolicyVersion": "1.0.0", "phase": "input", "content": "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "expectedDecision": "transform", "caseType": "rule_acceptance",
        "coveredRuleIds": ["pattern/github_token"], "required": True,
        "trustedInstruction": "", "targetSource": "user_input",
    }
    findings = (
        RiskFinding(risk="builtin_content_filter", taxonomy_id="TALI-PRIVACY-CREDENTIAL",
            verdict="matched", confidence=None, evidence="block", recommended_action="block",
            policy_id="local-credentials", rule_id="credentials-api-keys/github_token"),
        RiskFinding(risk="builtin_content_filter", taxonomy_id="TALI-PRIVACY-CREDENTIAL",
            verdict="matched", confidence=None, evidence="transform", recommended_action="transform",
            policy_id="local-credentials", rule_id="pattern/github_token"),
    )

    class Runtime:
        async def evaluate(self, _request):
            return ProtectionDecision(decision="block", action="block", reason="blocked", findings=findings)

    result = await DefaultRunnerValidator(DefaultRunnerCompiler())._evaluate(Runtime(), plan, case)
    assert result["passed"] is True
    assert result["actualDecision"] == "block"
    assert result["expectedDecision"] == "transform"
    assert result["supersededBy"] == [{"policyId": "local-credentials", "ruleId": "credentials-api-keys/github_token"}]
    assert "local block-first composition" in result["reason"]
