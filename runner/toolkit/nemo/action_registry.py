from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import re
from types import MappingProxyType
from typing import Literal

from ..runtime.contracts import RailType
from .actions.contracts import ActionProvider
from .actions.names import (
    ACTION_AUTOMATED_REASONING,
    ACTION_CONTENT_FILTER,
    ACTION_CUSTOMER_IDENTIFIER,
    ACTION_EVALUATE,
    ACTION_GROUNDING,
    ACTION_INDIRECT_PROMPT_INJECTION,
    ACTION_PROMPT_SECURITY,
    ACTION_PROMPT_LEAKAGE,
    ACTION_RECORD_NATIVE,
    ACTION_RECORD_POLICY,
    ACTION_RESOLVE,
    ACTION_SECRETS,
    ACTION_TOPIC_JUDGE,
    ACTION_TOPIC_RULES,
)
from ..evaluation.contracts import CONTRACT_TOPIC_RULES


@dataclass(frozen=True, slots=True)
class ActionDefinition:
    """Versioned metadata for an Action that may be referenced by Colang."""

    name: str
    version: str
    input_schema: tuple[tuple[str, str], ...]
    output_schema: tuple[tuple[str, str], ...]
    supported_rails: tuple[RailType, ...]
    timeout_ms: int
    failure_mode: Literal["fail_open", "fail_closed"]
    side_effects: bool
    concurrent: bool
    network_access: bool = False
    secret_names: tuple[str, ...] = ()
    provider_ready: bool = True


class ActionCatalog:
    def __init__(self, definitions: tuple[ActionDefinition, ...]) -> None:
        keys = tuple((item.name, item.version) for item in definitions)
        if len(set(keys)) != len(keys):
            raise ValueError("Action names and versions must be unique.")
        self._definitions = {key: item for key, item in zip(keys, definitions, strict=True)}

    def definitions(self) -> tuple[ActionDefinition, ...]:
        return tuple(self._definitions.values())

    def get(self, name: str, version: str) -> ActionDefinition:
        try:
            return self._definitions[(name, version)]
        except KeyError as error:
            raise KeyError(f"Action {name}@{version} is not registered.") from error

    def contains(self, name: str, version: str) -> bool:
        return (name, version) in self._definitions


ActionProviders = Mapping[tuple[str, str], ActionProvider]


_BUILTIN_RUNTIME_ACTIONS = (
    (ACTION_EVALUATE, ("pii", "content_safety", "jailbreak"), ("input", "output")),
    (ACTION_SECRETS, ("secrets",), ("input", "output")),
    (ACTION_CONTENT_FILTER, ("builtin_content_filter",), ("input", "output")),
    (ACTION_TOPIC_RULES, ("topic_control",), ("input", "output")),
    (ACTION_PROMPT_SECURITY, ("prompt_injection",), ("input",)),
    (ACTION_INDIRECT_PROMPT_INJECTION, ("indirect_prompt_injection",), ("input",)),
    (ACTION_PROMPT_LEAKAGE, ("system_prompt_leakage",), ("output",)),
    (ACTION_TOPIC_JUDGE, ("topic_control", "company_policy"), ("input", "output")),
    (ACTION_GROUNDING, ("contextual_grounding",), ("output",)),
    (ACTION_AUTOMATED_REASONING, ("automated_reasoning",), ("output",)),
)


def action_providers(*providers: ActionProvider) -> ActionProviders:
    """Return the immutable provider map bound into native NeMo Actions."""
    keys = tuple((item.name, item.version) for item in providers)
    if len(set(keys)) != len(keys):
        raise ValueError("Action provider names and versions must be unique.")
    return MappingProxyType(
        {key: provider for key, provider in zip(keys, providers, strict=True)}
    )


def _dynamic_action_name(capability: str) -> str:
    parts = tuple(item for item in re.split(r"[^A-Za-z0-9]+", capability) if item)
    capability = "".join(item.capitalize() for item in parts) or "Custom"
    return f"Guard{capability}Action"


def action_name_for(capability: str, contract_ref: str) -> str:
    """Return the stable NeMo Action name for one evaluation contract."""
    if capability in {"pii", "content_safety", "jailbreak"}:
        return ACTION_EVALUATE
    if capability == "topic_control":
        return ACTION_TOPIC_RULES if contract_ref == CONTRACT_TOPIC_RULES else ACTION_TOPIC_JUDGE
    return {
        "secrets": ACTION_SECRETS,
        "builtin_content_filter": ACTION_CONTENT_FILTER,
        "prompt_injection": ACTION_PROMPT_SECURITY,
        "indirect_prompt_injection": ACTION_INDIRECT_PROMPT_INJECTION,
        "system_prompt_leakage": ACTION_PROMPT_LEAKAGE,
        "company_policy": ACTION_TOPIC_JUDGE,
        "contextual_grounding": ACTION_GROUNDING,
        "automated_reasoning": ACTION_AUTOMATED_REASONING,
    }.get(capability, _dynamic_action_name(capability))


BUILTIN_ACTION_CATALOG = ActionCatalog(
    (
        *tuple(
            ActionDefinition(
                name=name,
                version="1.0.0",
                input_schema=(("request", "ActionRequest"),),
                output_schema=(("result", "ActionResult"),),
                supported_rails=tuple(rails),
                timeout_ms=(
                    30_000
                    if name in {
                        ACTION_EVALUATE,
                        ACTION_AUTOMATED_REASONING,
                    }
                    else 5_000
                ),
                failure_mode="fail_closed",
                side_effects=False,
                concurrent=True,
                network_access=name in {
                    ACTION_EVALUATE,
                    ACTION_TOPIC_JUDGE,
                    ACTION_GROUNDING,
                    ACTION_AUTOMATED_REASONING,
                },
            )
            for name, _, rails in _BUILTIN_RUNTIME_ACTIONS
        ),
        ActionDefinition(
            name=ACTION_CUSTOMER_IDENTIFIER,
            version="1.0.0",
            input_schema=(("text", "string"),),
            output_schema=(("detected", "boolean"), ("redacted", "string")),
            supported_rails=("input", "output"),
            timeout_ms=100,
            failure_mode="fail_closed",
            side_effects=False,
            concurrent=True,
        ),
        ActionDefinition(
            name=ACTION_RECORD_POLICY,
            version="1.0.0",
            input_schema=(
                ("binding_id", "string"),
                ("safe", "boolean"),
                ("text", "string"),
                ("replacement", "string|null"),
            ),
            output_schema=(("verdict", "string"),),
            supported_rails=("input", "output"),
            timeout_ms=100,
            failure_mode="fail_closed",
            side_effects=False,
            concurrent=True,
        ),
    )
)
