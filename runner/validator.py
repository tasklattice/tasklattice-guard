from __future__ import annotations

import asyncio
import json
import math
import time
from dataclasses import asdict, dataclass
from collections.abc import Awaitable, Callable
from typing import Any

from runner.toolkit.nemo.action_registry import ActionProviders, action_providers
from runner.toolkit.nemo.actions import (
    EvaluationActionProvider,
    EvaluationRoute,
    local_action_providers,
)
from runner.toolkit.nemo.actions.content_filter import (
    BuiltinContentFilter,
    evaluate_parameters,
)
from runner.toolkit.nemo.evaluators.pii import PiiEvaluator
from runner.toolkit.evaluation.contracts import CONTRACT_PII_EXACT
from runner.toolkit.nemo.registry import NeMoRuntimeRegistry
from runner.toolkit.nemo.runtime import NeMoRuntime
from runner.toolkit.runtime.content_views import content_view
from runner.toolkit.runtime.contracts import (
    flow_rule_id,
    ContentViewSnapshot,
    EngineRequest,
    GuardContentBlock,
    GuardrailPlanSnapshot,
    NeMoConfigSnapshot,
    RequestContext,
)

from .compiler import DefaultRunnerCompiler
from .preparation import prepare
from .artifact_config import config_snapshot_from_artifact
from . import generated as protocol
from .protocol_codec import (
    plan_from_proto,
    validation_test_from_proto,
)
from .serialization import plan_from_dict
from .toolkit.compiler.semantics import complete_evidence_supported
from .validation_scope import local_test_plan, skipped_case
from .protocol_codec import plan_to_proto


@dataclass(frozen=True)
class ValidationOutcome:
    """Test evidence plus the exact Artifact content the cases ran against."""

    status: str
    metrics: dict[str, Any]
    results: list[dict[str, Any]]
    artifact: protocol.Artifact
    test_scope: dict[str, Any] | None = None


class DefaultRunnerValidator:
    """Run reviewed cases through the real NeMo runtime: a draft compiled into a
    candidate, or a released version's signed Artifact tested as it is."""

    def __init__(
        self,
        compiler: DefaultRunnerCompiler,
        providers: ActionProviders | None = None,
        verify_artifact: Callable[[protocol.Artifact], Any] | None = None,
        *, max_concurrency: int = 8,
    ) -> None:
        if max_concurrency < 1:
            raise ValueError("Validation concurrency must be positive.")
        self._max_concurrency = max_concurrency
        self._compiler = compiler.snapshot()
        self._providers = providers or _local_validation_providers()
        # Verifies a released Artifact's checksum and signature exactly as
        # distribution would; returns its plan and NeMo configuration.
        self._verify_artifact = verify_artifact

    @property
    def compiler_model_types(self) -> tuple[str, ...]:
        return tuple(model.type for model in self._compiler.native_models)

    async def validate(
        self, request: protocol.ValidationRequest,
        on_progress: Callable[[str, int, int], Awaitable[None]] | None = None,
    ) -> tuple[str, dict[str, Any], list[dict[str, Any]]]:
        outcome = await self.run(request, on_progress)
        return outcome.status, outcome.metrics, outcome.results

    async def run(
        self, request: protocol.ValidationRequest,
        on_progress: Callable[[str, int, int], Awaitable[None]] | None = None,
    ) -> ValidationOutcome:
        async def cleanup(prepared):
            await prepared[0].shutdown()

        async def report(phase: str, completed: int = 0, passed: int = 0):
            if on_progress is not None:
                await on_progress(phase, completed, passed)

        await report("preparing")
        registry, plan, artifact = await prepare(self._prepare, request, on_cancel=cleanup)
        test_models = not request.HasField("test_model_rules") or request.test_model_rules
        skipped_rules = []
        execution_digest = artifact.checksum
        if not test_models:
            # _prepare loads the complete publication Artifact first. Only the
            # private test runtime is projected; outcome.artifact remains full.
            await registry.shutdown()
            scoped, skipped_rules = local_test_plan(plan_from_proto(artifact.plan))
            scoped_request = protocol.ValidationRequest(
                run_id=request.run_id, guardrail_id=request.guardrail_id,
                candidate_version=request.candidate_version,
                plan=plan_to_proto(scoped), runtime_profile="auto",
            )
            registry, plan, execution_artifact = await prepare(self._prepare, scoped_request, on_cancel=cleanup)
            execution_digest = execution_artifact.checksum
        runtime = NeMoRuntime(registry)
        try:
            cases = [validation_test_from_proto(item) for item in request.test_cases]
            if not cases:
                raise ValueError("Validation requires at least one Test Case.")
            await report("executing")
            completed = passed = 0
            last_report = time.monotonic()
            slots = asyncio.Semaphore(self._max_concurrency)

            async def evaluate(case):
                nonlocal completed, passed, last_report
                # Match the runtime's admission capacity. Local evaluators may complete
                # without yielding; a bounded batch lets gRPC flush progress/heartbeats
                # instead of starving the control channel behind the entire test suite.
                async with slots:
                    result = (skipped_case(case, skipped_rules) if skipped_rules else None) or await self._evaluate(runtime, plan, case)
                    completed += 1
                    passed += int(result["passed"])
                    now = time.monotonic()
                    if completed == len(cases) or now - last_report >= 0.5:
                        last_report = now
                        await report("executing", completed, passed)
                    await asyncio.sleep(0)
                    return result

            results = await asyncio.gather(
                *(evaluate(item) for item in cases)
            )
            await report("finalizing", completed, passed)
        finally:
            await runtime.shutdown()
        required = [item for item in results if item["required"] and not item.get("skipped")]
        status = "passed" if required and all(item["passed"] for item in required) else "failed"
        calls = sum(item.get("modelInvocations", 0) for item in results)
        if not test_models and calls:
            raise RuntimeError("Local-only validation unexpectedly invoked a model.")
        return ValidationOutcome(status, _metrics(results), results, artifact, {
            "testModelRules": test_models, "skippedRules": skipped_rules,
            "modelInvocations": calls, "executionDigest": execution_digest, "fullArtifactLoaded": True,
        })

    def _prepare(self, request: protocol.ValidationRequest):
        if request.HasField("artifact"):
            # A released version is tested as it is: never compiled again.
            if self._verify_artifact is None:
                raise RuntimeError("This Runner cannot verify released Artifacts.")
            artifact = request.artifact
            verified = self._verify_artifact(artifact)
            plan, config = verified.plan, verified.config
        else:
            artifact = self._compiler.compile(
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
            max_concurrency_per_guardrail=self._max_concurrency,
            native_models=self._compiler.native_models,
        )
        return registry, plan, artifact

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
            and item.get("verdict") == "matched"
            and (source_policy_id is None or item.get("policy_id") == source_policy_id)
        })
        expected_failure = _optional_string(case.get("expectedFailure"))
        timed_out = any(bool(item.get("timed_out")) for item in trace)
        provider_failed = any(item.get("kind") == "action" and item.get("status") == "error" and not item.get("timed_out") for item in trace)
        actual_failure = "timeout" if timed_out else "provider_failure" if provider_failed else None
        output_content = decision.texts[0] if decision.texts else "" if decision.decision == "block" else content
        assertion_failures = []
        runtime_failed = (
            (decision.usage is not None and decision.usage.fail_closed)
            or any(item.get("kind") == "runtime" and item.get("status") == "error" for item in trace)
        )
        if runtime_failed and actual_failure is None:
            assertion_failures.append("Runtime failed closed without a classified infrastructure failure; this is not a Policy match.")
        # Require actual observations on declared views. Missing execution is not
        # a negative detection, and another Rule's match is not target evidence.
        evidence = _case_evidence(
            plan, case, phase, expected, decision, findings, matched, content,
            trusted=not runtime_failed and actual_failure is None and expected_failure is None, trace=trace,
        )
        rule_contract = expected_failure is not None or evidence["satisfied"]
        if override:
            actual_matches = {
                (item.get("policy_id"), item.get("rule_id")) for item in findings
                if item.get("verdict") == "matched"
            }
            expected_matches = {
                (_record(item).get("policyId"), _record(item).get("ruleId"))
                for item in _list(override.get("expectedMatches"))
            }
            bindings = {binding.policy_id: binding for binding in plan.policy_bindings}
            records_only = (
                expected == "allow" and bool(covered)
                and {(source_policy_id, rule_id) for rule_id in covered}.issubset(expected_matches)
                and override.get("expectedOutputContent") == content
                and all(
                    policy_id in bindings
                    and rule_id in bindings[policy_id].enabled_rule_ids
                    and dict(bindings[policy_id].rule_actions).get(rule_id, bindings[policy_id].action) == "allow"
                    for policy_id, rule_id in expected_matches
                )
                and all(item.get("recommended_action") == "allow" for item in findings)
            )
            declared_override = all(_declared_rule(plan, policy_id, rule_id, phase)
                                    for policy_id, rule_id in expected_matches)
            valid_override = (
                declared_override and evidence["status"] not in {"missing", "unverifiable"}
                and bool(_string(override.get("reason")).strip())
                and override.get("sourcePolicyVersion") == case.get("sourcePolicyVersion")
                and (bool(expected_matches) if expected != "allow" else template_expected == "allow" or records_only)
                and (expected != "transform" or "expectedOutputContent" in override)
            )
            rule_contract = valid_override and (
                expected_matches.issubset(actual_matches) if expected != "allow" or records_only
                else evidence["satisfied"] and not actual_matches
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
                *_evidence_reason(evidence),
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
            "preemptingMatches": [],  # Legacy reports used this as a passing substitute.
            "evidenceStatus": evidence["status"],
            "evidenceDetail": evidence.get("reason", ""),
            "verifiedRuleIds": evidence["verifiedRules"],
            "supersededBy": _superseded_by(evidence),
            "ruleContractSatisfied": bool(rule_contract),
            "evidenceContract": "rule-evidence-v1",
            "evaluationContracts": evaluation_contracts,
            "escalated": escalated,
            "modelInvocations": (
                decision.usage.model_invocations if decision.usage is not None else 0
            ),
        }


def _case_evidence(
    plan: GuardrailPlanSnapshot, case: dict[str, Any], phase: str, expected: str,
    decision: Any, findings: list[dict[str, Any]], matched: list[str], content: str,
    *, trusted: bool = True, trace: list[dict[str, Any]] | tuple = (),
) -> dict[str, Any]:
    """Classify target evidence without treating another Rule as its proof.

    Counterfactual local rechecks explain redaction shadowing only. They never
    satisfy acceptance, and never claim a model ran or observed a match.
    """
    covered = sorted({_string(value) for value in _list(case.get("coveredRuleIds")) if _string(value)})
    evidence: dict[str, Any] = {
        "status": "not_required", "satisfied": not covered, "coveredRuleIds": covered,
        "supersededBy": [], "verifiedRules": [],
    }
    if not covered:
        return evidence
    policy_id = _optional_string(case.get("sourcePolicyId"))
    if policy_id is None:
        evidence.update(status="unverifiable", reason="Covered Rules need a pinned source Policy identity.")
        return evidence
    binding = _policy_binding(plan, policy_id)
    if binding is None or binding.policy_version != _string(case.get("sourcePolicyVersion")):
        evidence.update(status="missing", reason="The Test Case does not match the compiled Policy version.")
        return evidence
    if phase not in binding.enabled_rails:
        evidence.update(status="missing", reason="The compiled Policy does not inspect this phase.")
        return evidence
    if not set(covered).issubset(binding.enabled_rule_ids):
        evidence.update(status="missing", reason="One or more covered Rules are not enabled in this Guardrail.")
        return evidence
    targets = {rule: _rule_target(plan, policy_id, rule, phase) for rule in covered}
    if any(resolved is None for resolved in targets.values()):
        evidence.update(status="missing", reason="The compiled plan does not contain every covered Rule.")
        return evidence

    observed = sorted(set(covered).intersection(matched))
    evidence["verifiedRules"] = observed
    # Scenario coverage lists alternatives (for example any credential kind),
    # while Rule acceptance requires each named target. Both need real matches
    # within the pinned source, never an unrelated Policy's intervention.
    scenario = case.get("caseType") == "scenario"
    if observed and (expected == "allow" or scenario or set(covered).issubset(observed)):
        evidence.update(status="observed", satisfied=trusted and expected != "allow",
                        reason=("The scenario observed a match within its declared coverage; other covered Rules are not certified."
                                if scenario else "The covered Rules produced matched findings on their declared views."))
        return evidence

    def reached(rule):
        target = targets[rule]
        # Legacy/custom content-filter steps can contain several Rules and stop
        # inside the Action on their first Block. A matched Action trace cannot
        # prove that a different Rule in that same step was reached.
        if not complete_evidence_supported(plan) and target.get("canShortCircuitRules") and any(
            item.get("policy_id") == policy_id and item.get("verdict") == "matched"
            and item.get("recommended_action") == "block" for item in findings
        ):
            return False
        steps = target.get("steps", ())
        if steps:
            executed = {item.get("id"): item for item in trace
                        if item.get("kind") == "action" and item.get("status") not in {"skipped", "cancelled"}}
            for step in steps:
                prerequisite = executed.get(f"nemo:action:{step.trigger.step_ref}", {})
                required = step.trigger.type == "always" or prerequisite.get("verdict") in step.trigger.verdicts
                if required and f"nemo:action:{step.id}" not in executed:
                    return False
            # A native Rule can span an exact/semantic chain. Its completed
            # terminal evaluator decides absence; an intermediate unknown does
            # not invalidate a conclusive escalation, or certify one by itself.
            terminal = next((executed[f"nemo:action:{step.id}"] for step in reversed(steps)
                             if f"nemo:action:{step.id}" in executed), {})
            return terminal.get("verdict") in {"matched", "not_matched"}
        return any(item.get("id") == f"nemo:action:{target['bindingId']}"
                   and item.get("verdict") in {"matched", "not_matched"}
                   for item in trace)

    pending = [rule for rule in covered if rule not in observed]
    if all(reached(rule) for rule in pending):
        evidence.update(status="absent" if expected == "allow" else "not_matched",
                        satisfied=trusted and expected == "allow",
                        reason="The covered Rules ran but did not match on their declared views.")
        # Only an original-input match plus an actual transform can explain
        # consumption. This is diagnostic evidence, never a passing substitute.
        mutating = [item for item in findings if item.get("verdict") == "matched"
                    and item.get("recommended_action") == "transform"
                    and _declared_rule(plan, item.get("policy_id"), item.get("rule_id"), phase)]
        consumed = [rule for rule in pending if targets[rule]["view"] == "previous_output"
                    and targets[rule].get("capability") == "builtin_content_filter"
                    and _rule_matches_content(targets[rule]["parameters"], rule, phase, content)]
        if expected != "allow" and mutating and len(consumed) == len(pending):
            evidence.update(status="shadowed_by", supersededBy=_merge_matches(mutating),
                            reason="The covered Rules match the original input only, not their declared transformed views; this does not prove Rule acceptance.")
        return evidence

    terminal = [item for item in findings if item.get("verdict") == "matched"
                and item.get("recommended_action") == "block"
                and _declared_rule(plan, item.get("policy_id"), item.get("rule_id"), phase)]
    evidence.update(status="preempted_by" if terminal and decision.decision == "block" else "not_reached",
                    supersededBy=_merge_matches(terminal),
                    reason="The run did not observe a conclusive result for every covered Rule; another Rule cannot satisfy its acceptance test.")
    return evidence


def _policy_binding(plan: GuardrailPlanSnapshot, policy_id: str | None):
    if policy_id is None:
        return None
    return next((item for item in plan.policy_bindings if item.policy_id == policy_id), None)


def _declared_rule(
    plan: GuardrailPlanSnapshot, policy_id: str | None, rule_id: str | None, phase: str,
) -> bool:
    """Only an enabled Rule of a compiled Policy can supersede a covered Rule."""
    binding = _policy_binding(plan, policy_id)
    return bool(
        rule_id
        and binding is not None
        and phase in binding.enabled_rails
        and rule_id in binding.enabled_rule_ids
        and _rule_target(plan, policy_id, rule_id, phase) is not None
    )


def _rule_target(
    plan: GuardrailPlanSnapshot, policy_id: str | None, rule_id: str, phase: str,
) -> dict[str, Any] | None:
    """Resolve one covered Rule to the compiled step or NeMo Flow that owns it."""
    if policy_id is None:
        return None
    resolved_steps = []
    for step in plan.steps:
        if phase not in step.phases:
            continue
        parameters = dict(step.parameters)
        if parameters.get("policy_id") != policy_id:
            continue
        selected = _policy_binding(plan, policy_id)
        # Catalog-native Actions own the binding's sole detector Rule. Match the
        # Runtime's identity mapping without inventing a missing executable step.
        native_single_rule = (step.capability != "builtin_content_filter"
                              and not parameters.get("rule_id") and selected is not None
                              and selected.enabled_rule_ids == (rule_id,)
                              and parameters.get("policy_version") == selected.policy_version)
        if parameters.get("rule_id") == rule_id or rule_id in _compiled_rules(parameters) or native_single_rule:
            resolved_steps.append(step)
    if resolved_steps:
        step = resolved_steps[0]
        parameters = dict(step.parameters)
        return {
            "bindingId": step.id,
            "steps": resolved_steps,
            "capability": step.capability,
            "canShortCircuitRules": step.capability == "builtin_content_filter" and len(_compiled_rules(parameters)) > 1,
            "view": parameters.get("evaluation_view", ""),
            "parameters": step.parameters,
        }
    for version in plan.policy_versions:
        if version.policy_id != policy_id:
            continue
        for rail in version.rail_bindings:
            if rail.rail_type == phase and flow_rule_id(phase, rail.flow_name) == rule_id:
                return {
                    "bindingId": f"tl.{policy_id}.v{version.version}.{rail.flow_name}",
                    "view": "previous_output" if rail.execution_mode == "mutate" else "",
                    "parameters": (),
                }
    return None


def _compiled_rules(parameters: dict[str, Any]) -> list[str]:
    try:
        decoded = json.loads(parameters.get("enabled_rules_json", "{}"))
    except ValueError:
        return []
    if not isinstance(decoded, dict):
        return []
    rules = decoded.get(parameters.get("policy_id"))
    return [item for item in rules if isinstance(item, str)] if isinstance(rules, list) else []


def _rule_matches_content(parameters: tuple[tuple[str, str], ...], rule_id: str, phase: str, content: str) -> bool:
    try:
        result = evaluate_parameters(
            BuiltinContentFilter(), text=content, phase=phase, parameters=parameters,
        )
    except (ValueError, KeyError, TypeError):
        return False
    return any(
        finding.rule_id == rule_id and finding.verdict == "matched"
        for finding in result.findings
    )


def _evidence_reason(evidence: dict[str, Any]) -> list[str]:
    if evidence["status"] in {"observed", "not_required", "absent"}:
        return []
    superseding = ", ".join(f"{item['policyId']}/{item['ruleId']}" for item in _superseded_by(evidence))
    return [f"Rule evidence [{evidence['status']}]: {evidence.get('reason', 'No conclusive target evidence.')}"
            + (f" Other matching Rules: {superseding}." if superseding else "")]


def _superseded_by(evidence: dict[str, Any]) -> list[dict[str, str]]:
    return [
        {"policyId": _string(item.get("policyId")), "ruleId": _string(item.get("ruleId"))}
        for item in _list(evidence.get("supersededBy"))
    ]


def _merge_matches(findings: list[dict[str, Any]]) -> list[dict[str, str]]:
    seen: list[dict[str, str]] = []
    for item in findings:
        entry = {
            "policyId": _string(item.get("policy_id")),
            "ruleId": _string(item.get("rule_id")),
        }
        if entry["ruleId"] and entry not in seen:
            seen.append(entry)
    return seen


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
        role="model_output" if phase == "output" else _string(case.get("targetSource")) or "user_input",
        trust="untrusted", source="model_output" if phase == "output" else _string(case.get("targetSource")) or "user_input",
        qualifiers=("guard_content",),
    ))
    return content_view(tuple(blocks), blocks[-1].id)


def _metrics(results: list[dict[str, Any]]) -> dict[str, Any]:
    suite_total = len(results)
    results = [item for item in results if not item.get("skipped")]
    total = len(results)
    passed = sum(bool(item["passed"]) for item in results)
    # Fail-open/closed decisions on unavailable or indeterminate evaluations are
    # operational outcomes, not evidence of a classifier false positive/negative.
    evaluated = [item for item in results if not item.get("actualFailure") and not any(
        entry.get("verdict") == "unknown"
        for entry in [*item.get("findings", []), *item.get("trace", [])]
    )]
    false_positive = sum(item["expectedDecision"] == "allow" and item["actualDecision"] != "allow" for item in evaluated)
    false_negative = sum(item["expectedDecision"] != "allow" and item["actualDecision"] == "allow" for item in evaluated)
    escalated = sum(bool(item["escalated"]) for item in results)
    latencies = sorted(int(item["latencyMs"]) for item in results) or [0]
    return {
        "total": suite_total,
        "skipped": suite_total - total,
        "executed": total,
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
