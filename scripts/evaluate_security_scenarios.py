"""Prepare/run paired BIPIA and memory scenarios exclusively in test tooling.

python -m scripts.evaluate_security_scenarios --help
Public-source scenarios use an explicitly documented test-agent adaptation.
Contract mode is offline; real generation and judging need explicit model config.
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
from importlib.metadata import version
import json
from pathlib import Path

from scripts.evaluate_security_benchmarks import (
    ROOT, DEFAULT_SOURCES, canonical_hash, catalog, load_samples, select_files, sha256, verify_sources, write_json,
)
from scripts.security_scenarios.adapters import (
    CallBudget, ChatAgent, ChatClient, ChatJudge, ContractAgent, ContractJudge, LocalIndirectGuard, ModelConfiguration,
)
from scripts.security_scenarios.builders import ADAPTER_VERSION, bipia_scenarios, contract_scenarios, memory_scenarios
from scripts.security_scenarios.execution import ARMS, execute_arm, required_model_calls, summarize
from scripts.security_scenarios.models import Scenario


SOURCE_LOCK = Path(__file__).with_name("security_scenarios") / "sources.lock.json"
SCENARIO_SOURCES = ROOT / "output/evaluation-catalog/scenario-sources"


def now():
    return datetime.now(timezone.utc).isoformat()


def prepare_scenarios(args) -> dict:
    if args.output.exists():
        raise ValueError("Output already exists; use a fresh directory")
    receipts = []
    if args.suite == "contract":
        scenarios = contract_scenarios()
    else:
        base = select_files(catalog(), ["prompt_injection", "memory_poisoning"])
        verify_sources(args.sources, base, download=args.download)
        specs = json.loads(SOURCE_LOCK.read_text())["files"]
        verify_sources(args.scenario_sources, specs, download=args.download)
        receipts = base + specs
        samples = load_samples(args.sources, base)
        scenarios = list(bipia_scenarios(samples, split=args.split, contexts_per_task=args.contexts_per_task,
            payloads_per_task=args.payloads_per_task, positions=tuple(args.positions), seed=args.seed))
        scenarios += list(memory_scenarios(args.scenario_sources, specs, cases_per_source=args.memory_cases_per_source))
    if not scenarios or len({s.id for s in scenarios}) != len(scenarios):
        raise ValueError("Scenarios must have unique nonempty IDs")
    args.output.mkdir(parents=True)
    raw = "".join(s.model_dump_json() + "\n" for s in scenarios).encode()
    (args.output / "scenarios.jsonl").write_bytes(raw)
    manifest = {"schema_version": "scenario-pack.v1", "created_at": now(), "adapter": ADAPTER_VERSION,
        "suite": args.suite, "selection": {"scope": "contract" if args.suite == "contract" else "capped_public_source_adaptation",
            "bipia_split": args.split, "contexts_per_task": args.contexts_per_task,
            "payloads_per_task": args.payloads_per_task, "positions": args.positions, "seed": args.seed,
            "memory_cases_per_source": args.memory_cases_per_source}, "sources": receipts,
        "scenarios_sha256": sha256(raw), "count": len(scenarios), "arms": 4 * len(scenarios),
        "max_model_calls_upper_bound": required_model_calls(scenarios),
        "source_lock_sha256": sha256(SOURCE_LOCK.read_bytes()),
        "preparation_code_sha256": {str(p.relative_to(ROOT)): sha256(p.read_bytes())
            for p in (Path(__file__), ROOT / "scripts/security_scenarios/builders.py", ROOT / "scripts/security_scenarios/models.py",
                      ROOT / "scripts/evaluate_security_benchmarks.py")},
        "tokenizer": {"name": "nltk.PunktSentenceTokenizer", "version": version("nltk"), "trained_parameters": False}}
    write_json(args.output / "manifest.json", manifest)
    return manifest


def load_pack(directory: Path):
    manifest = json.loads((directory / "manifest.json").read_text())
    raw = (directory / "scenarios.jsonl").read_bytes()
    if manifest["schema_version"] != "scenario-pack.v1" or sha256(raw) != manifest["scenarios_sha256"]:
        raise ValueError("Scenario pack hash/schema mismatch")
    scenarios = [Scenario.model_validate_json(line) for line in raw.splitlines() if line.strip()]
    if not scenarios or len(scenarios) != manifest["count"] or len({s.id for s in scenarios}) != len(scenarios):
        raise ValueError("Scenario count/identity mismatch")
    return manifest, scenarios


def implementation_snapshot():
    from scripts.evaluate_default_public import source_code_fingerprint
    snapshot = source_code_fingerprint()
    paths = [p for p in (ROOT / "scripts/security_scenarios").iterdir() if p.is_file()] + [Path(__file__),
        ROOT / "scripts/evaluate_security_benchmarks.py", ROOT / "scripts/security_benchmarks.lock.json"]
    snapshot["files"].update({str(p.relative_to(ROOT)): sha256(p.read_bytes()) for p in paths})
    snapshot["combined_sha256"] = canonical_hash(snapshot["files"])
    return snapshot


async def run_scenarios(args) -> dict:
    # All schema, identity and budget checks precede model creation or any RPC.
    pack, scenarios = load_pack(args.pack)
    if args.output.exists():
        raise ValueError("Output already exists; use a fresh directory")
    if not 0 < len(scenarios) <= args.max_scenarios:
        raise ValueError("Scenario count exceeds --max-scenarios")
    if args.mode == "models" and (not args.model_config or not args.max_model_calls
                                  or required_model_calls(scenarios) > args.max_model_calls):
        raise ValueError("Model mode needs a config and sufficient --max-model-calls for all planned arms")
    if args.mode == "contract" and (args.model_config or args.max_model_calls):
        raise ValueError("Contract mode does not accept model credentials or call budgets")
    from scripts.evaluate_default_public import environment_snapshot, save_implementation
    implementation, environment = implementation_snapshot(), environment_snapshot()
    environment["packages"].update({name: version(name) for name in ("nltk", "joblib", "regex", "cloudpickle", "click", "tqdm")})
    clients, budget = [], None
    try:
        if args.mode == "models":
            config = ModelConfiguration.model_validate_json(args.model_config.read_bytes())
            budget = CallBudget(args.max_model_calls)
            for model_config in (config.target, config.judge):
                clients.append(ChatClient(model_config, budget, audit_path=args.output / "http.jsonl"))
            agent, judge = ChatAgent(clients[0]), ChatJudge(clients[1])
        else:
            agent, judge = ContractAgent(), ContractJudge()
        guard = LocalIndirectGuard()
        args.output.mkdir(parents=True)
        if args.mode == "models":
            write_json(args.output / "models.json", config.model_dump())
        (args.output / "scenarios.jsonl").write_bytes((args.pack / "scenarios.jsonl").read_bytes())
        manifest = {"schema_version": "scenario-run.v1", "status": "running", "started_at": now(),
            "dataset": pack, "target": agent.metadata, "judge": judge.metadata, "guard": guard.metadata,
            "retriever": {"id": "lexical-jaccard.v1", "top_k": args.top_k, "ties": "newest_first"},
            "memory_write_guard": args.guard_writes, "memory_scope": "new_instance_per_scenario_arm",
            "limits": {"max_scenarios": args.max_scenarios, "max_model_calls": args.max_model_calls},
            "selected": [{"id": s.id, "sha256": canonical_hash(s.model_dump())} for s in scenarios],
            "implementation": implementation, "environment": environment}
        write_json(args.output / "run.json", manifest)
        save_implementation(args.output, implementation, environment)
        rows = []
        with (args.output / "results.jsonl").open("x", encoding="utf-8") as stream:
            for scenario in scenarios:
                for attacked, guarded in ARMS:
                    row = await execute_arm(scenario, attacked=attacked, guarded=guarded, agent=agent, judge=judge,
                                            guard=guard, top_k=args.top_k, guard_writes=args.guard_writes)
                    stream.write(json.dumps(row, ensure_ascii=False, allow_nan=False) + "\n")
                    stream.flush()
                    rows.append(row)
        report = summarize(scenarios, rows, model_quality=args.mode == "models")
        report["external_model_calls"] = budget.used if budget else 0
        report["source_changed_during_run"] = implementation != implementation_snapshot()
        report["results_sha256"] = sha256((args.output / "results.jsonl").read_bytes())
        if args.mode == "models":
            report["http_sha256"] = sha256((args.output / "http.jsonl").read_bytes())
        report["execution_errors"] = sum(r["status"] == "execution_error" for r in rows)
        write_json(args.output / "summary.json", report)
        write_json(args.output / "completion.json", {"status": "complete", "finished_at": now(),
            "execution_errors": report["execution_errors"], "summary_sha256": canonical_hash(report)})
        return report
    finally:
        for client in clients:
            await client.close()


def positive(text):
    value = int(text)
    if value < 1:
        raise argparse.ArgumentTypeError("Must be positive")
    return value


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("prepare")
    prepare.add_argument("--suite", choices=("contract", "public"), required=True)
    prepare.add_argument("--sources", type=Path, default=DEFAULT_SOURCES)
    prepare.add_argument("--scenario-sources", type=Path, default=SCENARIO_SOURCES)
    prepare.add_argument("--download", action="store_true")
    prepare.add_argument("--split", choices=("test", "train"), default="test")
    prepare.add_argument("--contexts-per-task", type=positive, default=1)
    prepare.add_argument("--payloads-per-task", type=positive, default=1)
    prepare.add_argument("--positions", nargs="+", choices=("start", "middle", "end"), default=["start", "middle", "end"])
    prepare.add_argument("--seed", type=int, default=2023)
    prepare.add_argument("--memory-cases-per-source", type=positive, default=2)
    prepare.add_argument("--output", type=Path, required=True)
    run = commands.add_parser("run")
    run.add_argument("--pack", type=Path, required=True)
    run.add_argument("--output", type=Path, required=True)
    run.add_argument("--mode", choices=("contract", "models"), required=True)
    run.add_argument("--max-scenarios", type=positive, required=True)
    run.add_argument("--top-k", type=positive, default=2)
    run.add_argument("--guard-writes", action=argparse.BooleanOptionalAction, default=True)
    run.add_argument("--model-config", type=Path)
    run.add_argument("--max-model-calls", type=positive)
    args = parser.parse_args(argv)
    report = prepare_scenarios(args) if args.command == "prepare" else asyncio.run(run_scenarios(args))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return int(bool(report.get("execution_errors") or report.get("source_changed_during_run") or report.get("missing_arms")))


if __name__ == "__main__":
    raise SystemExit(main())
