from __future__ import annotations

import httpx

from runner.toolkit.nemo.actions import (
    EvaluationActionProvider,
    EvaluationRoute,
    local_action_providers,
)
from runner.toolkit.nemo.actions.contracts import ActionProvider
from runner.toolkit.nemo.actions.prompt_security import PromptSecurityActionProvider
from runner.toolkit.nemo.actions.topic import TopicJudgeActionProvider
from runner.toolkit.nemo.actions.grounding import GroundingActionProvider
from runner.toolkit.nemo.actions.automated_reasoning import HTTPAutomatedReasoningProvider, ReasoningActionProvider
from runner.toolkit.nemo.evaluators.pii import PiiEvaluator
from runner.toolkit.evaluation.contracts import (
    CONTRACT_PII_EXACT,
    MODEL_SAFETY_CONTRACT_BY_CAPABILITY,
)
from runner.toolkit.nemo.evaluators.safety_model import SafetyModelEvaluator
from runner.toolkit.safety.providers import (
    EvaluatorBindingConfig,
    ModelRuntimeConfig,
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
                skip_tls_verify=taxonomy_judge.skip_tls_verify,
            )
        )
    if settings.automated_reasoning_endpoint_url:
        providers.append(ReasoningActionProvider(HTTPAutomatedReasoningProvider(
            endpoint_url=settings.automated_reasoning_endpoint_url,
            api_key_env_var=settings.automated_reasoning_api_key_env_var,
        )))
    return tuple(providers)


def dynamic_runtime_action_providers(
    configuration: object,
    credentials: dict[str, str],
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> tuple[ActionProvider, ...]:
    """Build a complete provider registry from one Controller-owned revision."""

    runtimes = {
        item.id: ModelRuntimeConfig(
            id=item.id,
            base_url=item.base_url.rstrip("/"),
            model=item.model,
            api_key=credentials.get(item.credential_ref, ""),
            timeout_seconds=float(item.timeout_seconds or 20),
            max_tokens=int(item.max_tokens or 128),
            skip_tls_verify=item.skip_tls_verify,
        )
        for item in configuration.runtimes
    }
    assignments = {item.detector_type: item for item in configuration.assignments}
    local_providers = local_action_providers(PromptSecurityActionProvider())
    pii_evaluator = PiiEvaluator()

    content_safety_binding = assignments.get("content_safety")
    jailbreak_binding = assignments.get("jailbreak_detection")
    pii_binding = assignments.get("pii_detection")
    binding_sources = []
    if content_safety_binding is not None:
        binding_sources.append((
            "content_safety",
            content_safety_binding,
            tuple(content_safety_binding.contract_refs),
            100,
        ))
    if jailbreak_binding is not None:
        binding_sources.append((
            "jailbreak_detection",
            jailbreak_binding,
            tuple(jailbreak_binding.contract_refs),
            50,
        ))
    if pii_binding is not None:
        binding_sources.append((
            "pii_detection",
            pii_binding,
            tuple(pii_binding.contract_refs),
            75,
        ))
    evaluator_bindings = tuple(
        EvaluatorBindingConfig(
            id=f"{role}:{binding.model_ref}:{index}",
            contract_ref=contract_ref,
            profile_ref=binding.profile_ref,
            model_ref=binding.model_ref,
            priority=priority + index,
        )
        for role, binding, contract_refs, priority in binding_sources
        for index, contract_ref in enumerate(contract_refs)
    )
    provider_configs = resolve_evaluator_model_providers(
        tuple(runtimes.values()),
        evaluator_bindings,
    )
    safety_evaluator = SafetyModelEvaluator(tuple(
        build_safety_model_provider(item, transport=transport)
        for item in provider_configs
    ))
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
    providers: list[ActionProvider] = [
        *local_providers,
        EvaluationActionProvider(tuple(routes)),
    ]

    topic = assignments.get("topic_control")
    if topic is not None:
        runtime = _assigned_runtime(topic.model_ref, runtimes)
        providers.append(TopicJudgeActionProvider(
            base_url=runtime.base_url,
            model=runtime.model,
            api_key_env_var=None,
            api_key=runtime.api_key,
            provider_id=runtime.id,
            skip_tls_verify=runtime.skip_tls_verify,
            timeout_seconds=runtime.timeout_seconds,
            transport=transport,
        ))

    grounding = assignments.get("contextual_grounding")
    if grounding is not None:
        runtime = _assigned_runtime(grounding.model_ref, runtimes)
        providers.append(GroundingActionProvider(
            base_url=runtime.base_url,
            model=runtime.model,
            api_key=runtime.api_key,
            skip_tls_verify=runtime.skip_tls_verify,
            timeout_seconds=runtime.timeout_seconds,
            transport=transport,
        ))

    reasoning = assignments.get("automated_reasoning")
    if reasoning is not None:
        runtime = _assigned_runtime(reasoning.model_ref, runtimes)
        providers.append(ReasoningActionProvider(HTTPAutomatedReasoningProvider(
            endpoint_url=runtime.base_url,
            api_key=runtime.api_key,
            skip_tls_verify=runtime.skip_tls_verify,
            timeout_seconds=runtime.timeout_seconds,
            transport=transport,
        )))
    return tuple(providers)


def _assigned_runtime(
    model_ref: str,
    runtimes: dict[str, ModelRuntimeConfig],
) -> ModelRuntimeConfig:
    try:
        return runtimes[model_ref]
    except KeyError as error:
        raise ValueError(
            f"Model Assignment references unavailable Runtime {model_ref!r}."
        ) from error
