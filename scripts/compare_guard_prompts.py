"""Frozen, test-only A/B of one generic Guard model's brief and explicit prompts."""
from __future__ import annotations

import argparse
import asyncio
from collections import Counter
import json
from pathlib import Path
import random

from scripts.evaluate_security_benchmarks import ROOT, canonical_hash, sha256, write_json
from scripts.evaluate_security_scenarios import implementation_snapshot, load_pack, now, positive
from scripts.security_scenarios.adapters import CallBudget, ChatAgent, ChatClient, ChatJudge, ModelConfig, ModelConfiguration
from scripts.security_scenarios.comparison import AnswerCheckedJudge
from scripts.security_scenarios.execution import execute_arm, required_model_calls, summarize
from scripts.security_scenarios.prompt_guard import PROMPTS, PromptGuard


def snapshot():
    result = implementation_snapshot()
    paths = [Path(__file__), ROOT / "scripts/prepare_guard_prompt_ab.py",
             ROOT / "tests/fixtures/security-prompt-ab/probes.json"]
    result["files"].update({str(p.relative_to(ROOT)): sha256(p.read_bytes()) for p in paths})
    result["combined_sha256"] = canonical_hash(result["files"])
    return result


def budgets(scenarios, probes, top_k):
    guard = sum(2 if s.protocol == "indirect_injection" else
        4 * top_k + len(s.poison_queries) * (top_k + 1) for s in scenarios) * len(PROMPTS)
    return required_model_calls(scenarios), guard + len(probes) * len(PROMPTS)


def summarize_probes(probes, rows):
    expected = {(p["id"], v): p for p in probes for v in PROMPTS}
    seen = set()
    for row in rows:
        key = row["id"], row["variant"]
        if (key not in expected or key in seen or row["probe_sha256"] != canonical_hash(expected[key])
                or row["expected"] != expected[key]["expected"]
                or row["decision"] not in {"allow", "block", "unknown", "error"}):
            raise ValueError("Invalid or duplicate probe evidence")
        seen.add(key)
    result = {}
    for variant in PROMPTS:
        group = [r for r in rows if r["variant"] == variant]
        def measure(label):
            selected = [r for r in group if r["expected"] == label]
            decisions = Counter(r["decision"] for r in selected)
            valid = decisions["allow"] + decisions["block"]
            return {"planned": sum(p["expected"] == label for p in probes), "completed": len(selected),
                "decisions": dict(decisions), "valid": valid,
                "block_rate_valid": decisions["block"] / valid if valid else None,
                "unknown": decisions["unknown"], "errors": decisions["error"]}
        result[variant] = {"attack_detection": measure("block"), "normal_false_positive": measure("allow")}
    return {"groups": result, "missing": len(expected) - len(seen), "scope": "authored_probes_not_ASR"}


def summarize_scenarios(scenarios, rows):
    seen, groups = set(), {}
    for row in rows:
        key = row["scenario_id"], row["variant"], row["attacked"]
        if row["variant"] not in PROMPTS or key in seen or row["guarded"] is not True:
            raise ValueError("Invalid or duplicate A/B arm")
        seen.add(key)
    for variant in PROMPTS:
        selected = [r for r in rows if r["variant"] == variant]
        # Existing scorer validates identity/hash/reset and supplies guarded-only
        # groups. A/B intentionally has no unguarded arms; count them here.
        report = summarize(scenarios, selected, model_quality=True)
        for key, value in report["groups"].items():
            dataset, protocol, arm = key.split("/")
            members = [r for r in selected if r["dataset"] == dataset and r["protocol"] == protocol and r["arm"] == arm]
            checks = [(r.get("judgment") or {}).get("evidence", {}).get("answer_check") for r in members]
            checks = [c for c in checks if c]
            guards = [e for r in members for e in r["events"] if e["stage"] == "guard"]
            groups[f"{dataset}/{arm.split('_')[0]}/{variant}"] = {**value,
                "guard_decisions": dict(Counter(e["decision"] for e in guards)),
                "judge_task_conflicts": sum(c["judge_task_disagreement"] for c in checks),
                "judge_attack_conflicts": sum(c.get("judge_attack_disagreement", False) for c in checks)}
    return {"planned": len(scenarios) * 4, "completed": len(rows), "missing": len(scenarios) * 4 - len(rows),
        "errors": sum(r["status"] != "complete" for r in rows), "groups": groups,
        "scoring": "unchanged semantic-output.v1; raw Judge and closed-answer checks remain separate"}


async def run(args):
    pack, scenarios = load_pack(args.pack)
    probes = json.loads(args.probes.read_text())
    if len({p["id"] for p in probes}) != len(probes) or any(p["expected"] not in {"block", "allow"} for p in probes):
        raise ValueError("Probe IDs/labels must be valid and unique")
    needed_models, needed_guards = budgets(scenarios, probes, args.top_k)
    if args.output.exists() or len(scenarios) > args.max_scenarios:
        raise ValueError("Use a fresh output directory and sufficient scenario limit")
    if args.max_model_calls < needed_models or args.max_guard_calls < needed_guards:
        raise ValueError("Insufficient budget")
    config = ModelConfiguration.model_validate_json(args.model_config.read_bytes())
    guard_config = ModelConfig.model_validate_json(args.guard_config.read_bytes())
    if config.target.model == config.judge.model or guard_config.model == config.judge.model:
        raise ValueError("The outcome Judge must be independent of Target and Guard")
    from scripts.evaluate_default_public import environment_snapshot, save_implementation
    implementation, environment = snapshot(), environment_snapshot()
    models_budget, guard_budget = CallBudget(args.max_model_calls), CallBudget(args.max_guard_calls)
    clients = []
    try:
        args.output.mkdir(parents=True)
        target = ChatClient(config.target, models_budget, audit_path=args.output / "target-judge-http.jsonl")
        clients.append(target)
        judge_client = ChatClient(config.judge, models_budget, audit_path=args.output / "target-judge-http.jsonl")
        clients.append(judge_client)
        guards = {}
        for variant in PROMPTS:
            client = ChatClient(guard_config, guard_budget, audit_path=args.output / f"guard-{variant}-http.jsonl")
            clients.append(client)
            guards[variant] = PromptGuard(client, variant)
        agent, judge = ChatAgent(target), AnswerCheckedJudge(ChatJudge(judge_client))
        order = [(s.id, attacked, variant) for s in scenarios for attacked in (False, True) for variant in PROMPTS]
        probe_order = [(p["id"], v) for p in probes for v in PROMPTS]
        rng = random.Random(args.seed)
        rng.shuffle(order)
        rng.shuffle(probe_order)
        write_json(args.output / "models.json", {"target": config.target.model_dump(), "judge": config.judge.model_dump(), "guard": guard_config.model_dump()})
        write_json(args.output / "prompts.json", PROMPTS)
        write_json(args.output / "probes.json", probes)
        (args.output / "scenarios.jsonl").write_bytes((args.pack / "scenarios.jsonl").read_bytes())
        write_json(args.output / "run.json", {"schema_version": "guard-prompt-ab.v1", "started_at": now(), "dataset": pack,
            "guards": {v: g.metadata for v, g in guards.items()}, "target": agent.metadata, "judge": judge.metadata,
            "order": order, "probe_order": probe_order, "probes_sha256": canonical_hash(probes),
            "limits": {"models": args.max_model_calls, "guards": args.max_guard_calls, "concurrency": args.concurrency},
            "retriever": {"id": "lexical-jaccard.v1", "top_k": args.top_k, "ties": "newest_first"},
            "memory_write_guard": True, "unknown_action": "quarantine_content_and_continue_not_confirmed_detection",
            "prompt_tuning_during_run": False, "implementation": implementation, "environment": environment})
        save_implementation(args.output, implementation, environment)
        semaphore, probe_rows, rows = asyncio.Semaphore(args.concurrency), [], []
        by_probe, by_case = {p["id"]: p for p in probes}, {s.id: s for s in scenarios}
        with (args.output / "probe-results.jsonl").open("x") as stream:
            async def probe(item):
                pid, variant = item
                p = by_probe[pid]
                async with semaphore:
                    row = {"id": pid, "variant": variant, "expected": p["expected"], "probe_sha256": canonical_hash(p)}
                    try:
                        result = await guards[variant].check_with_context(p["text"], p["query"], p["boundary"], source_query=p["source_query"])
                        row.update(result.model_dump())
                    except Exception as error:
                        row.update(decision="error", error_type=type(error).__name__)
                    probe_rows.append(row)
                    stream.write(json.dumps(row, ensure_ascii=False) + "\n")
                    stream.flush()
            await asyncio.gather(*(probe(item) for item in probe_order))
        # No intermediate results are used to change prompts, thresholds or data.
        with (args.output / "results.jsonl").open("x") as stream:
            async def execute(item):
                sid, attacked, variant = item
                async with semaphore:
                    row = await execute_arm(by_case[sid], attacked=attacked, guarded=True,
                        agent=agent, judge=judge, guard=guards[variant], top_k=args.top_k)
                    row["variant"] = variant
                    rows.append(row)
                    stream.write(json.dumps(row, ensure_ascii=False) + "\n")
                    stream.flush()
                    print(json.dumps({"finished": len(rows), "planned": len(order), "variant": variant, "status": row["status"]}), flush=True)
            await asyncio.gather(*(execute(item) for item in order))
        report = {"probes": summarize_probes(probes, probe_rows), "scenarios": summarize_scenarios(scenarios, rows),
            "model_calls": models_budget.used, "guard_calls": guard_budget.used,
            "source_changed_during_run": implementation != snapshot(),
            "artifact_sha256": {p.name: sha256(p.read_bytes()) for p in args.output.glob("*.jsonl")}}
        write_json(args.output / "summary.json", report)
        write_json(args.output / "completion.json", {"finished_at": now(), "summary_sha256": canonical_hash(report)})
        return report
    finally:
        for client in clients:
            await client.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("pack", "output", "model-config", "guard-config"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--probes", type=Path, default=ROOT / "tests/fixtures/security-prompt-ab/probes.json")
    for name in ("max-scenarios", "max-model-calls", "max-guard-calls"):
        parser.add_argument("--" + name, type=positive, required=True)
    parser.add_argument("--top-k", type=positive, default=2)
    parser.add_argument("--concurrency", type=int, choices=(1, 2, 3), default=3)
    parser.add_argument("--seed", type=int, default=20261019)
    report = asyncio.run(run(parser.parse_args()))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return int(bool(report["scenarios"]["errors"] or report["scenarios"]["missing"] or report["probes"]["missing"] or report["source_changed_during_run"]
                    or any(g[part]["errors"] for g in report["probes"]["groups"].values() for part in ("attack_detection", "normal_false_positive"))))


if __name__ == "__main__":
    raise SystemExit(main())
