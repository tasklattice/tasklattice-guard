"""Replay Laya regression cases with optional independent gray-area review.

Only content, policy and context enter inference. Expected labels stay in the
local report. Exit nonzero for any wrong, uncertain or failed final result.
"""
from __future__ import annotations

import argparse
import asyncio
from collections import Counter
from dataclasses import asdict
import json
import os
from pathlib import Path
import time

import httpx

from runner.toolkit.nemo.evaluators.classifier_review import ClassifierReviewer
from runner.toolkit.nemo.evaluators.contracts import EvaluationRequest
from runner.toolkit.nemo.evaluators.laya_content_safety import LayaContentSafetyEvaluator
from runner.toolkit.nemo.evaluators.laya_jailbreak import LayaJailbreakEvaluator
from runner.toolkit.nemo.evaluators.laya_topic import LayaTopicEvaluator
from runner.toolkit.runtime.contracts import GuardrailPlanSnapshot, NeMoActionBinding

EVALUATORS = {
    "content_safety": (LayaContentSafetyEvaluator, "tali.guard.content-safety.v1"),
    "jailbreak": (LayaJailbreakEvaluator, "tali.guard.jailbreak.v1"),
    "topic_control": (LayaTopicEvaluator, "tali.guard.topic-control.semantic.v1"),
}


class EvidenceTransport(httpx.AsyncBaseTransport):
    def __init__(self, exchanges):
        self.inner = httpx.AsyncHTTPTransport()
        self.exchanges = exchanges

    async def handle_async_request(self, request):
        # Header names are useful evidence; credential values are not.
        headers = {k: "[REDACTED]" if any(s in k.lower() for s in ("authorization", "cookie", "api-key")) else v
                   for k, v in request.headers.items()}
        row = {"request": {"url": str(request.url), "headers": headers, "body": json.loads(request.content)}}
        self.exchanges.append(row)
        try:
            response = await self.inner.handle_async_request(request)
            await response.aread()
            row["response"] = {"status": response.status_code,
                "headers": {k: "[REDACTED]" if "cookie" in k.lower() else v for k, v in response.headers.items()},
                "body": response.text}
            return response
        except Exception as error:
            row["error"] = type(error).__name__
            raise

    async def aclose(self):
        await self.inner.aclose()


def evaluation_request(sample, *, review=False, timeout=75, regression_id="laya-regression"):
    capability = sample["capability"]
    _, contract = EVALUATORS[capability]
    plan = GuardrailPlanSnapshot(guardrail_id=regression_id, guardrail_version="offline",
        compiler_version="offline-v1", safety_level="balanced", output_delivery="full_buffered", steps=())
    rail = sample.get("rail_type", "input")
    return EvaluationRequest(content=sample["content"], rail_type=rail, guardrail_id=plan.guardrail_id,
        guardrail_version=plan.guardrail_version, policy_id=None, policy_version=None, trusted_context=(),
        content_blocks=(), deadline=time.monotonic() + timeout,
        parameters=tuple(sample.get("parameters", {}).items()) + (("review_unknown", str(review).lower()),),
        capability=capability, proposed_action="block", plan=plan,
        binding=NeMoActionBinding(id=f"{regression_id}-check", capability=capability, contract_ref=contract,
            phases=(rail,), on_unsafe="block"),
        context_messages=tuple(sample.get("context_messages", [])), mode="detect",
        evidence_scope="full", execution_purpose="validation")


async def replay(args):
    samples = json.loads(args.samples.read_text())
    key = args.key_file.read_text().strip()
    rows, outcomes = [], Counter()
    for sample in samples:
        exchanges = []
        reviewer = ClassifierReviewer(base_url=args.review_base_url, model=args.review_model,
            api_key=os.environ[args.review_key_env], provider_id="regression-review", timeout_seconds=45,
            max_tokens=512, transport=EvidenceTransport(exchanges), rail_type=sample.get("rail_type", "input")) if args.review_model else None
        factory, _ = EVALUATORS[sample["capability"]]
        evaluator = factory(base_url=args.base_url, model=args.model, api_key=key, timeout_seconds=20,
            reviewer=reviewer, transport=EvidenceTransport(exchanges), rail_type=sample.get("rail_type", "input"))
        request = evaluation_request(sample, review=reviewer is not None)
        started = time.monotonic()
        result = await evaluator.evaluate(request)
        outcome = "correct" if result.verdict == sample["expected"] else result.verdict if result.verdict in {"unknown", "error"} else "incorrect"
        outcomes[outcome] += 1
        row = {"id": sample["id"], "capability": sample["capability"], "expected": sample["expected"],
            "verdict": result.verdict, "outcome": outcome, "duration_ms": round((time.monotonic() - started) * 1000),
            "reviewed": any(step.evaluator_id == "classifier-review" for step in result.trace),
            "trace": [asdict(step) for step in result.trace], "usage": asdict(result.usage), "exchanges": exchanges}
        rows.append(row)
        report = {"thresholds": {"lower": .1, "upper": .9}, "review_model": args.review_model,
            "total": len(rows), "outcomes": dict(outcomes), "cases": rows}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        encoded = json.dumps(report, ensure_ascii=False, indent=2)
        for secret in (key, os.environ.get(args.review_key_env, "") if args.review_key_env else ""):
            if secret:
                encoded = encoded.replace(secret, "[REDACTED]")
        args.output.write_text(encoded + "\n")
        print(f"{sample['id']}: {outcome} ({result.verdict}, review={row['reviewed']})", flush=True)
    return 0 if outcomes["correct"] == len(samples) else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=Path, default=Path("tests/fixtures/laya-regression.json"))
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--model", default="auto")
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--review-model")
    parser.add_argument("--review-base-url")
    parser.add_argument("--review-key-env")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if any((args.review_model, args.review_base_url, args.review_key_env)) and not all((args.review_model, args.review_base_url, args.review_key_env)):
        parser.error("Review requires --review-model, --review-base-url and --review-key-env together.")
    return asyncio.run(replay(args))


if __name__ == "__main__":
    raise SystemExit(main())
