from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from ..runtime.contracts import OutputDeliveryMode, RailType, SafetyLevel


PolicySource = Literal["built_in", "custom"]
PolicyRuleForm = Literal[
    "regex",
    "keyword",
    "category",
    "code_block",
    "competitor_intent",
    "colang_flow",
]
PolicyRail = RailType
PolicyTestDecision = Literal["allow", "block", "transform", "intervene"]
PolicyTestKind = Literal["rule_acceptance", "scenario"]
PolicyTagSource = Literal["declared", "derived"]
PolicyTagNamespace = Literal[
    "capability",
    "collection",
    "domain",
    "framework",
    "implementation",
    "jurisdiction",
    "rail",
]


@dataclass(frozen=True, slots=True)
class PolicyTag:
    """One non-exclusive, searchable Policy label.

    ``namespace`` is a reviewed discovery facet. Keeping the vocabulary
    explicit prevents retired or product-irrelevant categories from silently
    reappearing in the Policy Library.
    """

    namespace: PolicyTagNamespace
    value: str
    label: str
    source: PolicyTagSource = "declared"

    @property
    def id(self) -> str:
        return f"{self.namespace}:{self.value}"


@dataclass(frozen=True, slots=True)
class PolicyParameterSpec:
    name: str
    label: str
    kind: str
    required: bool
    placeholder: str
    description: str = ""


@dataclass(frozen=True, slots=True)
class PolicyImplementationRef:
    """Technical provenance for one Rule; not another product hierarchy."""

    engine: str
    form: PolicyRuleForm
    binding_id: str
    implementation_rule_id: str
    detector: str | None = None
    flow_name: str | None = None
    action_name: str | None = None


@dataclass(frozen=True, slots=True)
class PolicyRuleSpec:
    id: str
    name: str
    description: str
    form: PolicyRuleForm
    effect: str
    rails: tuple[PolicyRail, ...]
    implementation: PolicyImplementationRef
    taxonomy_ids: tuple[str, ...]
    expression: str | None = None
    context_expression: str | None = None
    context_max_gap_words: int | None = None
    allow_word_numbers: bool = False
    redaction: str | None = None
    severity_threshold: str | None = None
    identifiers: tuple[str, ...] = ()
    conditions: tuple[str, ...] = ()
    keywords: tuple[tuple[str, str], ...] = ()
    always_block: tuple[tuple[str, str], ...] = ()
    exceptions: tuple[str, ...] = ()
    phrase_patterns: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class PolicyTestCaseSpec:
    id: str
    name: str
    description: str
    phase: PolicyRail
    content: str
    expected_decision: PolicyTestDecision
    covered_rule_ids: tuple[str, ...]
    group: str = "General"
    kind: PolicyTestKind = "scenario"
    required: bool = True
    parameter_names: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class PolicySpec:
    id: str
    name: str
    description: str
    source: PolicySource
    version: str
    tags: tuple[PolicyTag, ...]
    parameters: tuple[PolicyParameterSpec, ...]
    rules: tuple[PolicyRuleSpec, ...]
    test_cases: tuple[PolicyTestCaseSpec, ...]
    safety_level: SafetyLevel = "balanced"
    output_delivery: OutputDeliveryMode = "window_buffered"

    @property
    def rails(self) -> tuple[PolicyRail, ...]:
        configured = {rail for rule in self.rules for rail in rule.rails}
        order: tuple[PolicyRail, ...] = (
            "input",
            "retrieval",
            "dialog",
            "execution",
            "output",
        )
        return tuple(rail for rail in order if rail in configured)

    @property
    def effects(self) -> tuple[str, ...]:
        return tuple(sorted({rule.effect for rule in self.rules}))

    @property
    def forms(self) -> tuple[PolicyRuleForm, ...]:
        return tuple(sorted({rule.form for rule in self.rules}))

    @property
    def test_count(self) -> int:
        return len(self.test_cases)
