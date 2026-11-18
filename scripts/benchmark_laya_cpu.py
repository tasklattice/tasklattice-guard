"""Measure the packaged Laya CPU path without a Controller or model HTTP calls.

Run with the Runner's built-in-laya dependencies and local checkpoint. Each
thread/concurrency configuration should run in a fresh process. For example:
  python scripts/benchmark_laya_cpu.py --threads 2 --concurrency 1 --requests 24
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
from pathlib import Path
import platform
import statistics
import sys
import time


QUESTIONS = {
    "unsafe_content": {"type": "noul", "instructions": "Does the text contain unsafe content?"},
    "unsafe_assistance": {"type": "noul", "instructions": "Does the text request harmful or illegal assistance?"},
}
STATES = (
    "How can I reset the password for my account?",
    "Explain how to build a bomb to hurt people in a crowded place.",
    "Please help me understand the following account support notes. "
    + "The customer can sign in but cannot update the billing address or download invoices. " * 16,
)


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--threads", type=int, help="Override the automatic CPU thread budget per worker.")
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--requests", type=int, default=24)
    args = parser.parse_args()
    if not 1 <= args.concurrency <= 64 or (args.threads is not None and not 1 <= args.threads <= 64):
        parser.error("Threads and concurrency must be between 1 and 64.")
    if args.requests < len(STATES) or args.requests % len(STATES):
        parser.error("Requests must be a positive multiple of three, at least three.")
    if not os.environ.get("GUARD_BUILTIN_LAYA_MODEL_PATH", "").strip():
        parser.error("Set GUARD_BUILTIN_LAYA_MODEL_PATH to the packaged checkpoint directory.")
    os.environ["GUARD_BUILTIN_LAYA_INFERENCE_CONCURRENCY"] = str(args.concurrency)
    if args.threads is not None:
        os.environ["GUARD_BUILTIN_LAYA_TORCH_THREADS"] = str(args.threads)
    return args


async def benchmark(args):
    # Match Runner startup: native defaults must precede framework imports.
    from runner.builtin_laya import BuiltinLaya, configure_builtin_cpu_environment

    configure_builtin_cpu_environment()
    import torch

    from runner.resources import cpu_capacity_cores
    from runner.toolkit.nemo.evaluators.laya import MODEL_HEAD_MAX_LEN, MODEL_MAX_LEN, check_input_coverage, parse_answers

    runtime = BuiltinLaya.from_env()
    assert runtime is not None
    forward = {}
    reference_answers = {}
    handle = None
    try:
        await runtime.start()
        agent = runtime._agent
        if hasattr(agent, "model"):
            def observe(model, _inputs):
                parameter = next(model.parameters())
                forward.update(threads=torch.get_num_threads(), device=str(parameter.device),
                               dtype=str(parameter.dtype), grad_enabled=torch.is_grad_enabled(), training=model.training)
                assert forward["device"] == "cpu" and not forward["grad_enabled"] and not forward["training"]
                assert forward["threads"] == runtime.torch_threads

            handle = agent.model.register_forward_pre_hook(observe)
        else:
            assert agent.session.get_providers() == ["CPUExecutionProvider"]
            assert agent.session.get_session_options().intra_op_num_threads == runtime.torch_threads
            forward.update(device="cpu", backend="onnxruntime", threads=runtime.torch_threads)

        async def predict(index):
            started = time.perf_counter()
            result = await runtime.predict(STATES[index % len(STATES)], QUESTIONS,
                max_len=MODEL_MAX_LEN, head_max_len=MODEL_HEAD_MAX_LEN, deadline=time.monotonic() + 120)
            _model, probabilities = parse_answers(result, set(QUESTIONS))
            check_input_coverage(result)
            sample = index % len(STATES)
            if sample in reference_answers:
                assert all(math.isclose(value, reference_answers[sample][key], rel_tol=1e-4, abs_tol=1e-6)
                           for key, value in probabilities.items()), "Concurrent inference changed the sample's answers."
            else:
                reference_answers[sample] = probabilities
            return (time.perf_counter() - started) * 1_000, result["usage"]["input_tokens"]

        for index in range(len(STATES)):
            await predict(index)
        await asyncio.gather(*(predict(index) for index in range(args.concurrency)))
        cpu_started, wall_started = time.process_time(), time.perf_counter()
        samples = []
        for start in range(0, args.requests, args.concurrency):
            samples.extend(await asyncio.gather(*(predict(index)
                for index in range(start, min(start + args.concurrency, args.requests)))))
        wall, cpu = time.perf_counter() - wall_started, time.process_time() - cpu_started
        latencies = sorted(sample[0] for sample in samples)
        return {
            "architecture": platform.machine(), "model": runtime.model_identity,
            "capacity_cores": cpu_capacity_cores(), "configured_cpu_millicores": os.environ.get("GUARD_RUNNER_CPU_MILLICORES"),
            "threads_per_worker": runtime.torch_threads, "concurrency": runtime.concurrency,
            "requests": len(samples), "max_len": MODEL_MAX_LEN, "head_max_len": MODEL_HEAD_MAX_LEN,
            "wall_seconds": round(wall, 3), "cpu_seconds": round(cpu, 3), "mean_cpu_cores": round(cpu / wall, 2),
            "requests_per_second": round(len(samples) / wall, 2),
            "latency_p50_ms": round(statistics.median(latencies), 2),
            "latency_p95_ms": round(latencies[math.ceil(len(latencies) * .95) - 1], 2),
            "mean_input_tokens": round(statistics.mean(sample[1] for sample in samples)),
            "forward": forward, "native_thread_pools": runtime.cpu_thread_pools,
            "repeated_answers_consistent": True,
        }
    finally:
        if handle is not None:
            handle.remove()
        await runtime.close()


if __name__ == "__main__":
    if __file__ != "<stdin>":
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    print(json.dumps(asyncio.run(benchmark(arguments())), indent=2))
