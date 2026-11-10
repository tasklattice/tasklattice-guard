"""Replay annotated Topic Control inputs without changing Controller assignments.

Run from the repository root: python -m scripts.evaluate_topic_control --help
Only policy, context and content are submitted; labels never enter model state.
"""
from __future__ import annotations

import argparse
import asyncio
from collections import Counter
from dataclasses import asdict
import hashlib
import json
import math
import os
from pathlib import Path
import time
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from runner.toolkit.nemo.actions.topic import ChatTopicEvaluator
from runner.toolkit.nemo.evaluators.contracts import EvaluationRequest, GuardEvaluator
from runner.toolkit.nemo.evaluators.jev import DEFAULT_LOWER_THRESHOLD, DEFAULT_UPPER_THRESHOLD
from runner.toolkit.nemo.evaluators.jev_topic import JevTopicEvaluator
from runner.toolkit.runtime.contracts import GuardrailPlanSnapshot, NeMoActionBinding


class Policy(BaseModel):
    topic_mode: Literal["strict", "permissive"]
    allowed_topics: list[str]
    restricted_topics: list[str]


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1)


class Annotation(BaseModel):
    review_status: Literal["approved", "proposed", "needs_review"]


class Metadata(BaseModel):
    rule_scope: Literal["combined", "allowlist", "denylist"]


class Sample(BaseModel):
    model_config = ConfigDict(strict=True)
    schema_version: Literal["topic-control-sft.v1"]
    id: str = Field(min_length=1)
    scope: Literal["input", "output"]
    policy: Policy
    context_messages: list[Message] = Field(max_length=12)
    content: str = Field(min_length=1)
    label: Literal["on-topic", "off-topic"] | None
    annotation: Annotation
    metadata: Metadata

    @model_validator(mode="after")
    def boundaries(self):
        policy = self.policy
        if any(not value.strip() for value in policy.allowed_topics + policy.restricted_topics):
            raise ValueError("Topic entries must be nonempty.")
        if policy.topic_mode == "strict" and not policy.allowed_topics:
            raise ValueError("Strict samples require allowed topics.")
        if self.metadata.rule_scope == "denylist" and (policy.topic_mode != "permissive" or policy.allowed_topics):
            raise ValueError("Denylist samples must isolate denied topics in permissive mode.")
        if self.metadata.rule_scope == "allowlist" and (policy.topic_mode != "strict" or policy.restricted_topics):
            raise ValueError("Allowlist samples must isolate allowed topics in strict mode.")
        if (self.annotation.review_status == "needs_review") != (self.label is None):
            raise ValueError("Only needs_review samples may have a null label.")
        return self


def load_samples(path: Path, *, include_proposed: bool = False) -> tuple[list[Sample], dict[str, int]]:
    selected, seen, skipped = [], set(), Counter()
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        sample = Sample.model_validate_json(line)
        if sample.id in seen:
            raise ValueError(f"Duplicate sample ID: {sample.id}")
        seen.add(sample.id)
        if sample.scope != "input":
            skipped["output"] += 1
        elif sample.label is None or sample.annotation.review_status == "needs_review":
            skipped["needs_review"] += 1
        elif sample.annotation.review_status != "approved" and not include_proposed:
            skipped["not_approved"] += 1
        else:
            selected.append(sample)
    return selected, dict(skipped)


def evaluation_request(sample: Sample, timeout_seconds: float) -> EvaluationRequest:
    plan = GuardrailPlanSnapshot(guardrail_id="offline-topic-evaluation", guardrail_version="offline",
                                 compiler_version="offline-v1", safety_level="balanced", output_delivery="full_buffered", steps=())
    return EvaluationRequest(
        content=sample.content, rail_type="input", guardrail_id=plan.guardrail_id, guardrail_version=plan.guardrail_version,
        policy_id=None, policy_version=None, trusted_context=(), content_blocks=(),
        deadline=time.monotonic() + timeout_seconds,
        parameters=(("topic_mode", sample.policy.topic_mode), ("allowed_topics", "\n".join(sample.policy.allowed_topics)),
                    ("restricted_topics", "\n".join(sample.policy.restricted_topics))),
        capability="topic_control", proposed_action="block", plan=plan,
        binding=NeMoActionBinding(id=sample.id, capability="topic_control", contract_ref="tali.guard.topic-control.semantic.v1",
                                 phases=("input",), on_unsafe="block"),
        context_messages=tuple(message.model_dump() for message in sample.context_messages), mode="detect", evidence_scope="full", execution_purpose="validation",
    )


async def replay(samples: list[Sample], evaluator: GuardEvaluator, timeout_seconds: float) -> dict:
    rows, outcomes = [], Counter()
    for sample in samples:
        started = time.perf_counter()
        result = await evaluator.evaluate(evaluation_request(sample, timeout_seconds))
        expected = "matched" if sample.label == "off-topic" else "not_matched"
        outcome = result.verdict if result.verdict in {"unknown", "error"} else (
            "correct" if result.verdict == expected else "false_positive" if result.verdict == "matched" else "false_negative")
        outcomes[outcome] += 1
        rows.append({"id": sample.id, "expected": expected, "verdict": result.verdict, "outcome": outcome,
                     "review_status": sample.annotation.review_status, "rule_scope": sample.metadata.rule_scope,
                     "duration_ms": round((time.perf_counter() - started) * 1000), "reason": result.reason,
                     "trace": [asdict(step) for step in result.trace], "usage": asdict(result.usage)})
    return {"total": len(rows), "outcomes": dict(outcomes),
            "label_agreement": outcomes["correct"] / len(rows) if rows else None, "cases": rows}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=Path, required=True)
    parser.add_argument("--provider", choices=["jev", "chat"], default="jev")
    parser.add_argument("--base-url", help="API base including /v1, not /systemone; required for chat")
    parser.add_argument("--model", help="Defaults to jev-1.13.0; required for chat")
    parser.add_argument("--api-key-env", help="Defaults to TYPESAFE_API_KEY for Jev, TOPIC_MODEL_API_KEY for chat")
    parser.add_argument("--timeout-seconds", type=float, default=20)
    parser.add_argument("--max-tokens", type=int, default=512, help="Chat only: match the current model's configured completion budget")
    parser.add_argument("--lower-threshold", type=float, default=DEFAULT_LOWER_THRESHOLD)
    parser.add_argument("--upper-threshold", type=float, default=DEFAULT_UPPER_THRESHOLD)
    parser.add_argument("--include-proposed", action="store_true", help="Include unreviewed synthetic labels for plumbing checks only")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.provider == "chat" and (not args.base_url or not args.model):
        parser.error("Chat replay requires an explicit --base-url and --model.")
    args.base_url = args.base_url or "https://api.typesafe.ai/v1"
    args.model = args.model or "jev-1.13.0"
    args.api_key_env = args.api_key_env or ("TYPESAFE_API_KEY" if args.provider == "jev" else "TOPIC_MODEL_API_KEY")
    if args.output.exists() or not args.output.parent.is_dir():
        parser.error("Output must be a new file in an existing directory.")
    if not math.isfinite(args.timeout_seconds) or args.timeout_seconds <= 0 or args.max_tokens < 1:
        parser.error("Timeout must be finite and positive; max tokens must be positive.")
    samples, skipped = load_samples(args.samples, include_proposed=args.include_proposed)
    if not samples:
        parser.error("No eligible input samples; review/approve labels or use --include-proposed for a plumbing check.")
    credential = os.environ.get(args.api_key_env, "")
    if not credential.strip():
        parser.error(f"Missing credential in {args.api_key_env}.")
    common = dict(base_url=args.base_url, model=args.model, api_key=credential, timeout_seconds=args.timeout_seconds)
    evaluator = (JevTopicEvaluator(**common, lower_threshold=args.lower_threshold, upper_threshold=args.upper_threshold)
                 if args.provider == "jev" else ChatTopicEvaluator(**common, api_key_env_var=None, request_options={"max_tokens": args.max_tokens}))
    report = asyncio.run(replay(samples, evaluator, args.timeout_seconds))
    report.update(schema_version="topic-control-evaluation.v1", provider=args.provider, model=args.model,
                  settings={"timeout_seconds": args.timeout_seconds, **(
                      {"lower_threshold": args.lower_threshold, "upper_threshold": args.upper_threshold} if args.provider == "jev"
                      else {"max_tokens": args.max_tokens})},
                  dataset_sha256=hashlib.sha256(args.samples.read_bytes()).hexdigest(), skipped=skipped,
                  includes_proposed=any(sample.annotation.review_status == "proposed" for sample in samples))
    # Exclusive creation prevents overwriting another evaluation or the source corpus.
    with args.output.open("x") as output:
        output.write(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key != "cases"}, ensure_ascii=False))
    return 1 if report["outcomes"].get("error") else 0


if __name__ == "__main__":
    raise SystemExit(main())
