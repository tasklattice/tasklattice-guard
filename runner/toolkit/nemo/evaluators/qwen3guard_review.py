"""Native Qwen3Guard-Gen moderation used as an independent review stage.

The model's chat template classifies the last user or assistant message. It
does not answer arbitrary Policy questions or return per-question JSON.
https://github.com/QwenLM/Qwen3Guard#qwen3guard-gen
"""
from __future__ import annotations

from ...safety.mappings import provider_mapping
from ...safety.providers import Qwen3GuardAdapter
from .contracts import EvaluationRequest

PROFILE = "tali.qwen3guard.v1"
REVIEW_REVISION = "qwen3guard-review.v1"
OUTPUT_REVIEW_REVISION = "qwen3guard-review-output.v1"
_QUESTIONS = {
    "classifier_review": {"unsafe_content"},
    "content_safety": {"unsafe_content"},
    "jailbreak": {"jailbreak_attempt", "unsafe_pretext"},
    "pii": {"contains_pii", "name", "actual_identifier", "address", "dob"},
}


def unavailable_coverage(request: EvaluationRequest, questions: dict, state: dict) -> str | None:
    if request.capability not in _QUESTIONS:
        return "unsupported_capability"
    if not questions or not set(questions).issubset(_QUESTIONS[request.capability]):
        return "unsupported_questions"
    if request.capability == "jailbreak" and (
        request.target_source in {"retrieved_content", "tool_output"}
        or state.get("target_source") in {"retrieved_content", "tool_output"}
        or state.get("memory_operation") in {"read", "write"}
    ):
        return "unsupported_external_or_memory_context"
    return None


def review_messages(request: EvaluationRequest, state: dict) -> list[dict[str, str]]:
    field = "current_output" if request.rail_type == "output" else "current_input"
    content = state.get(field)
    if not isinstance(content, str):
        raise ValueError("Qwen3Guard review requires the current Rail's original text.")
    messages = [{"role": item["role"], "content": item["content"]}
                for item in state.get("context_messages", [])
                if isinstance(item, dict) and item.get("role") in {"user", "assistant"}
                and isinstance(item.get("content"), str)]
    current = {"role": "assistant" if request.rail_type == "output" else "user", "content": content}
    if messages and messages[-1] == current:
        messages.pop()
    if request.rail_type == "output" and not messages:
        messages.append({"role": "user", "content": "Please assess the following assistant response."})
    messages.append(current)
    return messages


def parse_review(content: str, capability: str) -> tuple[str, dict[str, object]]:
    native_verdict, categories = Qwen3GuardAdapter.parse_labels(content)
    evidence = {"native_verdict": native_verdict, "native_categories": categories,
                "coverage": "native_safety_policy"}
    if native_verdict == "safe":
        return "not_matched", evidence
    applicable = False
    unmapped = False
    for category in categories:
        mapping = provider_mapping("qwen3guard", category)
        if mapping is None:
            unmapped = True
        elif (capability in {"classifier_review", "content_safety"}
              or capability == "jailbreak" and mapping.taxonomy_id == "TALI-MODEL-SECURITY-JAILBREAK"
              or capability == "pii" and mapping.taxonomy_id in {"TALI-PRIVACY", "TALI-PRIVACY-PII"}):
            applicable = True
    if applicable and native_verdict == "unsafe":
        return "matched", evidence
    if applicable or unmapped:
        return "unknown", evidence
    return "not_matched", evidence
