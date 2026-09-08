from __future__ import annotations

import asyncio
import math
import time
from dataclasses import asdict
from typing import Any

from runner.toolkit.nemo.action_registry import ActionProviders, action_providers
from runner.toolkit.nemo.actions import (
    EvaluationActionProvider,
    EvaluationRoute,
    local_action_providers,
)
from runner.toolkit.nemo.evaluators.pii import PiiEvaluator
from runner.toolkit.evaluation.contracts import CONTRACT_PII_EXACT
from runner.toolkit.policy_library import policy as catalog_policy
from runner.toolkit.nemo.registry import NeMoRuntimeRegistry
from runner.toolkit.nemo.runtime import NeMoRuntime
from runner.toolkit.runtime.content_views import content_view
from runner.toolkit.runtime.contracts import (
    ContentViewSnapshot,
    EngineRequest,
    GuardContentBlock,
    GuardrailPlanSnapshot,
    NeMoConfigSnapshot,
    RequestContext,
)

from .compiler import DefaultRunnerCompiler
from .artifact_config import config_snapshot_from_artifact
from . import generated as protocol
from .protocol_codec import (
    plan_from_proto,
    validation_test_from_proto,
)
from .serialization import plan_from_dict


class DefaultRunnerValidator:
    """Compile a draft and run its reviewed cases through the real NeMo runtime."""

    def __init__(
        self,
        compiler: DefaultRunnerCompiler,
        providers: ActionProviders | None = None,
    ) -> None:
        self._compiler = compiler
        self._providers = providers or _local_validation_providers()

    async def validate(
        self, request: protocol.ValidationRequest
    ) -> tuple[str, dict[str, Any], list[dict[str, Any]]]:
        artifact = await asyncio.to_thread(
            self._compiler.compile,
            protocol.CompileRequest(
                compile_id=request.run_id,
                guardrail_id=request.guardrail_id,
                guardrail_version=request.candidate_version,
                generation=0,
                plan=request.plan,
                runtime_profile=request.runtime_profile,
            ),
        )
        plan = plan_from_dict(plan_from_proto(artifact.plan))
        config = _config_from_artifact(artifact)
        store = _CandidateStore(plan, config)
        registry = NeMoRuntimeRegistry(
            store,
            self._providers,
            max_entries=1,
            max_concurrency_per_guardrail=8,
            native_models=self._compiler.native_models,
        )
        runtime = NeMoRuntime(registry)
        try:
            cases = [validation_test_from_proto(item) for item in request.test_cases]
            if not cases:
                raise ValueError("Validation requires at least one Test Case.")
            results = await asyncio.gather(
                *(self._evaluate(runtime, plan, item) for item in cases)
            )
        finally:
            await runtime.shutdown()
        required = [item for item in results if item["required"]]
        status = "passed" if required and all(item["passed"] for item in required) else "failed"
        return status, _metrics(results), results

    async def _evaluate(
        self,
        runtime: NeMoRuntime,
        plan: GuardrailPlanSnapshot,
        raw: object,
    ) -> dict[str, Any]:
        case = _record(raw)
        phase = "output" if case.get("phase") == "output" else "input"
        content = _string(case.get("content"))
        view = _test_content_view(case, phase, content)
        started = time.perf_counter()
        decision = await runtime.evaluate(
            EngineRequest(
                phase=phase,
                text=content,
                plan=plan,
                context_messages=_test_context_messages(case, phase, content),
                trusted_instruction=_string(case.get("trustedInstruction")),
                target_source=(view.active_block.source if view else _string(case.get("targetSource")) or ("model_output" if phase == "output" else "user_input")),
                content_view=view,
                active_block_id=view.active_block_id if view else None,
                evidence_scope="full",
                request_context=RequestContext(protocol="validation"),
            )
        )
        latency = max(0, round((time.perf_counter() - started) * 1_000))
        findings = [asdict(item) for item in decision.findings]
        trace = [asdict(item) for item in decision.trace]
        template_expected = _string(case.get("expectedDecision"))
        override = _record(case.get("expectationOverride") or {})
        expected = _string(override.get("expectedDecision")) if override else template_expected
        covered = {_string(item) for item in _list(case.get("coveredRuleIds"))}
        source_policy_id = _optional_string(case.get("sourcePolicyId"))
        matched = sorted({
            _string(item.get("rule_id"))
            for item in findings
            if isinstance(item, dict)
            and item.get("rule_id")
            and item.get("verdict") in {"unsafe", "uncertain"}
            and (source_policy_id is None or item.get("policy_id") == source_policy_id)
        })
        expected_failure = _optional_string(case.get("expectedFailure"))
        timed_out = any(bool(item.get("timed_out")) for item in trace)
        provider_failed = any(item.get("kind") == "action" and item.get("status") == "error" and not item.get("timed_out") for item in trace)
        actual_failure = "timeout" if timed_out else "provider_failure" if provider_failed else None
        rule_contract = (
            expected_failure is not None
            or not covered
            or (expected == "allow" and covered.isdisjoint(matched))
            or (expected != "allow" and not covered.isdisjoint(matched))
        )
        output_content = decision.texts[0] if decision.texts else "" if decision.decision == "block" else content
        assertion_failures = []
        runtime_failed = (
            (decision.usage is not None and decision.usage.fail_closed)
            or any(item.get("kind") == "runtime" and item.get("status") == "error" for item in trace)
        )
        if runtime_failed and actual_failure is None:
            assertion_failures.append("Runtime failed closed without a classified infrastructure failure; this is not a Policy match.")
        preempting_matches = []
        if (not override and not rule_contract and expected in {"block", "intervene"}
                and decision.decision == "block" and decision.action == "reject"
                and not runtime_failed and actual_failure is None and expected_failure is None):
            preempting_matches = _ordered_preemption(plan, case, phase, findings, trace)
            rule_contract = bool(preempting_matches)
        if override:
            actual_matches = {
                (item.get("policy_id"), item.get("rule_id")) for item in findings
                if item.get("verdict") in {"unsafe", "uncertain"}
            }
            expected_matches = {
                (_record(item).get("policyId"), _record(item).get("ruleId"))
                for item in _list(override.get("expectedMatches"))
            }
            valid_override = (
                bool(_string(override.get("reason")).strip())
                and override.get("sourcePolicyVersion") == case.get("sourcePolicyVersion")
                and (bool(expected_matches) if expected != "allow" else template_expected == "allow")
                and (expected != "transform" or "expectedOutputContent" in override)
            )
            rule_contract = valid_override and (
                expected_matches.issubset(actual_matches) if expected != "allow" else not actual_matches
            )
            if not valid_override:
                assertion_failures.append("The reviewed expectation is invalid or stale.")
            if "expectedOutputContent" in override and output_content != override["expectedOutputContent"]:
                assertion_failures.append("Output content does not match the reviewed complete-output assertion.")
        if not rule_contract:
            assertion_failures.append("Expected Policy/Rule evidence was not observed.")
        if decision.decision != expected and not (expected == "intervene" and decision.decision != "allow"):
            assertion_failures.append(f"Expected {expected}; received {decision.decision}.")
        if actual_failure != expected_failure:
            assertion_failures.append(f"Expected infrastructure failure {expected_failure}; received {actual_failure}.")
        actual_reasoning = _reasoning_result(findings)
        expected_reasoning = _optional_string(case.get("expectedReasoningResult"))
        evaluation_contracts = sorted({
            _string(item.get("contract_ref"))
            for item in trace
            if item.get("contract_ref") and item.get("status") != "skipped"
        })
        evaluator_ids = sorted({
            _string(item.get("evaluator_id") or item.get("action_name"))
            for item in trace
            if item.get("kind") in {"evaluator", "action"}
            and (item.get("evaluator_id") or item.get("action_name"))
            and item.get("status") != "skipped"
        })
        escalated = any(
            step.trigger.type == "on_result"
            and step.contract_ref in evaluation_contracts
            for step in plan.steps
        )
        passed = (
            (decision.decision != "allow" if expected == "intervene" else decision.decision == expected)
            and (expected_failure is None or expected_failure == actual_failure)
            and rule_contract
            and (expected_reasoning is None or expected_reasoning == actual_reasoning)
            and not assertion_failures
        )
        return {
            "caseId": _string(case.get("id")),
            "name": _string(case.get("name")),
            "policyId": _string(case.get("policyId")),
            "expectedDecision": expected,
            "actualDecision": decision.decision,
            "passed": passed,
            "evaluatorIds": evaluator_ids,
            "latencyMs": latency,
            "reason": "; ".join([
                decision.reason or "",
                *([f"Reviewed composition expectation: {_string(override.get('reason'))}"] if override else []),
                *(["Execution order satisfied: an earlier Rule blocked the request before the target Rule could run."] if preempting_matches else []),
                *assertion_failures,
            ]).strip("; "),
            "phase": phase,
            "inputContent": content,
            "action": decision.action,
            "outputContent": output_content,
            "assertionFailures": assertion_failures,
            **({"expectationOverride": override, "templateExpectedDecision": template_expected} if override else {}),
            "findings": findings,
            "trace": trace,
            "trustedInstruction": _string(case.get("trustedInstruction")),
            "targetSource": _string(case.get("targetSource")) or ("model_output" if phase == "output" else "user_input"),
            "query": _string(case.get("query")),
            "groundingSources": [_string(item) for item in _list(case.get("groundingSources"))],
            "expectedReasoningResult": expected_reasoning,
            "actualReasoningResult": actual_reasoning,
            "caseType": _string(case.get("caseType")) or "scenario",
            "required": bool(case.get("required", True)),
            "expectedFailure": expected_failure,
            "actualFailure": actual_failure,
            "concurrencyGroup": _optional_string(case.get("concurrencyGroup")),
            "sourcePolicyId": source_policy_id,
            "sourcePolicyVersion": _optional_string(case.get("sourcePolicyVersion")),
            "sourceCaseId": _optional_string(case.get("sourceCaseId")),
            "coveredRuleIds": sorted(covered),
            "matchedRuleIds": matched,
            "preemptingMatches": preempting_matches,
            "evaluationContracts": evaluation_contracts,
            "escalated": escalated,
            "modelInvocations": (
                decision.usage.model_invocations if decision.usage is not None else 0
            ),
        }


def _ordered_preemption(
    plan: GuardrailPlanSnapshot, case: dict[str, Any], phase: str,
    findings: list[dict[str, Any]], trace: list[dict[str, Any]],
) -> list[dict[str, str]]:
    """Prove a terminal match precedes every covered target in the authored order.

    A matching final decision alone is insufficient: fail-closed responses and
    unrelated/later detections cannot stand in for a target Rule. Transformations
    continue execution and retain their exact-output assertions.
    """
    bindings = list(plan.policy_bindings)
    target_index = next((i for i, b in enumerate(bindings)
                         if b.policy_id == case.get("sourcePolicyId")), None)
    if target_index is None:
        return []
    target = bindings[target_index]
    covered = set(_list(case.get("coveredRuleIds")))
    if (target.policy_version != case.get("sourcePolicyVersion")
            or phase not in target.enabled_rails or not covered
            or not covered.issubset(target.enabled_rule_ids)):
        return []

    def rule_ids(binding):
        # Match the compiler/runtime: explicit order, then the pinned source order.
        version = next((v for v in plan.policy_versions
                        if v.policy_id == binding.policy_id and v.version == binding.policy_version), None)
        if version:
            defaults = [f"flow/{rail.rail_type}/{rail.flow_name}" for rail in version.rail_bindings
                        if rail.rail_type == phase]
        else:
            definition = catalog_policy(binding.policy_id)
            defaults = [r.id for r in definition.rules if phase in r.rails] if definition and definition.version == binding.policy_version else []
        return list(dict.fromkeys([*binding.rule_order, *defaults]))

    target_order = rule_ids(target)
    target_executed = any(t.get("kind") == "action" and t.get("policy_id") == target.policy_id
                          and t.get("status") != "skipped" for t in trace)
    for finding in findings:
        if finding.get("verdict") != "unsafe" or finding.get("recommended_action") != "reject":
            continue
        index = next((i for i, b in enumerate(bindings) if b.policy_id == finding.get("policy_id")), None)
        if index is None or index > target_index:
            continue
        binding = bindings[index]
        rule_id = finding.get("rule_id")
        if phase not in binding.enabled_rails or rule_id not in binding.enabled_rule_ids:
            continue
        if index < target_index:
            if target_executed:
                continue
        else:
            if rule_id not in target_order or not covered.issubset(target_order):
                continue
            if target_order.index(rule_id) >= min(target_order.index(r) for r in covered):
                continue
        return [{"policyId": binding.policy_id, "ruleId": rule_id}]
    return []


def _local_validation_providers() -> ActionProviders:
    local = local_action_providers()
    evaluation = EvaluationActionProvider((
        EvaluationRoute("pii", CONTRACT_PII_EXACT, PiiEvaluator()),
    ))
    return action_providers(*local, evaluation)


class _CandidateStore:
    def __init__(self, plan: GuardrailPlanSnapshot, config: NeMoConfigSnapshot) -> None:
        self._plan = plan
        self._config = config

    def plan(self, guardrail_id: str, version: str) -> GuardrailPlanSnapshot:
        if (guardrail_id, version) != (self._plan.guardrail_id, self._plan.guardrail_version):
            raise KeyError((guardrail_id, version))
        return self._plan

    def nemo_config(self, guardrail_id: str, version: str) -> NeMoConfigSnapshot:
        self.plan(guardrail_id, version)
        return self._config

    def active_plan_keys(self) -> tuple[tuple[str, str], ...]:
        return ((self._plan.guardrail_id, self._plan.guardrail_version),)


def _config_from_artifact(artifact: protocol.Artifact) -> NeMoConfigSnapshot:
    return config_snapshot_from_artifact(artifact)


def _test_context_messages(case: dict[str, Any], phase: str, content: str) -> tuple[dict[str, str], ...]:
    messages: list[dict[str, str]] = []
    trusted = _string(case.get("trustedInstruction")).strip()
    if trusted:
        messages.append({"role": "system", "content": trusted})
    messages.append({"role": "user" if phase == "input" else "assistant", "content": content})
    return tuple(messages)


def _test_content_view(case: dict[str, Any], phase: str, content: str) -> ContentViewSnapshot | None:
    query = _string(case.get("query")).strip()
    sources = [_string(item) for item in _list(case.get("groundingSources")) if _string(item).strip()]
    if not query and not sources:
        return None
    case_id = _string(case.get("id")) or "case"
    blocks: list[GuardContentBlock] = []
    if query:
        blocks.append(GuardContentBlock(id=f"{case_id}:query", text=query, role="query", trust="untrusted", source="query", qualifiers=("query",)))
    blocks.extend(
        GuardContentBlock(id=f"{case_id}:source:{index}", text=source, role="grounding_source", trust="untrusted", source="grounding_source", qualifiers=("grounding_source",))
        for index, source in enumerate(sources, start=1)
    )
    blocks.append(GuardContentBlock(
        id=f"{case_id}:target", text=content,
        role="model_output" if phase == "output" else "user_input",
        trust="untrusted", source="model_output" if phase == "output" else "user_input",
        qualifiers=("guard_content",),
    ))
    return content_view(tuple(blocks), blocks[-1].id)


def _metrics(results: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(results)
    passed = sum(bool(item["passed"]) for item in results)
    false_positive = sum(item["expectedDecision"] == "allow" and item["actualDecision"] != "allow" for item in results)
    false_negative = sum(item["expectedDecision"] != "allow" and item["actualDecision"] == "allow" for item in results)
    escalated = sum(bool(item["escalated"]) for item in results)
    latencies = sorted(int(item["latencyMs"]) for item in results) or [0]
    return {
        "total": total,
        "passed": passed,
        "complianceRate": _percent(passed, total),
        "falsePositiveRate": _percent(false_positive, total),
        "falseNegativeRate": _percent(false_negative, total),
        "escalationRate": _percent(escalated, total),
        "p95LatencyMs": latencies[max(0, math.ceil(len(latencies) * 0.95) - 1)],
    }


def _reasoning_result(findings: list[dict[str, Any]]) -> str | None:
    for finding in findings:
        reasoning = finding.get("reasoning")
        if isinstance(reasoning, (list, tuple)) and reasoning and isinstance(reasoning[0], dict):
            return _optional_string(reasoning[0].get("result"))
    return None


def _record(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Validation Test Cases must be JSON objects.")
    return value


def _list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _string(value: object) -> str:
    return value if isinstance(value, str) else ""


def _optional_string(value: object) -> str | None:
    result = _string(value).strip()
    return result or None


def _percent(value: int, total: int) -> float:
    return round(value / total * 100, 2) if total else 0.0
