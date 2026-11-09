#!/usr/bin/env python3
"""Compare Endpoint authorization with a Git baseline after real config loading.

Run: .venv/bin/python scripts/benchmark_endpoint_auth.py --output output/endpoint-auth-benchmark.json
Only authorization is timed: no HTTP, model inference, database or disk I/O.
Both versions load identical protobuf snapshots through ArtifactStore.apply;
an empty registry stands in for NeMo because the snapshots contain no Artifacts.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import platform
import random
import statistics
import subprocess
import sys
import tempfile
import timeit
from types import ModuleType

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from runner import generated as protocol
from runner.artifact_store import ArtifactStore


class EndpointOnlyRegistry:
    def prepare_release(self, candidates, active, **kwargs):
        assert not candidates and not active
        return None

    def publish_release(self, release_id, prepared, publish):
        publish()

    def discard_prepared(self, prepared):
        pass


def baseline_store(ref: str):
    revision = subprocess.check_output(
        ["git", "rev-parse", "--verify", f"{ref}^{{commit}}"], cwd=ROOT, text=True,
    ).strip()
    source = subprocess.check_output(
        ["git", "show", f"{revision}:runner/artifact_store.py"], cwd=ROOT, text=True,
    )
    module = ModuleType("runner._endpoint_auth_benchmark_baseline")
    module.__package__ = "runner"
    sys.modules[module.__name__] = module
    exec(compile(source, f"{revision}:runner/artifact_store.py", "exec"), module.__dict__)
    return revision, module.ArtifactStore


def desired_state(active: int, revoked: int, anonymous: bool):
    credentials = [protocol.EndpointCredential(
        id=f"active-{i}", sha256=hashlib.sha256(f"credential-{i}".encode()).hexdigest(),
        key_hint="fixture", created_at="2026-11-02T00:00:00Z",
    ) for i in range(active)]
    credentials.extend(protocol.EndpointCredential(
        id=f"revoked-{i}", sha256="0" * 64, key_hint="fixture",
        created_at="2026-11-01T00:00:00Z", revoked_at="2026-11-02T00:00:00Z",
    ) for i in range(revoked))
    return protocol.DesiredState(generation=1, endpoints=[protocol.EndpointRuntime(
        endpoint_id="endpoint", adapter="litellm-generic-guardrail", credential_required=not anonymous,
        verification=protocol.EndpointVerification(credentials=credentials),
    )])


def measure(args):
    revision, before_class = baseline_store(args.baseline_ref)
    jobs, scenarios = [], []
    key = ROOT / "tests/fixtures/artifacts/local-secrets-v1/public-key.pem"
    with tempfile.TemporaryDirectory(prefix="endpoint-auth-benchmark-") as directory:
        for active, revoked in ((1, 0), (4, 0), (16, 0), (128, 0), (1, 1000)):
            for mode, credential in (("credential", "credential-0"), ("invalid", "incorrect"), ("anonymous", None)):
                state = desired_state(active, revoked, mode == "anonymous")
                # Cap the expensive baseline scenarios while keeping paired runs equal.
                iterations = min(args.iterations, 20_000) if active + revoked >= 128 else args.iterations
                scenario = {"active": active, "revoked": revoked, "mode": mode, "iterations": iterations,
                            "before_us": [], "after_us": []}
                scenarios.append(scenario)
                for version, cls in (("before_us", before_class), ("after_us", ArtifactStore)):
                    store = cls(key, Path(directory) / str(len(jobs)))
                    store.attach_registry(EndpointOnlyRegistry())
                    store.apply(state, persist=False)
                    access = store.authorize_endpoint("endpoint", credential)
                    assert access.allowed is (mode != "invalid")
                    assert access.authenticated is (None if mode == "anonymous" else mode == "credential")
                    timer = timeit.Timer("store.authorize_endpoint('endpoint', credential)",
                                         globals={"store": store, "credential": credential})
                    timer.timeit(number=min(iterations, 2000))
                    jobs.append((timer, iterations, scenario[version]))
        rng = random.Random(963)
        for _ in range(args.rounds):
            rng.shuffle(jobs)
            for timer, iterations, samples in jobs:
                samples.append(timer.timeit(number=iterations) * 1_000_000 / iterations)
    for scenario in scenarios:
        before = statistics.median(scenario["before_us"])
        after = statistics.median(scenario["after_us"])
        scenario.update(before_median_us=round(before, 3), after_median_us=round(after, 3),
                        speedup=round(before / after, 2), reduction_percent=round(100 * (1 - after / before), 1))
    return {
        "baseline_commit": revision,
        "optimized_source_sha256": hashlib.sha256((ROOT / "runner/artifact_store.py").read_bytes()).hexdigest(),
        "python": platform.python_version(), "machine": platform.machine(), "rounds": args.rounds,
        "method": "Warmed timeit, randomized paired order, median; real config loading outside timed region; authorization only.",
        "scenarios": scenarios,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-ref", default="963b1765a1ae1848db232a66468780bc7546db15")
    parser.add_argument("--iterations", type=int, default=100_000)
    parser.add_argument("--rounds", type=int, default=7)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.iterations < 1 or args.rounds < 1:
        parser.error("iterations and rounds must be positive")
    result = measure(args)
    print(f"Python {result['python']} / {result['machine']}; {args.rounds} rounds; median microseconds per authorization")
    print("| Active | Revoked | Mode | Before (us) | After (us) | Speedup |")
    print("| ---: | ---: | --- | ---: | ---: | ---: |")
    for row in result["scenarios"]:
        print(f"| {row['active']} | {row['revoked']} | {row['mode']} | {row['before_median_us']} | "
              f"{row['after_median_us']} | {row['speedup']}x |")
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2) + "\n")
        print(f"Results: {args.output.resolve()}")


if __name__ == "__main__":
    main()
