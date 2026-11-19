"""Heterogeneous Noul rows through the pinned Laya 0.3.22 CPU implementation.

The SDK's public predict_batch repeats one question set for every state. Here
each member keeps its exact state and question set, sharing only the forward.
"""
from __future__ import annotations

from copy import deepcopy
import uuid

from .laya_batch import LayaInput


def predict_native_batch(agent, inputs: list[LayaInput]) -> list[dict | Exception]:
    import numpy as np
    import torch
    from laya.agent import Agent, collapsed_options, collate_items

    # Packaged Agents have no hooks. A custom instrumented Agent must retain
    # its SDK entry point rather than silently bypassing its hooks.
    if len(inputs) == 1 or getattr(agent, "hooks", ()):
        results = []
        for item in inputs:
            try:
                results.append(agent.system_one(item.state, item.questions, lang="en",
                    max_len=item.max_len, head_max_len=item.head_max_len))
            except Exception as error:
                results.append(error)
        return results

    results: list[dict | Exception | None] = [None] * len(inputs)
    prepared = []
    for index, item in enumerate(inputs):
        try:
            questions = deepcopy(item.questions)
            ids = list(questions)
            for key in ids:
                if questions[key].get("type") != "noul":
                    raise ValueError("Built-in classifier batching accepts Noul questions only.")
                Agent._check_question(key, questions[key])
            internal = {key: agent._to_internal(questions[key]) for key in ids}
            encoded = agent._encode_state(item.state, ids, internal, item.max_len, item.head_max_len)
            if not encoded:
                raise ValueError("Classifier inference requires at least one question.")
            prepared.append((index, ids, internal, encoded))
        except Exception as error:
            results[index] = error
    if not prepared:
        return results

    with torch.no_grad():
        batch = collate_items([entry[3] for entry in prepared], agent.tok.pad_token_id)
        onnx = hasattr(agent, "session")
        if onnx:
            tensors = {key: batch[key].numpy().astype(bool if key == "marker_mask" else np.int64)
                       for key in ("input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype")}
            logits, act_logits = agent.session.run(["logits", "act_logits"], tensors)
            exponent = np.exp(act_logits - np.max(act_logits, axis=-1, keepdims=True))
            act = exponent / np.sum(exponent, axis=-1, keepdims=True)
        else:
            logits, act = agent._forward(batch)
        batch_id = uuid.uuid4().hex
        row = 0
        for position, (index, ids, internal, encoded) in enumerate(prepared):
            count = len(encoded)
            try:
                stats = [entry["state_stats"] for entry in encoded]
                dropped = max(entry["state_tokens_dropped"] for entry in stats)
                usage = {"input_tokens": int(batch["attention_mask"][row:row + count].sum()), "output_tokens": 0,
                    "state_tokens": stats[0]["state_tokens"], "state_tokens_dropped": dropped,
                    "truncated": dropped > 0,
                    "truncated_questions": [key for key, stat in zip(ids, stats, strict=True) if stat["truncated"]]}
                collapsed = collapsed_options(ids, encoded)
                if collapsed:
                    usage["options"] = collapsed
                results[index] = {"model": "laya-rl-agent-onnx" if onnx else "laya-rl-agent",
                    "answers": agent._decode_answers(logits, act, encoded, ids, internal, row, lang="en"),
                    "usage": usage, "inference_batch": {"id": batch_id, "size": len(prepared),
                        "index": position, "question_count": sum(len(entry[1]) for entry in prepared)}}
            except Exception as error:
                results[index] = error
            row += count
    return results
