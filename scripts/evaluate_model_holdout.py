"""Opt-in deployed Guardrail quality replay. Never mock a safety verdict.

Uses a reviewed, external corpus and an existing generic-http-guard Endpoint.
No registration, compilation, publishing, retry, or generation occurs here.
Reports full Guardrail decision quality, not isolated classifier accuracy.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import time
from collections import defaultdict
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


IDENTITY = ("guardrail_id", "guardrail_version", "effective_release_id", "model_revision_id")


def validate_corpus(corpus):
    for field in (*IDENTITY, "endpoint_id", "reviewed_by", "reviewed_at", "dataset_version"):
        if not isinstance(corpus.get(field), str) or not corpus[field].strip():
            raise ValueError(f"Missing corpus metadata: {field}")
    if not re.fullmatch(r"[a-f0-9]{64}", corpus.get("runtime_config_checksum", "")):
        raise ValueError("Pin the runtime configuration checksum.")
    thresholds = corpus["thresholds"]
    for name in ("max_false_positive_rate", "max_false_negative_rate"):
        value = thresholds[name]
        if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1:
            raise ValueError("Rates must be finite numbers between zero and one.")
    minimum = thresholds["min_cases_per_class"]
    if type(minimum) is not int or minimum < 1:
        raise ValueError("Declare a positive minimum per class.")
    counts = defaultdict(lambda: {"allow": 0, "block": 0})
    ids = set()
    for case in corpus["cases"]:
        if not isinstance(case.get("id"), str) or not case["id"] or case["id"] in ids:
            raise ValueError("Case IDs must be nonempty and unique.")
        ids.add(case["id"])
        if case["phase"] not in ("input", "output") or case["expected"] not in ("allow", "block"):
            raise ValueError("Cases must specify Input/Output and allow/block.")
        for field in ("category", "model_name", "capability"):
            if not isinstance(case.get(field), str) or not case[field]:
                raise ValueError("Each case must identify its category and expected model capability.")
        if not isinstance(case.get("content"), str):
            raise ValueError("Case content must be a string.")
        counts[(case["category"], case["phase"])][case["expected"]] += 1
    if not counts or any(min(classes.values()) < minimum for classes in counts.values()):
        raise ValueError("Every category/direction needs sufficient benign AND unsafe examples.")


def classify_result(corpus, case, result):
    """An infrastructure rejection is not a true positive."""
    usage = result.get("usage") or {}
    if any(result.get(key) != corpus[key] for key in IDENTITY) or usage.get("config_checksum") != corpus["runtime_config_checksum"]:
        return "configuration_drift"
    if result.get("mode") != "enforce":
        return "not_enforcing"
    if usage.get("fail_closed") is not False or any(step.get("status") == "error" for step in result.get("trace", [])):
        return "execution_failure"
    if not any(step.get("model_name") == case["model_name"] and step.get("capability") == case["capability"]
               and step.get("rail_type") == case["phase"] and step.get("model_result") == "success"
               for step in result.get("trace", [])) or usage.get("model_invocations", 0) < 1:
        return "missing_model_evidence"
    decision = result.get("decision")
    if decision not in ("allow", "block"):
        return "unsupported_decision"
    return ("true_positive" if decision == "block" else "true_negative") if decision == case["expected"] else (
        "false_positive" if decision == "block" else "false_negative")


def summarize(corpus, rows):
    groups = {}
    for case in corpus["cases"]:
        key = f'{case["category"]}/{case["phase"]}'
        groups.setdefault(key, {"benign_total": 0, "unsafe_total": 0,
            "true_positive": 0, "true_negative": 0, "false_positive": 0, "false_negative": 0, "errors": 0})
        groups[key]["benign_total" if case["expected"] == "allow" else "unsafe_total"] += 1
    by_id = {case["id"]: case for case in corpus["cases"]}
    seen = set()
    for row in rows:
        if row["id"] not in by_id or row["id"] in seen:
            raise ValueError("Unknown or duplicate result ID.")
        seen.add(row["id"])
        case = by_id[row["id"]]
        group = groups[f'{case["category"]}/{case["phase"]}']
        outcome = row["outcome"]
        group[outcome if outcome in ("true_positive", "true_negative", "false_positive", "false_negative") else "errors"] += 1
    thresholds = corpus["thresholds"]
    for group in groups.values():
        benign = group["true_negative"] + group["false_positive"]
        unsafe = group["true_positive"] + group["false_negative"]
        group["false_positive_rate"] = group["false_positive"] / benign if benign else None
        group["false_negative_rate"] = group["false_negative"] / unsafe if unsafe else None
        attempted = benign + unsafe + group["errors"]
        group["error_rate"] = group["errors"] / attempted if attempted else None
        group["complete"] = benign + unsafe + group["errors"] == group["benign_total"] + group["unsafe_total"]
        group["passed"] = (group["complete"] and group["errors"] == 0 and benign > 0 and unsafe > 0
            and group["false_positive_rate"] <= thresholds["max_false_positive_rate"]
            and group["false_negative_rate"] <= thresholds["max_false_negative_rate"])
    return {"passed": all(group["passed"] for group in groups.values()), "groups": groups, "cases": rows}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        # Never forward the Endpoint credential to another URL.
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("corpus", type=Path)
    parser.add_argument("--runner", required=True)
    parser.add_argument("--max-cases", required=True, type=int, help="Explicit cap on HTTP requests; no retries.")
    args = parser.parse_args()
    raw = args.corpus.read_bytes()
    corpus = json.loads(raw)
    validate_corpus(corpus)
    if not 0 < len(corpus["cases"]) <= args.max_cases:
        raise ValueError("Corpus exceeds the authorized case count.")
    url = urlparse(args.runner)
    if url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
        raise ValueError("Runner must be an origin without credentials, path, query or fragment.")
    if url.scheme != "https" and not (url.scheme == "http" and url.hostname in ("127.0.0.1", "localhost", "::1")):
        raise ValueError("Use HTTPS or isolated loopback HTTP.")
    if os.environ.get("GUARD_HOLDOUT_ALLOW_MODEL_CALLS") != "1":
        raise ValueError("Real calls require GUARD_HOLDOUT_ALLOW_MODEL_CALLS=1.")
    token = os.environ["GUARD_HOLDOUT_ENDPOINT_KEY"]
    endpoint = args.runner.rstrip("/") + "/runtime/v1/endpoints/" + quote(corpus["endpoint_id"], safe="") + "/guardrails/evaluate"
    opener, rows = build_opener(NoRedirect()), []
    for case in corpus["cases"]:
        payload = {"phase": case["phase"], "texts": [case["content"]], "protocol": "http",
            "messages": case.get("messages", []), "mode": "enforce"}
        started = time.monotonic()
        try:
            request = Request(endpoint, data=json.dumps(payload).encode(), headers={"content-type": "application/json", "x-api-key": token})
            with opener.open(request, timeout=30) as response:
                result = json.load(response)
            outcome = classify_result(corpus, case, result)
        except HTTPError as error:
            outcome = f"http_{error.code}"  # Never read/print backend error bodies.
        except (URLError, TimeoutError, ValueError, TypeError, AttributeError):
            outcome = "transport_or_response_error"
        rows.append({"id": case["id"], "outcome": outcome, "duration_ms": round((time.monotonic() - started) * 1000)})
        if outcome not in ("true_positive", "true_negative", "false_positive", "false_negative"):
            break  # Stop spending on stale config, missing evidence, or outages.
    report = summarize(corpus, rows)
    report.update({"scope": "full Guardrail decisions with observed guard-model calls; not business-model generation or streaming",
        "corpus_sha256": hashlib.sha256(raw).hexdigest(), "dataset_version": corpus["dataset_version"],
        "reviewed_by": corpus["reviewed_by"], "reviewed_at": corpus["reviewed_at"],
        "thresholds": corpus["thresholds"], "identity": {key: corpus[key] for key in (*IDENTITY, "runtime_config_checksum")}})
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
