#!/usr/bin/env python3
"""Compare NeMo runtime profiles through TaskLattice's public HTTP adapter.

This is a release benchmark, not a pytest benchmark. It intentionally has no
timing assertions: latency is reported for SLO review, while policy semantics
are compared exactly through privacy-safe SHA-256 digests.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import os
import random
import statistics
import sys
import time
import uuid
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, datetime
from itertools import product
from pathlib import Path
from typing import Any, Mapping, Sequence

import httpx


PROFILES = (
    "iorails_native",
    "llmrails_colang1_standard",
    "llmrails_colang2_programmable",
)
SIZE_BYTES = {"1KB": 1_000, "10KB": 10_000, "100KB": 100_000}
DEFAULT_CONCURRENCIES = (1, 32, 128)
SENSITIVE_HEADERS = frozenset(
    {"authorization", "cookie", "proxy-authorization", "x-api-key"}
)


@dataclass(frozen=True, slots=True)
class Target:
    name: str
    profile: str
    otel_enabled: bool
    url: str
    api_key_env: str | None
    api_key_header: str
    headers: tuple[tuple[str, str], ...]
    payload: Mapping[str, Any]
    guardrail_id: str | None
    guardrail_version: str | None
    artifact_checksum: str | None

    def public_metadata(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "profile": self.profile,
            "otel_enabled": self.otel_enabled,
            "url": self.url,
            "api_key_env": self.api_key_env,
            "api_key_header": self.api_key_header,
            "header_names": [name for name, _ in self.headers],
            "guardrail_id": self.guardrail_id,
            "guardrail_version": self.guardrail_version,
            "artifact_checksum": self.artifact_checksum,
        }


@dataclass(frozen=True, slots=True)
class BenchmarkCase:
    name: str
    outcome: str
    seed: str
    padding: str
    input_type: str
    payload: Mapping[str, Any]
    expected_decision: str
    expected_action: str | None
    expected_text_contains: str | None


@dataclass(frozen=True, slots=True)
class Sample:
    latency_ms: float
    error: str | None
    semantic_hash: str | None
    semantic_summary: Mapping[str, Any] | None
    decision: str | None
    action_latencies_ms: tuple[float, ...] = ()
    provider_latencies_ms: tuple[float, ...] = ()


@dataclass(slots=True)
class Bucket:
    samples: list[Sample] = field(default_factory=list)
    wall_seconds: float = 0.0


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object.")
    return value


def _string(value: Any, label: str, *, optional: bool = False) -> str | None:
    if optional and value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string.")
    return value.strip()


def load_manifest(path: Path) -> tuple[tuple[Target, ...], tuple[BenchmarkCase, ...], Mapping[str, Any]]:
    raw = _mapping(json.loads(path.read_text(encoding="utf-8")), "manifest")
    base_payload = _mapping(raw.get("payload", {}), "payload")

    raw_targets = raw.get("targets")
    if not isinstance(raw_targets, list) or not raw_targets:
        raise ValueError("targets must be a non-empty JSON array.")
    targets: list[Target] = []
    for index, value in enumerate(raw_targets):
        item = _mapping(value, f"targets[{index}]")
        name = _string(item.get("name"), f"targets[{index}].name")
        profile = _string(item.get("profile"), f"targets[{index}].profile")
        if profile not in PROFILES:
            raise ValueError(
                f"targets[{index}].profile must be one of {', '.join(PROFILES)}."
            )
        if not isinstance(item.get("otel_enabled"), bool):
            raise ValueError(f"targets[{index}].otel_enabled must be a boolean.")
        headers = _mapping(item.get("headers", {}), f"targets[{index}].headers")
        normalized_headers: list[tuple[str, str]] = []
        for header_name, header_value in headers.items():
            if not isinstance(header_name, str) or not isinstance(header_value, str):
                raise ValueError(f"targets[{index}].headers must contain strings.")
            if header_name.casefold() in SENSITIVE_HEADERS:
                raise ValueError(
                    f"Put {header_name} in an environment variable, not the manifest."
                )
            normalized_headers.append((header_name, header_value))
        api_key_env = _string(
            item.get("api_key_env"),
            f"targets[{index}].api_key_env",
            optional=True,
        )
        api_key_header = _string(
            item.get("api_key_header", "x-api-key"),
            f"targets[{index}].api_key_header",
        )
        guardrail_version = _string(
            item.get("guardrail_version"),
            f"targets[{index}].guardrail_version",
            optional=True,
        )
        targets.append(
            Target(
                name=str(name),
                profile=str(profile),
                otel_enabled=bool(item["otel_enabled"]),
                url=str(_string(item.get("url"), f"targets[{index}].url")),
                api_key_env=api_key_env,
                api_key_header=str(api_key_header),
                headers=tuple(sorted(normalized_headers)),
                payload=_mapping(item.get("payload", {}), f"targets[{index}].payload"),
                guardrail_id=_string(
                    item.get("guardrail_id"),
                    f"targets[{index}].guardrail_id",
                    optional=True,
                ),
                guardrail_version=guardrail_version,
                artifact_checksum=_string(
                    item.get("artifact_checksum"),
                    f"targets[{index}].artifact_checksum",
                    optional=True,
                ),
            )
        )
    if len({target.name for target in targets}) != len(targets):
        raise ValueError("Target names must be unique.")

    raw_cases = raw.get("cases")
    if not isinstance(raw_cases, list) or not raw_cases:
        raise ValueError("cases must be a non-empty JSON array.")
    cases: list[BenchmarkCase] = []
    for index, value in enumerate(raw_cases):
        item = _mapping(value, f"cases[{index}]")
        outcome = _string(item.get("outcome"), f"cases[{index}].outcome")
        if outcome not in {"allow", "mask", "block"}:
            raise ValueError(f"cases[{index}].outcome must be allow, mask, or block.")
        expected_decision = _string(
            item.get("expected_decision"), f"cases[{index}].expected_decision"
        )
        required_decision = {"allow": "allow", "mask": "transform", "block": "block"}[
            str(outcome)
        ]
        if expected_decision != required_decision:
            raise ValueError(
                f"The {outcome} case must expect decision={required_decision!r}."
            )
        padding = _string(item.get("padding", " neutral"), f"cases[{index}].padding")
        if not str(padding).isascii():
            raise ValueError("Case padding must be ASCII so byte sizing is exact.")
        expected_text_contains = _string(
            item.get("expected_text_contains"),
            f"cases[{index}].expected_text_contains",
            optional=True,
        )
        if outcome == "mask" and expected_text_contains is None:
            raise ValueError("A mask case must set expected_text_contains.")
        input_type = _string(
            item.get("input_type", "request"), f"cases[{index}].input_type"
        )
        if input_type not in {"request", "response"}:
            raise ValueError(f"cases[{index}].input_type must be request or response.")
        cases.append(
            BenchmarkCase(
                name=str(_string(item.get("name"), f"cases[{index}].name")),
                outcome=str(outcome),
                seed=str(_string(item.get("seed"), f"cases[{index}].seed")),
                padding=str(padding),
                input_type=str(input_type),
                payload=_mapping(item.get("payload", {}), f"cases[{index}].payload"),
                expected_decision=str(expected_decision),
                expected_action=_string(
                    item.get("expected_action"),
                    f"cases[{index}].expected_action",
                    optional=True,
                ),
                expected_text_contains=expected_text_contains,
            )
        )
    if len({case.name for case in cases}) != len(cases):
        raise ValueError("Case names must be unique.")
    missing_outcomes = {"allow", "mask", "block"} - {case.outcome for case in cases}
    if missing_outcomes:
        raise ValueError(f"Cases do not cover: {', '.join(sorted(missing_outcomes))}.")
    return tuple(targets), tuple(cases), base_payload


def sized_text(case: BenchmarkCase, size_bytes: int) -> str:
    seed = case.seed.encode("utf-8")
    if len(seed) > size_bytes:
        raise ValueError(
            f"Case {case.name!r} seed exceeds the requested {size_bytes}-byte size."
        )
    remaining = size_bytes - len(seed)
    padding = case.padding.encode("ascii")
    suffix = (padding * math.ceil(remaining / len(padding)))[:remaining]
    result = seed + suffix
    assert len(result) == size_bytes
    return result.decode("utf-8")


def request_payload(
    base: Mapping[str, Any],
    target: Target,
    case: BenchmarkCase,
    text: str,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "protocol": "http",
        "input_type": case.input_type,
        "output_scope": "full",
    }
    payload.update(base)
    payload.update(target.payload)
    payload.update(case.payload)
    payload.pop("content", None)
    payload["texts"] = [text]
    payload["input_type"] = case.input_type
    payload["output_scope"] = "full"
    return payload


def request_headers(target: Target) -> dict[str, str]:
    headers = dict(target.headers)
    headers["user-agent"] = "tasklattice-nemo-profile-benchmark/1"
    if target.api_key_env:
        value = os.environ.get(target.api_key_env, "")
        if not value:
            raise ValueError(
                f"Target {target.name!r} requires environment variable "
                f"{target.api_key_env}."
            )
        headers[target.api_key_header] = value
    return headers


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def semantic_digest(body: Mapping[str, Any]) -> tuple[str, Mapping[str, Any]]:
    texts = body.get("texts", [])
    findings = body.get("findings", [])
    if not isinstance(texts, list) or not all(isinstance(item, str) for item in texts):
        raise ValueError("Response texts must be a string array.")
    if not isinstance(findings, list) or not all(isinstance(item, dict) for item in findings):
        raise ValueError("Response findings must be an object array.")
    normalized_findings = sorted((_canonical(item) for item in findings))
    semantic_value = {
        "decision": body.get("decision"),
        "action": body.get("action"),
        "texts": texts,
        "findings": normalized_findings,
    }
    digest = hashlib.sha256(_canonical(semantic_value).encode("utf-8")).hexdigest()
    text_json = _canonical(texts).encode("utf-8")
    finding_json = _canonical(normalized_findings).encode("utf-8")
    return digest, {
        "decision": body.get("decision"),
        "action": body.get("action"),
        "text_count": len(texts),
        "text_bytes": sum(len(item.encode("utf-8")) for item in texts),
        "texts_sha256": hashlib.sha256(text_json).hexdigest(),
        "finding_count": len(findings),
        "findings_sha256": hashlib.sha256(finding_json).hexdigest(),
    }


def trace_latencies(body: Mapping[str, Any]) -> tuple[tuple[float, ...], tuple[float, ...]]:
    actions: list[float] = []
    providers: list[float] = []
    trace = body.get("trace", [])
    if not isinstance(trace, list):
        return (), ()
    for item in trace:
        if not isinstance(item, dict):
            continue
        if str(item.get("kind", "")).casefold() == "action":
            duration = item.get("duration_ms")
            if isinstance(duration, (int, float)) and not isinstance(duration, bool):
                actions.append(float(duration))
        provider = item.get("provider_latency_ms")
        if isinstance(provider, (int, float)) and not isinstance(provider, bool) and provider > 0:
            providers.append(float(provider))
    return tuple(actions), tuple(providers)


def validate_response(target: Target, case: BenchmarkCase, body: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    if body.get("decision") != case.expected_decision:
        errors.append(
            f"expected decision {case.expected_decision!r}, got {body.get('decision')!r}"
        )
    if case.expected_action and body.get("action") != case.expected_action:
        errors.append(f"expected action {case.expected_action!r}, got {body.get('action')!r}")
    texts = body.get("texts", [])
    if case.expected_text_contains and (
        not isinstance(texts, list)
        or case.expected_text_contains not in "\n".join(str(item) for item in texts)
    ):
        errors.append(f"transformed text does not contain {case.expected_text_contains!r}")
    if target.guardrail_id and body.get("guardrail_id") != target.guardrail_id:
        errors.append(
            f"expected guardrail_id {target.guardrail_id!r}, got {body.get('guardrail_id')!r}"
        )
    if (
        target.guardrail_version is not None
        and body.get("guardrail_version") != target.guardrail_version
    ):
        errors.append(
            f"expected guardrail_version {target.guardrail_version}, "
            f"got {body.get('guardrail_version')!r}"
        )
    if target.artifact_checksum:
        observed = {
            str(item.get("config_checksum"))
            for item in body.get("trace", [])
            if isinstance(item, dict) and item.get("config_checksum")
        }
        if observed and observed != {target.artifact_checksum}:
            errors.append(
                f"expected config checksum {target.artifact_checksum}, got {sorted(observed)}"
            )
    return errors


async def one_request(
    client: httpx.AsyncClient,
    target: Target,
    case: BenchmarkCase,
    payload: Mapping[str, Any],
) -> Sample:
    started = time.perf_counter()
    try:
        response = await client.post(target.url, json=payload)
    except Exception as error:  # The report must retain transport failure types.
        return Sample(
            latency_ms=(time.perf_counter() - started) * 1_000,
            error=f"{type(error).__name__}: {error}",
            semantic_hash=None,
            semantic_summary=None,
            decision=None,
        )
    latency_ms = (time.perf_counter() - started) * 1_000
    if response.status_code != 200:
        detail = response.text.replace("\n", " ")[:300]
        return Sample(
            latency_ms=latency_ms,
            error=f"HTTP {response.status_code}: {detail}",
            semantic_hash=None,
            semantic_summary=None,
            decision=None,
        )
    try:
        body = _mapping(response.json(), "response")
        digest, summary = semantic_digest(body)
        actions, providers = trace_latencies(body)
        validation_errors = validate_response(target, case, body)
    except Exception as error:
        return Sample(
            latency_ms=latency_ms,
            error=f"Invalid response: {error}",
            semantic_hash=None,
            semantic_summary=None,
            decision=None,
        )
    return Sample(
        latency_ms=latency_ms,
        error="; ".join(validation_errors) if validation_errors else None,
        semantic_hash=digest,
        semantic_summary=summary,
        decision=str(body.get("decision")),
        action_latencies_ms=actions,
        provider_latencies_ms=providers,
    )


async def run_cell(
    client: httpx.AsyncClient,
    target: Target,
    case: BenchmarkCase,
    payload: Mapping[str, Any],
    concurrency: int,
    request_count: int,
) -> tuple[list[Sample], float]:
    semaphore = asyncio.Semaphore(concurrency)

    async def guarded_request() -> Sample:
        async with semaphore:
            return await one_request(client, target, case, payload)

    started = time.perf_counter()
    samples = await asyncio.gather(*(guarded_request() for _ in range(request_count)))
    return list(samples), time.perf_counter() - started


def metric(values: Sequence[float]) -> Mapping[str, float | int] | None:
    if not values:
        return None
    ordered = sorted(values)

    def percentile(value: float) -> float:
        index = max(0, math.ceil(value * len(ordered)) - 1)
        return round(ordered[index], 3)

    return {
        "count": len(ordered),
        "min": round(ordered[0], 3),
        "mean": round(statistics.fmean(ordered), 3),
        "p50": percentile(0.50),
        "p95": percentile(0.95),
        "p99": percentile(0.99),
        "max": round(ordered[-1], 3),
    }


def measurement(
    target: Target,
    case: BenchmarkCase,
    size_label: str,
    concurrency: int,
    bucket: Bucket,
) -> dict[str, Any]:
    signatures = Counter(
        sample.semantic_hash for sample in bucket.samples if sample.semantic_hash is not None
    )
    summaries = {
        str(sample.semantic_hash): sample.semantic_summary
        for sample in bucket.samples
        if sample.semantic_hash and sample.semantic_summary
    }
    errors = [sample.error for sample in bucket.samples if sample.error]
    return {
        "target": target.name,
        "profile": target.profile,
        "otel_enabled": target.otel_enabled,
        "case": case.name,
        "outcome": case.outcome,
        "size": size_label,
        "size_bytes": SIZE_BYTES[size_label],
        "concurrency": concurrency,
        "request_count": len(bucket.samples),
        "valid_request_count": len(bucket.samples) - len(errors),
        "error_count": len(errors),
        "errors": errors[:10],
        "wall_seconds": round(bucket.wall_seconds, 6),
        "throughput_rps": round(
            len(bucket.samples) / bucket.wall_seconds if bucket.wall_seconds else 0.0,
            3,
        ),
        "request_latency_ms": metric([sample.latency_ms for sample in bucket.samples]),
        "action_latency_ms": metric(
            [value for sample in bucket.samples for value in sample.action_latencies_ms]
        ),
        "provider_latency_ms": metric(
            [value for sample in bucket.samples for value in sample.provider_latencies_ms]
        ),
        "decision_counts": dict(
            sorted(Counter(sample.decision for sample in bucket.samples if sample.decision).items())
        ),
        "semantic_signature_counts": dict(sorted(signatures.items())),
        "semantic_summaries": summaries,
    }


def equivalence_report(measurements: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str], list[Mapping[str, Any]]] = {}
    for item in measurements:
        key = (str(item["case"]), str(item["size"]))
        groups.setdefault(key, []).append(item)
    report: list[dict[str, Any]] = []
    for (case_name, size_label), items in sorted(groups.items()):
        target_signatures = {
            f"{item['target']}@c={item['concurrency']}": sorted(
                item["semantic_signature_counts"].keys()
            )
            for item in items
        }
        signature_sets = [tuple(value) for value in target_signatures.values()]
        repeatable = all(len(value) == 1 for value in signature_sets)
        equivalent = repeatable and len(set(signature_sets)) == 1
        no_errors = all(int(item["error_count"]) == 0 for item in items)
        report.append(
            {
                "case": case_name,
                "size": size_label,
                "concurrency": sorted({int(item["concurrency"]) for item in items}),
                "targets": target_signatures,
                "within_target_repeatable": repeatable,
                "across_target_equivalent": equivalent,
                "no_errors": no_errors,
                "passed": repeatable and equivalent and no_errors,
            }
        )
    return report


def validate_full_matrix(targets: Sequence[Target]) -> None:
    expected = {(profile, enabled) for profile in PROFILES for enabled in (False, True)}
    observed = {(target.profile, target.otel_enabled) for target in targets}
    missing = expected - observed
    if missing:
        rendered = ", ".join(
            f"{profile}/otel={'on' if enabled else 'off'}"
            for profile, enabled in sorted(missing)
        )
        raise ValueError(f"The required profile/OTel matrix is missing: {rendered}.")


async def execute(args: argparse.Namespace) -> int:
    manifest_path = Path(args.config)
    targets, cases, base_payload = load_manifest(manifest_path)
    if args.require_full_matrix:
        validate_full_matrix(targets)
    sizes = tuple(item.strip().upper() for item in args.sizes.split(",") if item.strip())
    unknown_sizes = set(sizes) - set(SIZE_BYTES)
    if unknown_sizes:
        raise ValueError(f"Unknown sizes: {', '.join(sorted(unknown_sizes))}.")
    concurrencies = tuple(int(item) for item in args.concurrency.split(",") if item.strip())
    if not concurrencies or any(value < 1 for value in concurrencies):
        raise ValueError("Concurrency values must be positive integers.")
    if args.rounds < 1 or args.warmups < 0 or args.requests_per_worker < 1:
        raise ValueError("Rounds/requests must be positive and warmups cannot be negative.")
    if args.min_requests < 1:
        raise ValueError("min-requests must be positive.")

    measured_per_round = sum(
        max(args.min_requests, concurrency * args.requests_per_worker)
        for concurrency in concurrencies
    )
    measured_total = (
        len(targets) * len(cases) * len(sizes) * measured_per_round * args.rounds
    )
    warmup_total = len(targets) * len(cases) * len(sizes) * args.warmups
    if args.dry_run:
        print(
            json.dumps(
                {
                    "targets": len(targets),
                    "cases": len(cases),
                    "sizes": sizes,
                    "concurrency": concurrencies,
                    "warmup_requests": warmup_total,
                    "measured_requests": measured_total,
                },
                indent=2,
            )
        )
        return 0

    run_id = uuid.uuid4().hex
    started_at = datetime.now(UTC)
    overall_started = time.perf_counter()
    print(f"Run {run_id} started at {started_at.isoformat()}.")
    clients: dict[str, httpx.AsyncClient] = {}
    buckets: dict[tuple[str, str, str, int], Bucket] = {}
    warmup_errors: list[dict[str, str]] = []
    max_concurrency = max(concurrencies)
    try:
        for target in targets:
            clients[target.name] = httpx.AsyncClient(
                headers=request_headers(target),
                timeout=httpx.Timeout(args.timeout),
                limits=httpx.Limits(
                    max_connections=max_concurrency,
                    max_keepalive_connections=max_concurrency,
                ),
            )

        payloads: dict[tuple[str, str, str], Mapping[str, Any]] = {}
        for target, case, size_label in product(targets, cases, sizes):
            text = sized_text(case, SIZE_BYTES[size_label])
            payload = request_payload(base_payload, target, case, text)
            payloads[(target.name, case.name, size_label)] = payload
            for _ in range(args.warmups):
                sample = await one_request(clients[target.name], target, case, payload)
                if sample.error:
                    warmup_errors.append(
                        {
                            "target": target.name,
                            "case": case.name,
                            "size": size_label,
                            "error": sample.error,
                        }
                    )

        rng = random.Random(args.seed)
        cells = list(product(cases, sizes, concurrencies))
        for _round in range(args.rounds):
            rng.shuffle(cells)
            for case, size_label, concurrency in cells:
                target_order = list(targets)
                rng.shuffle(target_order)
                request_count = max(
                    args.min_requests, concurrency * args.requests_per_worker
                )
                for target in target_order:
                    samples, wall_seconds = await run_cell(
                        clients[target.name],
                        target,
                        case,
                        payloads[(target.name, case.name, size_label)],
                        concurrency,
                        request_count,
                    )
                    bucket = buckets.setdefault(
                        (target.name, case.name, size_label, concurrency), Bucket()
                    )
                    bucket.samples.extend(samples)
                    bucket.wall_seconds += wall_seconds
    finally:
        await asyncio.gather(*(client.aclose() for client in clients.values()))

    measurements = [
        measurement(
            target,
            case,
            size_label,
            concurrency,
            buckets[(target.name, case.name, size_label, concurrency)],
        )
        for target, case, size_label, concurrency in product(
            targets, cases, sizes, concurrencies
        )
    ]
    equivalence = equivalence_report(measurements)
    request_errors = sum(int(item["error_count"]) for item in measurements)
    semantic_failures = sum(not bool(item["passed"]) for item in equivalence)
    manifest_digest = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    finished_at = datetime.now(UTC)
    result = {
        "schema_version": 1,
        "run_id": run_id,
        "started_at": started_at.isoformat(),
        "finished_at": finished_at.isoformat(),
        "duration_seconds": round(time.perf_counter() - overall_started, 6),
        "manifest_sha256": manifest_digest,
        "parameters": {
            "sizes": list(sizes),
            "concurrency": list(concurrencies),
            "rounds": args.rounds,
            "warmups": args.warmups,
            "requests_per_worker": args.requests_per_worker,
            "min_requests": args.min_requests,
            "timeout_seconds": args.timeout,
            "random_seed": args.seed,
            "timing_thresholds": None,
        },
        "targets": [target.public_metadata() for target in targets],
        "warmup_errors": warmup_errors,
        "measurements": measurements,
        "semantic_equivalence": equivalence,
        "summary": {
            "measured_requests": sum(
                int(item["request_count"]) for item in measurements
            ),
            "request_errors_or_expectation_mismatches": request_errors,
            "warmup_errors": len(warmup_errors),
            "semantic_comparisons": len(equivalence),
            "semantic_failures": semantic_failures,
            "passed": not warmup_errors and request_errors == 0 and semantic_failures == 0,
        },
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Wrote {output_path}")
    print(
        f"Measured {result['summary']['measured_requests']} requests; "
        f"request errors/mismatches={request_errors}; "
        f"semantic failures={semantic_failures}."
    )
    return 0 if result["summary"]["passed"] else 2


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--config", required=True, help="Benchmark target/case manifest.")
    result.add_argument("--output", required=True, help="JSON result path.")
    result.add_argument("--sizes", default="1KB,10KB,100KB")
    result.add_argument("--concurrency", default="1,32,128")
    result.add_argument("--rounds", type=int, default=1)
    result.add_argument("--warmups", type=int, default=1)
    result.add_argument("--requests-per-worker", type=int, default=1)
    result.add_argument("--min-requests", type=int, default=20)
    result.add_argument("--timeout", type=float, default=60.0)
    result.add_argument("--seed", type=int, default=20260812)
    result.add_argument("--require-full-matrix", action="store_true")
    result.add_argument("--dry-run", action="store_true")
    return result


def main() -> int:
    try:
        return asyncio.run(execute(parser().parse_args()))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"benchmark configuration error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
