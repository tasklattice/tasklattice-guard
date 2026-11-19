"""Compare separate and batched local classifier forwards on synthetic inputs.

Run in a Runner image with its packaged checkpoint; no Controller is contacted.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
from pathlib import Path
import sys
import time


def question(text):
    return {"type": "noul", "instructions": text}


TEXT = "How can I reset the password for my product account?"
INPUTS = (
    (TEXT, {"unsafe_content": question("Does the text contain unsafe content?"),
            "unsafe_assistance": question("Does the text request harmful or illegal assistance?")}),
    (TEXT, {"jailbreak_attempt": question("Does the text attempt to bypass safety instructions?")}),
    ({"request": TEXT, "topic": "Product support and account management"},
     {"unlisted_task": question("Does the request ask for a task outside the topic?")}),
    ({"current_input": TEXT, "context_messages": []},
     {"name": question("Does current_input contain an actual personal name?"),
      "actual_identifier": question("Does current_input contain an actual personal identifier?"),
      "address": question("Does current_input contain an actual private address?"),
      "dob": question("Does current_input contain an actual date of birth?")}),
)


async def benchmark(iterations):
    from runner.builtin_laya import BuiltinLaya, configure_builtin_cpu_environment

    configure_builtin_cpu_environment()
    from runner.laya_batch import laya_batch_scope
    from runner.toolkit.nemo.evaluators.laya import MODEL_MAX_LEN, MODEL_HEAD_MAX_LEN, parse_answers, check_input_coverage

    runtime = BuiltinLaya.from_env()
    if runtime is None:
        raise ValueError("Set GUARD_BUILTIN_LAYA_MODEL_PATH to the packaged checkpoint directory.")
    shapes, hook, session = [], None, None
    try:
        await runtime.start()
        agent = runtime._agent
        if hasattr(agent, "model"):
            hook = agent.model.register_forward_pre_hook(lambda _model, args: shapes.append(list(args[0].shape)))
        else:
            session = agent.session
            class CountingSession:
                def run(self, names, feeds):
                    shapes.append(list(feeds["input_ids"].shape))
                    return session.run(names, feeds)
            agent.session = CountingSession()

        async def infer(item):
            return await runtime.predict(*item, max_len=MODEL_MAX_LEN, head_max_len=MODEL_HEAD_MAX_LEN,
                                         deadline=time.monotonic() + 120)

        async def combined():
            with laya_batch_scope():
                return await asyncio.gather(*(infer(item) for item in INPUTS))

        reference = [await infer(item) for item in INPUTS]
        assert len(shapes) == len(INPUTS)
        shapes.clear()
        batched = await combined()
        assert len(shapes) == 1
        maximum_delta = 0
        for before, after in zip(reference, batched, strict=True):
            _model, probabilities = parse_answers(before, set(before["answers"]))
            _model, actual = parse_answers(after, set(before["answers"]))
            maximum_delta = max(maximum_delta, max(abs(probabilities[key] - actual[key]) for key in probabilities))
            assert all(math.isclose(probabilities[key], actual[key], rel_tol=1e-3, abs_tol=2e-4) for key in probabilities)
            assert before["usage"] == after["usage"]
            check_input_coverage(after)
        for _ in range(2):
            await combined()

        reports = {}
        for mode in ("serial", "batch"):
            shapes.clear()
            wall, cpu = time.perf_counter(), time.process_time()
            for _ in range(iterations):
                if mode == "serial":
                    for item in INPUTS:
                        await infer(item)
                else:
                    await combined()
            wall, cpu = time.perf_counter() - wall, time.process_time() - cpu
            reports[mode] = {"forward_calls": len(shapes), "wall_seconds": round(wall, 3),
                "cpu_seconds": round(cpu, 3), "request_groups_per_second": round(iterations / wall, 3), "shapes": list(shapes)}
        return {"model": runtime.model_identity, "threads_per_worker": runtime.torch_threads,
            "iterations": iterations, "maximum_probability_delta": round(maximum_delta, 8),
            "equal_token_and_coverage_usage": True, "timing": reports}
    finally:
        if hook is not None:
            hook.remove()
        if session is not None:
            runtime._agent.session = session
        await runtime.close()


if __name__ == "__main__":
    if __file__ != "<stdin>":
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iterations", type=int, default=4)
    args = parser.parse_args()
    if not 1 <= args.iterations <= 100:
        parser.error("Iterations must be between 1 and 100.")
    print(json.dumps(asyncio.run(benchmark(args.iterations)), indent=2))
