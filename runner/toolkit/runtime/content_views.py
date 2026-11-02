from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from typing import Any

from .contracts import (
    ContentQualifier,
    ContentRole,
    ContentView,
    ContentViewSnapshot,
    EngineRequest,
    GuardContentBlock,
    GuardrailPhase,
)


def default_role(phase: GuardrailPhase, source: str) -> ContentRole:
    if phase == "output":
        return "model_output"
    return {
        "query": "query",
        "retrieved_content": "retrieved_content",
        "grounding_source": "grounding_source",
        "tool_output": "tool_output",
    }.get(source, "user_input")


def text_blocks(
    phase: GuardrailPhase,
    texts: tuple[str, ...],
    source: str,
) -> tuple[GuardContentBlock, ...]:
    role = default_role(phase, source)
    return tuple(
        GuardContentBlock(
            id=f"{phase}:{index}",
            text=text,
            role=role,
            trust="untrusted",
            source="model_output" if phase == "output" else source,
            qualifiers=_default_qualifiers(role),
        )
        for index, text in enumerate(texts)
    )


def content_view(
    blocks: tuple[GuardContentBlock, ...],
    active_block_id: str,
    *,
    kind: ContentView = "original",
    source_digest: str | None = None,
) -> ContentViewSnapshot:
    ids = tuple(block.id for block in blocks)
    if len(set(ids)) != len(ids):
        raise ValueError("Content block identifiers must be unique within a view.")
    if active_block_id not in ids:
        raise ValueError("The active content block is unavailable in the content view.")
    return ContentViewSnapshot(
        kind=kind,
        blocks=blocks,
        active_block_id=active_block_id,
        source_digest=source_digest or _digest(blocks),
    )


def request_view(request: EngineRequest) -> ContentViewSnapshot:
    if request.content_view is not None:
        if (
            request.active_block_id is not None
            and request.active_block_id != request.content_view.active_block_id
        ):
            raise ValueError("NeMo request and content view select different active blocks.")
        return request.content_view
    block_id = request.active_block_id or f"{request.phase}:0"
    role = default_role(request.phase, request.target_source)
    return content_view(
        (
            GuardContentBlock(
                id=block_id,
                text=request.text,
                role=role,
                trust="untrusted",
                source=request.target_source,
                qualifiers=_default_qualifiers(role),
            ),
        ),
        block_id,
    )


def with_active_text(
    view: ContentViewSnapshot,
    text: str,
    *,
    kind: ContentView | None = None,
) -> ContentViewSnapshot:
    blocks = tuple(
        replace(block, text=text) if block.id == view.active_block_id else block
        for block in view.blocks
    )
    return content_view(
        blocks,
        view.active_block_id,
        kind=kind or view.kind,
        source_digest=view.source_digest,
    )


def current_context_messages(request: EngineRequest, text: str) -> tuple[dict[str, Any], ...]:
    """Keep the current conversation message in sync with ordered transforms.

    History may include a copy of the active input/output. Passing that original
    alongside transformed content reintroduces redacted data to later models.
    Only the trailing copy of the active conversation block is replaceable;
    external content and earlier turns remain independent evidence.
    """
    messages = request.context_messages
    block = request_view(request).active_block
    role = {"user_input": "user", "model_output": "assistant"}.get(block.role)
    if (text != block.text and messages and role is not None
            and messages[-1].get("role") == role
            and messages[-1].get("content") == block.text):
        return (*messages[:-1], {**messages[-1], "content": text})
    return messages


def _default_qualifiers(role: ContentRole) -> tuple[ContentQualifier, ...]:
    if role == "trusted_instruction":
        return ()
    if role == "query":
        return ("guard_content", "query")
    if role in {"retrieved_content", "grounding_source"}:
        return ("guard_content", "grounding_source")
    return ("guard_content",)


def _digest(blocks: tuple[GuardContentBlock, ...]) -> str:
    payload = [
        {
            "id": block.id,
            "text": block.text,
            "role": block.role,
            "trust": block.trust,
            "source": block.source,
            "qualifiers": block.qualifiers,
            "metadata": block.metadata,
        }
        for block in blocks
    ]
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    return hashlib.sha256(encoded).hexdigest()
