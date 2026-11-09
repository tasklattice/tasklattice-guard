"""Shared, untrusted context for Endpoint and internal inspection adapters."""
from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator
from .toolkit.runtime.contracts import GuardContentBlock
from .toolkit.runtime.content_views import text_blocks


class MemoryBoundaryContext(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal["read", "write"]
    source_query: str = Field(default="", max_length=100_000)


class GuardrailContext(BaseModel):
    """Explicit untrusted evidence; callers cannot promote it to instructions."""

    model_config = ConfigDict(extra="forbid")
    query: str = Field(default="", max_length=100_000)
    target_source: Literal["user_input", "retrieved_content", "tool_output"] | None = None
    memory: MemoryBoundaryContext | None = None
    grounding_sources: list[str] = Field(default_factory=list, max_length=32)

    @model_validator(mode="after")
    def bounded_sources(self):
        if sum(len(source) for source in self.grounding_sources) > 500_000:
            raise ValueError("Grounding sources exceed the request context limit.")
        return self


def _request_content(phase, texts, context: GuardrailContext | None, source="user_input"):
    if context is None:
        return text_blocks(phase, tuple(texts or ()), source) if source != "user_input" else ()
    source = context.target_source or source
    if context.memory:
        source = "tool_output" if context.memory.operation == "write" else "retrieved_content"
    blocks = list(text_blocks(phase, tuple(texts or ()), source))
    if context.memory:
        from dataclasses import replace
        blocks = [replace(block, metadata=(("memory.operation", context.memory.operation),
            ("memory.source_query", context.memory.source_query))) for block in blocks]
    if context.query.strip():
        blocks.append(GuardContentBlock(id="context:query", text=context.query, role="query", trust="untrusted",
            source="request", qualifiers=("query",)))
    blocks.extend(GuardContentBlock(id=f"context:source:{index}", text=value, role="grounding_source", trust="untrusted",
        source="request", qualifiers=("grounding_source",)) for index, value in enumerate(context.grounding_sources) if value.strip())
    return tuple(blocks)

