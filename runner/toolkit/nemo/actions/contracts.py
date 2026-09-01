from __future__ import annotations

from typing import Protocol

from ...runtime.contracts import GuardrailPhase
from ..evaluators.contracts import (
    EvaluationRequest,
    EvaluationResult,
    EvaluationUsage,
    ModelCallResult,
    ModelCallUsage,
    evaluation_result,
    evaluation_view,
)


ActionRequest = EvaluationRequest
ActionResult = EvaluationResult
ActionUsage = EvaluationUsage
action_result = evaluation_result
action_view = evaluation_view


class ActionProvider(Protocol):
    name: str
    version: str
    capabilities: frozenset[str]
    rails: frozenset[GuardrailPhase]

    async def execute(self, request: ActionRequest) -> ActionResult: ...


__all__ = [
    "ActionProvider",
    "ActionRequest",
    "ActionResult",
    "ActionUsage",
    "ModelCallResult",
    "ModelCallUsage",
    "action_result",
    "action_view",
]
