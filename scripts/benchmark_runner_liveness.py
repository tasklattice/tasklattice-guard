#!/usr/bin/env python3
"""Measure real NeMo prewarm scaling and event-loop stalls, without a cluster.

Run: .venv/bin/python scripts/benchmark_runner_liveness.py --versions 1 8 32
The optional injected delay is a fault simulation, not a performance result.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
from dataclasses import replace
import json
import platform
from pathlib import Path
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import psutil
from prometheus_client import CollectorRegistry

from runner import generated as protocol
from runner.artifact_store import ArtifactStore
from runner.diagnostics import EventLoopWatchdog
from runner.preparation import prepare
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.actions import local_action_providers
from runner.toolkit.nemo.registry import NeMoRuntimeRegistry


async def measure(fixture: Path, versions: int, observe_readiness: bool, injected_delay: float) -> dict:
    state = protocol.DesiredState()
    state.ParseFromString(base64.b64decode((fixture / "desired-state.pb.b64").read_text()))
    providers = action_providers(*local_action_providers())
    samples: list[float] = []
    running = True

    async def tick():
        previous = time.perf_counter()
        while running:
            await asyncio.sleep(.01)
            now = time.perf_counter()
            samples.append(max(0, now - previous - .01))
            previous = now

    with tempfile.TemporaryDirectory(prefix="runner-liveness-") as directory:
        store = ArtifactStore(fixture / "public-key.pem", Path(directory))
        artifact = store._artifact_from_message(state.artifacts[0])
        candidates = tuple((
            replace(artifact.plan, guardrail_version=f"benchmark-{index}"),
            replace(artifact.config, guardrail_version=f"benchmark-{index}"),
        ) for index in range(versions))
        registry = NeMoRuntimeRegistry(store, providers)
        metrics = CollectorRegistry()
        watchdog = EventLoopWatchdog(metrics, runner_id="isolated-benchmark")
        watchdog.start()
        building = threading.Event()
        original = registry._build_with_logging

        def build(*args):
            if not building.is_set():
                building.set()
                if injected_delay:
                    time.sleep(injected_delay)
            return original(*args)

        registry._build_with_logging = build
        ticker = asyncio.create_task(tick())
        await asyncio.sleep(.02)
        process = psutil.Process()
        cpu_start = process.cpu_times()
        rss_before = process.memory_info().rss
        started = time.perf_counter()
        active = frozenset((plan.guardrail_id, plan.guardrail_version) for plan, _ in candidates)
        worker = asyncio.create_task(prepare(registry.prepare_release, candidates, active, providers=providers))
        readiness_seconds = 0.0
        try:
            if not await asyncio.to_thread(building.wait, 30):
                raise RuntimeError("Prewarm did not start within 30 seconds")
            if observe_readiness:
                observed = time.perf_counter()
                registry.readiness()  # The same synchronous call as the HTTP probe.
                readiness_seconds = time.perf_counter() - observed
            prepared = await worker
            registry.publish_release("benchmark", prepared, lambda: None)
            elapsed = time.perf_counter() - started
            await asyncio.sleep(.03)
            cpu_end = process.cpu_times()
            return {
                "versions": versions,
                "observer": "readiness" if observe_readiness else "none",
                "injected_prewarm_seconds": injected_delay,
                "prewarm_seconds": round(elapsed, 4),
                "readiness_wait_seconds": round(readiness_seconds, 4),
                "max_event_loop_delay_seconds": round(max(samples, default=0), 4),
                "process_cpu_seconds": round(cpu_end.user + cpu_end.system - cpu_start.user - cpu_start.system, 4),
                "rss_before_bytes": rss_before,
                "rss_after_bytes": process.memory_info().rss,
                "watchdog_stalls": metrics.get_sample_value("guard_runner_event_loop_stalls_total"),
            }
        finally:
            running = False
            await ticker
            await worker
            await watchdog.stop()
            await registry.shutdown()


async def main(args):
    results = []
    for versions in args.versions:
        for observer in (False, True):
            for iteration in range(args.repeats):
                result = await measure(args.fixture, versions, observer, args.injected_prewarm_seconds)
                results.append({"iteration": iteration + 1, **result})
    print(json.dumps({
        "platform": platform.platform(), "python": platform.python_version(),
        "fixture": str(args.fixture),
        "scope": "Real NeMo prewarm of copied fixture versions; no external model calls or live cluster traffic.",
        "results": results,
    }, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--versions", type=int, nargs="+", default=[1, 8, 32])
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--fixture", type=Path, default=ROOT / "tests/fixtures/artifacts/preset-common-baseline-v1")
    parser.add_argument("--injected-prewarm-seconds", type=float, default=0,
                        help="Simulate a slow prewarm once per batch (diagnostic fault injection only).")
    args = parser.parse_args()
    if any(value < 1 or value > 128 for value in args.versions) or args.repeats < 1 or args.injected_prewarm_seconds < 0:
        parser.error("Use 1–128 versions, positive repeats, and a nonnegative injected delay.")
    asyncio.run(main(args))
