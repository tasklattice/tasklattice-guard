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
        keyed_routes = tuple(((item.capability, item.contract_ref, rail), item.evaluator)
            for item in routes
            for rail in sorted(item.evaluator.supported_rails(item.capability, item.contract_ref)
                if callable(getattr(item.evaluator, "supported_rails", None)) else item.evaluator.rails))
        keys = tuple(key for key, _ in keyed_routes)
        if len(set(keys)) != len(keys):
            raise ValueError("Evaluation route capability, contract and rail must be unique.")
        self._routes = MappingProxyType(dict(keyed_routes))
        self.capabilities = frozenset(item.capability for item in routes)
        self.rails = frozenset(
            rail
            for item in routes
            for rail in item.evaluator.rails
        )

    @property
    def route_keys(self) -> tuple[tuple[str, str], ...]:
        """Expose immutable route identities for readiness and contract tests."""

        return tuple(dict.fromkeys((capability, contract) for capability, contract, _ in self._routes))

    @property
    def route_rail_keys(self) -> tuple[tuple[str, str, str], ...]:
        """Exact directional readiness, not the union of unrelated routes."""
        return tuple(self._routes)

    @property
    def route_evaluators(self) -> tuple[tuple[str, str, str], ...]:
        """Expose capability, contract, and evaluator IDs for readiness evidence."""

        return tuple(dict.fromkeys(
            (capability, contract_ref, evaluator.id)
            for (capability, contract_ref, _rail), evaluator in self._routes.items()
        ))

    async def execute(self, request: EvaluationRequest) -> EvaluationResult:
        evaluator = self._routes.get(
            (request.capability, request.binding.contract_ref, request.rail_type)
        )
        if evaluator is None:
            return evaluation_result(
                request,
                "error",
                request.content,
                reason=(
                    "No evaluator route is configured for capability "
                    f"{request.capability!r} and contract "
                    f"{request.binding.contract_ref!r} on the {request.rail_type!r} rail."
                ),
            )
        return await evaluator.evaluate(request)
