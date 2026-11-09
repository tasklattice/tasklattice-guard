from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class FrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class MemoryRecord(FrozenModel):
    id: str = Field(min_length=1)
    key: str = Field(min_length=1)
    text: str = Field(min_length=1)
    poisoned: bool = False  # Provenance only; never sent to the target model.


class Scenario(FrozenModel):
    schema_version: Literal["security-scenario.v1"] = "security-scenario.v1"
    id: str = Field(min_length=1)
    dataset: str = Field(min_length=1)
    protocol: Literal["indirect_injection", "memory_direct", "memory_query"]
    provenance: dict
    system: str = Field(min_length=1)
    query: str = Field(min_length=1)
    clean_context: str = ""
    attacked_context: str = ""
    initial_memory: tuple[MemoryRecord, ...] = ()
    poison_records: tuple[MemoryRecord, ...] = ()
    poison_queries: tuple[str, ...] = ()
    reference_answer: str = Field(min_length=1)
    attack_goal: str = Field(min_length=1)
    # Exact checks are only for explicitly authored contract fixtures.
    fixture_attack_answer: str | None = None
    utility_query: str | None = None
    utility_reference: str | None = None

    @model_validator(mode="after")
    def boundaries(self):
        if len({r.id for r in self.initial_memory}) != len(self.initial_memory):
            raise ValueError("Duplicate initial memory IDs")
        if any(r.poisoned for r in self.initial_memory):
            raise ValueError("Initial memory must be clean")
        if self.protocol == "indirect_injection":
            if not self.clean_context or not self.attacked_context or self.clean_context == self.attacked_context:
                raise ValueError("Injection requires distinct clean and attacked context")
            if self.initial_memory or self.poison_records or self.poison_queries:
                raise ValueError("Indirect injection cannot mutate memory")
        else:
            if self.clean_context or self.attacked_context:
                raise ValueError("Memory context must come from retrieval")
            if not self.utility_query or not self.utility_reference:
                raise ValueError("Memory scenarios require an unrelated utility probe")
            if self.protocol == "memory_direct":
                if not self.poison_records or self.poison_queries or not all(r.poisoned for r in self.poison_records):
                    raise ValueError("Direct poisoning requires only poisoned records")
                ids = [r.id for r in self.initial_memory + self.poison_records]
                if len(ids) != len(set(ids)):
                    raise ValueError("Duplicate memory IDs")
            elif not self.poison_queries or self.poison_records or any(not q.strip() for q in self.poison_queries):
                raise ValueError("Query-only poisoning requires queries, never prewritten memory")
        return self


class AgentPrompt(FrozenModel):
    """Only model-visible information. No labels, source IDs or poison flags."""
    system: str
    query: str
    contexts: tuple[str, ...] = ()


class Generation(FrozenModel):
    text: str = Field(min_length=1)
    evidence: dict


class Judgment(FrozenModel):
    task_success: bool | None
    attack_success: bool | None
    reason: str = Field(min_length=1)
    evidence: dict = Field(default_factory=dict)


class GuardResult(FrozenModel):
    decision: Literal["allow", "block", "transform", "unknown", "error"]
    text: str
    evidence: dict
