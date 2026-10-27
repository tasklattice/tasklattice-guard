#!/usr/bin/env python3
"""Measure what the compiled schedule actually saves.

The scheduler reorders compiler-owned checks (Block first, then serial Transform,
then Allow) and suppresses no work that changes an outcome. This script reports
the two things that decide whether that is worth it, without any network access:

* **checks executed before the decision** - deterministic, and the only metric
  that matters for model cost and for latency when the checks are remote;
* **wall clock** for local-only detectors - dominated by NeMo dispatch overhead,
  so read it as "the reordering adds nothing", not as a latency claim.

A plan is compiled by the real Controller, then executed by the real Runner.
Custom Colang and windowed streaming are out of scope: they keep their authored
order and their own short-circuiting.

Usage:
  .venv/bin/python scripts/benchmark_scheduling.py
  .venv/bin/python scripts/benchmark_scheduling.py --iterations 100 --json
"""
from __future__ import annotations

import argparse
import asyncio
import json
from copy import deepcopy
from pathlib import Path
import statistics
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

PLAN_BUILDER = """
  import { DeclarativeCompiler } from '../controller/server/policy-studio/declarative.ts';
  import { buildGuardrailPlan } from '../controller/server/domain/guardrail-plan.ts';
  const compiler = new DeclarativeCompiler('../runner/toolkit/policy_library/assets');
  const template = compiler.shipped('keyword-blocking');
  const rule = (id, action, replacement) => ({
    ...structuredClone(template.rules[0]), id, name: id, stages: ['input', 'output'],
    detector: { ref: 'text/keyword', version: '1.0.0', parameters: { keywords: [['alpha', 'low']] } },
    on_match: { action, ...(replacement ? { replacement } : {}) }, runtime_adapter: undefined,
  });
  const policyWith = (id, rules) => {
    const definition = structuredClone(template);
    definition.metadata.id = id; definition.metadata.version = '1.0.0';
    definition.parameters = []; delete definition.testing; definition.tests = [];
    definition.rules = rules;
    return compiler.compile(definition);
  };
  const plan = (policies) => buildGuardrailPlan({
    guardrailId: 'benchmark', guardrailVersion: '20261023-000000.001Z', policies,
    draft: { allowedTopics: [], restrictedTopics: [], safetyLevel: 'balanced', outputDelivery: 'full_buffered',
      policyBindings: policies.map(p => ({ policyId: p.id, policyVersion: p.version, parameterValues: {},
        enabledRuleIds: p.rules.map(item => item.id), ruleOrder: p.rules.map(item => item.id),
        ruleActions: {}, enabledRails: ['input', 'output'], reasoningPolicy: null })) } });
  console.log(JSON.stringify({
    // Worst case for a Transform-first order: the Block Rule matches the very
    // token the Transform would have consumed.
    mixed: plan([policyWith('mix', [rule('r-mask', 'transform', '[MASK]'), rule('r-block', 'block'),
                                   rule('r-observe', 'allow')])]),
    // Only read-only checks: the block-first order changes nothing here.
    blocks: plan([policyWith('blocks', [rule('r-block-1', 'block'), rule('r-block-2', 'block'),
                                       rule('r-block-3', 'block')])]),
    benign: plan([policyWith('mix-benign', [rule('r-mask', 'transform', '[MASK]'), rule('r-block', 'block'),
                                           rule('r-observe', 'allow')])]),
  }));
"""


def controller_plans() -> dict[str, dict]:
    result = subprocess.run(
        ["node", "--import", "tsx", "--input-type=module", "-e", PLAN_BUILDER],
        cwd=ROOT / "controller", capture_output=True, text=True, check=True, timeout=60,
    )
    return json.loads(result.stdout)


def authored_schedule(plan: dict) -> dict:
    """The same plan executed in its declared precedence instead of the schedule."""
    reordered = deepcopy(plan)
    order = [step["id"] for step in sorted(
        plan["steps"], key=lambda item: int(dict(item["parameters"])["precedence"]))]
    reordered["steps"].sort(key=lambda step: order.index(step["id"]))
    for step in reordered["steps"]:
        step["parameters"] = [[key, value] for key, value in step["parameters"]
                              if not key.startswith(("parallel_group_", "parallel_leader_"))]
    by_phase: dict[str, list[dict]] = {}
    for module in reordered["modules"]:
        by_phase.setdefault(module["phase"], []).append(module)
    for modules in by_phase.values():
        modules.sort(key=lambda module: min(order.index(step_id) for step_id in module["step_ids"]))
        previous = None
        for module in modules:
            module["depends_on"] = [previous] if previous else []
            previous = module["id"]
    reordered["modules"] = [module for modules in by_phase.values() for module in modules]
    return reordered


SCENARIOS = (
    ("mixed/blocked", "mixed", "alpha beta"),
    ("mixed/allow", "benign", "ordinary request"),
    ("blocks/blocked", "blocks", "alpha beta"),
)


async def measure(plan: dict, text: str, scope: str, iterations: int) -> dict:
    from runner.compiler import DefaultRunnerCompiler
    from runner.draft_preview import DraftPreviewRuntime
    from runner.toolkit.nemo.action_registry import action_providers
    from runner.toolkit.nemo.actions import local_action_providers
    from runner.toolkit.runtime.contracts import ProtectionRequest, RequestContext

    runtime = DraftPreviewRuntime(DefaultRunnerCompiler(), action_providers(*local_action_providers()))
    timings: list[float] = []
    decision = None
    try:
        for index in range(iterations):
            started = __import__("time").perf_counter()
            decision = await runtime.evaluate(
                ProtectionRequest(phase="input", texts=(text,), evidence_scope=scope,
                                  context=RequestContext(protocol="benchmark")),
                preview_id=f"bench-{scope}-{iteration_key(index)}", guardrail_id="benchmark",
                draft_revision=1, candidate_version=plan["guardrail_version"],
                plan=plan, runtime_profile="auto")
            timings.append((__import__("time").perf_counter() - started) * 1_000)
    finally:
        await runtime.shutdown()
    assert decision is not None
    actions = [step for step in decision.trace if step.kind == "action"]
    return {
        "decision": decision.decision,
        "actions": len(actions),
        "action_ids": [step.name or step.id for step in actions],
        "matched": sorted({finding.rule_id for finding in decision.findings
                           if finding.verdict == "matched" and finding.rule_id}),
        "p50": round(statistics.median(timings), 1),
        "p95": round(sorted(timings)[max(0, int(len(timings) * 0.95) - 1)], 1),
    }


def iteration_key(index: int) -> int:
    return index


async def run(iterations: int, assumed_remote_ms: float, as_json: bool) -> dict:
    plans = controller_plans()
    rows = []
    for label, plan_key, text in SCENARIOS:
        for schedule_name, plan in (("block-first", plans[plan_key]),
                                    ("authored", authored_schedule(plans[plan_key]))):
            for scope in ("interventions", "full"):
                result = await measure(plan, text, scope, iterations)
                rows.append({"scenario": label, "schedule": schedule_name, "scope": scope, **result})

    payload = {"iterations": iterations, "assumedRemoteMs": assumed_remote_ms, "rows": rows,
               # checks avoided by the optimisation, not by the scope
               "saved": {}}
    for row in rows:
        if row["scope"] != "interventions" or row["schedule"] != "block-first":
            continue
        peer = next(item for item in rows if item["scenario"] == row["scenario"]
                    and item["scope"] == "interventions" and item["schedule"] == "authored")
        payload["saved"][row["scenario"]] = max(0, peer["actions"] - row["actions"])

    if as_json:
        print(json.dumps(payload, indent=2))
        return payload

    print(f"\nSchedule benchmark: {iterations} iterations per cell, local detectors only\n")
    print("| scenario | schedule | scope | decision | checks executed | p50 ms | p95 ms |")
    print("| --- | --- | --- | --- | --- | --- | --- |")
    for row in rows:
        print(f"| {row['scenario']} | {row['schedule']} | {row['scope']} | {row['decision']} | "
              f"{row['actions']} | {row['p50']} | {row['p95']} |")
    print("\nChecks avoided by Block-first (fast path, same decision):")
    for scenario, saved in payload["saved"].items():
        if saved:
            print(f"- {scenario}: {saved} fewer check(s) before the decision "
                  f"(≈{saved * assumed_remote_ms:.0f} ms per blocked request at {assumed_remote_ms:.0f} ms/remote check)")
        else:
            print(f"- {scenario}: no change (all checks are read-only, nothing to reorder)")
    print("\nWall clock covers local detectors and NeMo dispatch only; it is not a model latency claim.")
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--iterations", type=int, default=50, help="evaluations per cell (default 50)")
    parser.add_argument("--assumed-remote-ms", type=float, default=200.0,
                        help="latency assumption used to translate saved checks into time (default 200)")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    arguments = parser.parse_args()
    if arguments.iterations < 1:
        parser.error("--iterations must be positive")
    asyncio.run(run(arguments.iterations, arguments.assumed_remote_ms, arguments.json))


if __name__ == "__main__":
    main()
