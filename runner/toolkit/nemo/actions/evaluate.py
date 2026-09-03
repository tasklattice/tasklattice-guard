from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType

from ..evaluators.contracts import (
    EvaluationRequest,
    EvaluationResult,
    GuardEvaluator,
    evaluation_result,
)
from .names import ACTION_EVALUATE


@dataclass(frozen=True, slots=True)
class EvaluationRoute:
    """Bind one product evaluation contract to one evaluator implementation."""

    capability: str
    contract_ref: str
    evaluator: GuardEvaluator

    def __post_init__(self) -> None:
        if not self.capability.strip():
            raise ValueError("Evaluation route capability must not be empty.")
        if not self.contract_ref.strip():
            raise ValueError("Evaluation route contract_ref must not be empty.")
        if self.capability not in self.evaluator.capabilities:
            raise ValueError(
                f"Evaluator {self.evaluator.id}@{self.evaluator.version} does not "
                f"declare capability {self.capability!r}."
            )
        if self.contract_ref not in self.evaluator.contracts:
            raise ValueError(
                f"Evaluator {self.evaluator.id}@{self.evaluator.version} does not "
                f"implement contract {self.contract_ref!r}."
            )


class EvaluationActionProvider:
    """Stable NeMo Action that routes product contracts to evaluators."""

    name = ACTION_EVALUATE
    version = "1.0.0"

    def __init__(self, routes: tuple[EvaluationRoute, ...]) -> None:
        if not routes:
            raise ValueError("GuardEvaluateAction requires at least one route.")
        keys = tuple((item.capability, item.contract_ref) for item in routes)
        if len(set(keys)) != len(keys):
            raise ValueError("Evaluation route capability and contract must be unique.")
        self._routes = MappingProxyType(
            {key: route.evaluator for key, route in zip(keys, routes, strict=True)}
        )
        self.capabilities = frozenset(item.capability for item in routes)
        self.rails = frozenset(
            rail
            for item in routes
            for rail in item.evaluator.rails
        )

    @property
    def route_keys(self) -> tuple[tuple[str, str], ...]:
        """Expose immutable route identities for readiness and contract tests."""

        return tuple(self._routes)

    @property
    def route_evaluators(self) -> tuple[tuple[str, str, str], ...]:
        """Expose capability, contract, and evaluator IDs for readiness evidence."""

        return tuple(
            (capability, contract_ref, evaluator.id)
            for (capability, contract_ref), evaluator in self._routes.items()
        )

    async def execute(self, request: EvaluationRequest) -> EvaluationResult:
        evaluator = self._routes.get(
            (request.capability, request.binding.contract_ref)
        )
        if evaluator is None:
            return evaluation_result(
                request,
                "error",
                request.content,
                reason=(
                    "No evaluator route is configured for capability "
                    f"{request.capability!r} and contract "
                    f"{request.binding.contract_ref!r}."
                ),
            )
        if request.rail_type not in evaluator.rails:
            return evaluation_result(
                request,
                "error",
                request.content,
                reason=(
                    f"Evaluator {evaluator.id}@{evaluator.version} does not support "
                    f"the {request.rail_type!r} rail."
                ),
            )
        return await evaluator.evaluate(request)
