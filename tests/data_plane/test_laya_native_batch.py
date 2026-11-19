"""Packing, offsets, truncation and ONNX feeds without downloading model weights."""
from contextlib import nullcontext
import sys
from types import ModuleType, SimpleNamespace

import numpy as np
import pytest

from runner.laya_batch import LayaInput
from runner.laya_native_batch import predict_native_batch


class Tensor:
    def __init__(self, value):
        self.value = np.asarray(value)

    def numpy(self):
        return self.value

    def __getitem__(self, index):
        return Tensor(self.value[index])

    def sum(self):
        return self.value.sum()


@pytest.fixture
def sdk(monkeypatch):
    calls = []
    def collate(groups, padding):
        rows = [row for group in groups for row in group]
        length = max(len(row["ids"]) for row in rows)
        return {
            "input_ids": Tensor([row["ids"] + [padding] * (length - len(row["ids"])) for row in rows]),
            "attention_mask": Tensor([[1] * len(row["ids"]) + [0] * (length - len(row["ids"])) for row in rows]),
            "marker_pos": Tensor([[0, 1] for _ in rows]),
            "marker_mask": Tensor([[1, 1] for _ in rows]), "qtype": Tensor([0] * len(rows)),
        }

    class Agent:
        @staticmethod
        def _check_question(key, definition):
            assert definition["type"] == "noul"

    package = ModuleType("laya")
    package.__path__ = []
    module = ModuleType("laya.agent")
    module.Agent, module.collate_items = Agent, collate
    module.collapsed_options = lambda ids, items: {}
    monkeypatch.setitem(sys.modules, "laya", package)
    monkeypatch.setitem(sys.modules, "laya.agent", module)
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(no_grad=nullcontext))

    def encode(state, ids, internal, max_len, head_max_len):
        calls.append(("encode", state, tuple(ids), max_len, head_max_len))
        long = state == {"request": "long", "topic": "support"}
        return [{"ids": [2] * (5 if long else 3), "state_stats": {
            "state_tokens": 11 if long else 2, "state_tokens_dropped": 7 if long else 0, "truncated": long}}
                for _key in ids]

    def decode(logits, act, items, ids, internal, offset, lang):
        assert lang == "en"
        return {key: {"type": "noul", "noul": float(act[offset + index, 1])} for index, key in enumerate(ids)}

    agent = SimpleNamespace(hooks=[], tok=SimpleNamespace(pad_token_id=0),
        _encode_state=encode, _decode_answers=decode, _to_internal=lambda question: question)

    def forward(batch):
        calls.append(("forward", batch))
        probabilities = np.arange(1, len(batch["qtype"].numpy()) + 1) / 10
        return np.zeros((len(probabilities), 2)), np.stack([1 - probabilities, probabilities], axis=-1)
    agent._forward = forward
    return agent, calls


def inputs(include_bad=False):
    question = {"type": "noul", "instructions": "Check this state."}
    items = [LayaInput("short", {"risk": question, "aux": question}, 1024, 512),
             LayaInput({"request": "long", "topic": "support"}, {"risk": question}, 1024, 512)]
    if include_bad:
        items.insert(1, LayaInput("invalid", {"risk": {"type": "score"}}, 1024, 512))
    return items


def test_eager_batch_preserves_duplicate_ids_row_offsets_and_per_state_coverage(sdk):
    agent, calls = sdk
    first, bad, last = predict_native_batch(agent, inputs(include_bad=True))
    assert isinstance(bad, ValueError)
    assert first["answers"] == {"risk": {"type": "noul", "noul": .1}, "aux": {"type": "noul", "noul": .2}}
    assert last["answers"] == {"risk": {"type": "noul", "noul": .3}}
    assert first["usage"] == {"input_tokens": 6, "output_tokens": 0, "state_tokens": 2,
        "state_tokens_dropped": 0, "truncated": False, "truncated_questions": []}
    assert last["usage"] == {"input_tokens": 5, "output_tokens": 0, "state_tokens": 11,
        "state_tokens_dropped": 7, "truncated": True, "truncated_questions": ["risk"]}
    assert len([call for call in calls if call[0] == "forward"]) == 1
    assert first["inference_batch"]["id"] == last["inference_batch"]["id"]
    assert last["inference_batch"]["size"] == 2 and last["inference_batch"]["index"] == 1


def test_onnx_batch_uses_one_session_run_with_exact_tensor_types_and_softmax(sdk):
    agent, calls = sdk
    def run(names, feeds):
        calls.append(("session", feeds))
        assert names == ["logits", "act_logits"]
        assert set(feeds) == {"input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"}
        assert all(value.dtype == (np.bool_ if key == "marker_mask" else np.int64) for key, value in feeds.items())
        assert feeds["input_ids"].shape == (3, 5)
        return np.zeros((3, 2)), np.log(np.array([[.9, .1], [.8, .2], [.7, .3]]))
    agent.session = SimpleNamespace(run=run)
    first, last = predict_native_batch(agent, inputs())
    assert first["model"] == last["model"] == "laya-rl-agent-onnx"
    assert first["answers"]["risk"]["noul"] == pytest.approx(.1)
    assert last["answers"]["risk"]["noul"] == pytest.approx(.3)
    assert [call[0] for call in calls].count("session") == 1
    assert not any(call[0] == "forward" for call in calls)


def test_instrumented_agents_keep_their_sdk_hooks(sdk):
    agent, calls = sdk
    agent.hooks = [object()]
    def one(state, questions, **options):
        calls.append(("public", state, questions, options))
        return {"model": "hooked", "answers": {key: {} for key in questions}}
    agent.system_one = one
    results = predict_native_batch(agent, inputs())
    assert all(result["model"] == "hooked" and "inference_batch" not in result for result in results)
    assert [call[0] for call in calls] == ["public", "public"]
