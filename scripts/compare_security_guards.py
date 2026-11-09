"""Compare none/rules/Jev in isolated tests, without changing product configuration."""
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import random

from scripts.evaluate_security_scenarios import implementation_snapshot, load_pack, now, positive
from scripts.evaluate_security_benchmarks import ROOT, canonical_hash, sha256, write_json
from scripts.security_scenarios.adapters import CallBudget, ChatAgent, ChatClient, ChatJudge, LocalIndirectGuard, ModelConfiguration
from scripts.security_scenarios.comparison import AnswerCheckedJudge, VARIANTS, call_limits, summarize_comparison
from scripts.security_scenarios.execution import execute_arm
from scripts.security_scenarios.jev import JevConfig, JevGuard


def snapshot():
    result = implementation_snapshot()
    result["files"][str(Path(__file__).relative_to(ROOT))] = sha256(Path(__file__).read_bytes())
    result["combined_sha256"] = canonical_hash(result["files"])
    return result


async def run(args):
    pack, scenarios = load_pack(args.pack)
    needed_models, needed_jev = call_limits(scenarios, args.top_k)
    if args.output.exists() or len(scenarios) > args.max_scenarios:
        raise ValueError("Use a fresh output directory and sufficient scenario limit")
    if args.max_model_calls < needed_models or args.max_jev_calls < needed_jev:
        raise ValueError("Insufficient budget for all planned arms")
    config = ModelConfiguration.model_validate_json(args.model_config.read_bytes())
    jev_config = JevConfig.model_validate_json(args.jev_config.read_bytes())
    if config.target.model == config.judge.model:
        raise ValueError("Independent target and Judge models required")
    from scripts.evaluate_default_public import environment_snapshot, save_implementation
    implementation, environment = snapshot(), environment_snapshot()
    model_budget, jev_budget = CallBudget(args.max_model_calls), CallBudget(args.max_jev_calls)
    clients = []
    try:
        target = ChatClient(config.target, model_budget, audit_path=args.output / "model-http.jsonl")
        clients.append(target)
        judge_client = ChatClient(config.judge, model_budget, audit_path=args.output / "model-http.jsonl")
        clients.append(judge_client)
        jev = JevGuard(jev_config, jev_budget, audit_path=args.output / "jev-http.jsonl")
        clients.append(jev)
        agent, judge, rules = ChatAgent(target), AnswerCheckedJudge(ChatJudge(judge_client)), LocalIndirectGuard()
        order = [(s.id, attacked, variant) for s in scenarios for attacked in (False, True) for variant in VARIANTS]
        random.Random(args.seed).shuffle(order)
        args.output.mkdir(parents=True)
        (args.output / "scenarios.jsonl").write_bytes((args.pack / "scenarios.jsonl").read_bytes())
        write_json(args.output / "models.json", config.model_dump())
        write_json(args.output / "jev.json", jev_config.model_dump())
        write_json(args.output / "run.json", {"schema_version": "guard-comparison-run.v1", "started_at": now(),
            "dataset": pack, "target": agent.metadata, "judge": judge.metadata,
            "guards": {"none": {"kind": "bypass"}, "rules": rules.metadata, "jev": jev.metadata},
            "retriever": {"id": "lexical-jaccard.v1", "top_k": args.top_k, "ties": "newest_first"},
            "memory_write_guard": True, "memory_scope": "new_instance_per_scenario_arm", "order": order,
            "limits": {"models": args.max_model_calls, "jev": args.max_jev_calls, "concurrency": args.concurrency},
            "implementation": implementation, "environment": environment})
        save_implementation(args.output, implementation, environment)
        by_id = {s.id: s for s in scenarios}
        semaphore, rows = asyncio.Semaphore(args.concurrency), []
        with (args.output / "results.jsonl").open("x", encoding="utf-8") as stream:
            async def execute(item):
                sid, attacked, variant = item
                async with semaphore:
                    row = await execute_arm(by_id[sid], attacked=attacked, guarded=variant != "none", agent=agent,
                                            judge=judge, guard=jev if variant == "jev" else rules, top_k=args.top_k)
                    row["variant"] = variant
                    stream.write(json.dumps(row, ensure_ascii=False, allow_nan=False) + "\n")
                    stream.flush()
                    rows.append(row)
                    print(json.dumps({"finished": len(rows), "planned": len(order), "scenario": sid,
                                      "variant": variant, "attacked": attacked, "status": row["status"]}), flush=True)
            await asyncio.gather(*(execute(item) for item in order))
        report = summarize_comparison(scenarios, rows)
        report.update(model_calls=model_budget.used, jev_calls=jev_budget.used,
                      source_changed_during_run=implementation != snapshot(),
                      artifact_sha256={p.name: sha256(p.read_bytes()) for p in args.output.glob("*.jsonl")})
        write_json(args.output / "summary.json", report)
        write_json(args.output / "completion.json", {"finished_at": now(), "status": "complete",
                                                   "summary_sha256": canonical_hash(report)})
        return report
    finally:
        for client in clients:
            await client.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("pack", "output", "model-config", "jev-config"):
        parser.add_argument("--" + name, type=Path, required=True)
    for name in ("max-scenarios", "max-model-calls", "max-jev-calls"):
        parser.add_argument("--" + name, type=positive, required=True)
    parser.add_argument("--top-k", type=positive, default=2)
    parser.add_argument("--concurrency", type=int, choices=(1, 2, 3), default=3)
    parser.add_argument("--seed", type=int, default=20261019)
    args = parser.parse_args(argv)
    report = asyncio.run(run(args))
    print(json.dumps({k: v for k, v in report.items() if k not in {"groups", "paired_utility"}}, indent=2))
    return int(bool(report["execution_errors"] or report["missing_arms"] or report["source_changed_during_run"]))


if __name__ == "__main__":
    raise SystemExit(main())
