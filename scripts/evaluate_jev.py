"""Verify real JEV input/output Content Safety without changing active bindings.

Runs the actual Runner capability-validation rails and frozen regression cases.
Expected labels stay local. Unknown, error and incorrect results fail the run;
no reviewer or threshold adjustment is used to turn them into a model pass.
"""
from __future__ import annotations

import argparse
import asyncio
from collections import Counter
from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import time

from google.protobuf.json_format import MessageToDict

from runner import generated as protocol
from runner.capability_validation import validate_capability
from runner.toolkit.nemo.evaluators.jev import JEV_PROFILE
from runner.toolkit.nemo.evaluators.jev_content_safety import JevContentSafetyEvaluator
from scripts.evaluate_laya import EvidenceTransport, evaluation_request

DEFAULT_SAMPLES = [Path("tests/fixtures/laya-regression.json"), Path("tests/fixtures/laya-output-regression.json")]


async def verify(args):
    key = args.key_file.read_text().strip() if args.key_file else os.environ.get(args.key_env, "").strip()
    if not key:
        raise ValueError("The JEV credential is not configured.")
    files = args.samples or DEFAULT_SAMPLES
    samples = [sample for path in files for sample in json.loads(path.read_text())
               if sample["capability"] == "content_safety"]
    if not samples:
        raise ValueError("No content safety samples found.")
    report = {"created_at": datetime.now(timezone.utc).isoformat(), "model": args.model,
        "base_url": args.base_url, "thresholds": {"lower": .1, "upper": .9}, "review_model": None,
        "sources": [{"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in files],
        "rail_validation": {}, "cases": [], "outcomes": {}, "passed": False}

    def save():
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2).replace(key, "[REDACTED]") + "\n")

    for phase, rail in (("input", protocol.RAIL_TYPE_INPUT), ("output", protocol.RAIL_TYPE_OUTPUT)):
        binding_id = f"content_safety.{phase}"
        request = protocol.CapabilityValidationRequest(request_id=f"jev-live-{phase}", binding_id=binding_id,
            credential_lease_id="local-validation", configuration=protocol.DataPlaneModelConfiguration(
                runtimes=[protocol.ModelRuntime(id="jev-live", model=args.model, profile_ref=JEV_PROFILE,
                    base_url=args.base_url, credential_ref="jev-live-provider", timeout_seconds=30,
                    lower_threshold=.1, upper_threshold=.9, max_concurrency=1, rate_limit_attempts=3)],
                bindings=[protocol.CapabilityBinding(binding_id=binding_id, capability_ref="content_safety",
                    rail_type=rail, model_ref="jev-live", profile_ref=JEV_PROFILE,
                    contract_refs=["tali.guard.content-safety.v1"])]))
        exchanges = []
        result = await validate_capability(request, {"jev-live-provider": key}, transport=EvidenceTransport(exchanges))
        report["rail_validation"][phase] = {"result": MessageToDict(result, preserving_proto_field_name=True),
            "passed": result.passed, "exchanges": exchanges}
        save()
        print(f"{binding_id}: {sum(case.passed for case in result.cases)}/{len(result.cases)} passed", flush=True)

    outcomes = Counter()
    for sample in samples:
        exchanges = []
        phase = sample.get("rail_type", "input")
        evaluator = JevContentSafetyEvaluator(base_url=args.base_url, model=args.model, api_key=key,
            timeout_seconds=30, rail_type=phase, transport=EvidenceTransport(exchanges))
        request = evaluation_request(sample, regression_id="jev-regression")
        started = time.monotonic()
        result = await evaluator.evaluate(request)
        outcome = ("correct" if result.verdict == sample["expected"] else
                   result.verdict if result.verdict in {"unknown", "error"} else "incorrect")
        outcomes[outcome] += 1
        report["cases"].append({"id": sample["id"], "phase": phase, "expected": sample["expected"],
            "verdict": result.verdict, "outcome": outcome, "duration_ms": round((time.monotonic() - started) * 1000),
            "trace": [asdict(step) for step in result.trace], "usage": asdict(result.usage), "exchanges": exchanges})
        report["outcomes"] = dict(outcomes)
        save()
        print(f"{phase}/{sample['id']}: {outcome} ({result.verdict})", flush=True)
    report["total"] = len(samples)
    # A pinned request is not proof of the actual served model; check every
    # successful native response, including the capability probes.
    exchanges = [exchange for row in [*report["rail_validation"].values(), *report["cases"]]
                 for exchange in row["exchanges"]]
    response_models = sorted({json.loads(item["response"]["body"]).get("model", "")
        for item in exchanges if item.get("response", {}).get("status") == 200})
    report["response_models"] = response_models
    report["passed"] = (outcomes["correct"] == len(samples)
        and all(row["passed"] for row in report["rail_validation"].values()) and response_models == [args.model])
    save()
    return 0 if report["passed"] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="https://api.typesafe.ai/v1")
    parser.add_argument("--model", default="jev-1.13.0")
    credentials = parser.add_mutually_exclusive_group()
    credentials.add_argument("--key-file", type=Path)
    credentials.add_argument("--key-env", default="MODEL_GUARDRAILS_JEV_API_KEY_ENV_VAR")
    parser.add_argument("--samples", type=Path, action="append")
    parser.add_argument("--output", type=Path, required=True)
    return asyncio.run(verify(parser.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
