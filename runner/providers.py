from __future__ import annotations

from runner.toolkit.nemo.actions import (
    EvaluationActionProvider,
    EvaluationRoute,
    local_action_providers,
)
from runner.toolkit.nemo.actions.contracts import ActionProvider
from runner.toolkit.nemo.actions.prompt_security import PromptSecurityActionProvider
from runner.toolkit.nemo.actions.topic import TopicJudgeActionProvider
from runner.toolkit.nemo.actions.automated_reasoning import HTTPAutomatedReasoningProvider, ReasoningActionProvider
from runner.toolkit.nemo.evaluators.pii import PiiEvaluator
from runner.toolkit.evaluation.contracts import (
    CONTRACT_PII_EXACT,
    MODEL_SAFETY_CONTRACT_BY_CAPABILITY,
)
from runner.toolkit.nemo.evaluators.safety_model import SafetyModelEvaluator
from runner.toolkit.safety.providers import (
    build_safety_model_provider,
    resolve_evaluator_model_providers,
)

from .config import RunnerSettings


def runtime_action_providers(settings: RunnerSettings) -> tuple[ActionProvider, ...]:
    local_providers = local_action_providers(PromptSecurityActionProvider())
    pii_evaluator = PiiEvaluator()
    provider_configs = resolve_evaluator_model_providers(
        settings.model_runtimes,
        settings.evaluator_bindings,
    )
    safety_evaluator = SafetyModelEvaluator(
        tuple(
            build_safety_model_provider(item)
            for item in provider_configs
        )
    )
    routes = [EvaluationRoute("pii", CONTRACT_PII_EXACT, pii_evaluator)]
    routes.extend(
        EvaluationRoute(
            capability,
            MODEL_SAFETY_CONTRACT_BY_CAPABILITY[capability],
            safety_evaluator,
        )
        for capability in ("pii", "content_safety", "jailbreak")
        if capability in safety_evaluator.capabilities
    )
    evaluation = EvaluationActionProvider(tuple(routes))
    providers: list[ActionProvider] = [
        *local_providers,
        evaluation,
    ]
    taxonomy_judge = next(
        (
            item
            for item in provider_configs
            if item.role == "taxonomy_judge"
            and item.contract_ref in {
                "tali.guard.topic-control.semantic.v1",
                "tali.guard.company-policy.v1",
            }
        ),
        None,
    )
    if taxonomy_judge is not None:
        providers.append(
            TopicJudgeActionProvider(
                base_url=taxonomy_judge.base_url,
                model=taxonomy_judge.model,
                api_key_env_var=taxonomy_judge.api_key_env_var,
                provider_id=taxonomy_judge.id,
                timeout_seconds=taxonomy_judge.timeout_seconds,
            )
        )
    if settings.automated_reasoning_endpoint_url:
        providers.append(ReasoningActionProvider(HTTPAutomatedReasoningProvider(
            endpoint_url=settings.automated_reasoning_endpoint_url,
            api_key_env_var=settings.automated_reasoning_api_key_env_var,
        )))
    return tuple(providers)
