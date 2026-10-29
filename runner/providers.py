from __future__ import annotations

import httpx

from runner.toolkit.nemo.actions import (
    EvaluationActionProvider,
    EvaluationRoute,
    local_action_providers,
)
from runner.toolkit.nemo.actions.contracts import ActionProvider
from runner.toolkit.nemo.actions.prompt_security import PromptSecurityActionProvider
from runner.toolkit.nemo.actions.topic import ChatTopicEvaluator, TopicJudgeActionProvider
from runner.toolkit.nemo.actions.grounding import GroundingActionProvider
from runner.toolkit.nemo.actions.automated_reasoning import HTTPAutomatedReasoningProvider, ReasoningActionProvider
from runner.toolkit.nemo.evaluators.pii import PiiEvaluator
from runner.toolkit.nemo.evaluators.jev import JEV_PROFILE, JEV_PROFILES, JEV_TOPIC_PROFILE
from runner.toolkit.nemo.evaluators.jev_topic import JevTopicEvaluator
from runner.toolkit.nemo.evaluators.jev_jailbreak import JevJailbreakEvaluator
from runner.toolkit.nemo.evaluators.jev_content_safety import JevContentSafetyEvaluator
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
    jev_thresholds: tuple[float, float] | None = None,
) -> tuple[ActionProvider, ...]:
    """Build a complete provider registry from one Controller-owned revision.

    ``jev_thresholds`` sets the Jev uncertainty band (lower, upper). Probabilities
    strictly inside it are reported as ``unknown``, which a blocking Policy treats
    as fail-closed. Deployments tune it through Runner configuration.
    """

    source_profiles = {item.id: item.profile_ref for item in configuration.runtimes}
    for binding in configuration.bindings:
        if JEV_PROFILES.intersection({binding.profile_ref, source_profiles.get(binding.model_ref)}):
            allowed = {"topic_control": JevTopicEvaluator.contracts}
            if binding.profile_ref == JEV_PROFILE:
                allowed["jailbreak"] = JevJailbreakEvaluator.contracts
                allowed["content_safety"] = JevContentSafetyEvaluator.contracts
            if (binding.profile_ref not in JEV_PROFILES or source_profiles.get(binding.model_ref) != binding.profile_ref
                or binding.capability_ref not in allowed or binding.binding_id != f"{binding.capability_ref}.input"
                or _rail_name(binding.rail_type) != "input"
                or tuple(binding.contract_refs) != tuple(allowed.get(binding.capability_ref, ()))):
                scope = "input Topic Control" if binding.profile_ref == JEV_TOPIC_PROFILE else "input Topic Control, Jailbreak detection or Content Safety"
                raise ValueError(f"Jev supports only {scope} with matching capability, contract and runtime profile.")
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
    bindings = {item.binding_id: item for item in configuration.bindings}
    local_providers = local_action_providers(PromptSecurityActionProvider())
    pii_evaluator = PiiEvaluator()

    binding_sources = [
        item
        for item in configuration.bindings
        if item.capability_ref in {"content_safety", "jailbreak", "pii_semantic"} and item.profile_ref not in JEV_PROFILES
    ]
    evaluator_bindings = tuple(
        EvaluatorBindingConfig(
            id=f"{binding.binding_id}:{binding.model_ref}:{index}",
            contract_ref=contract_ref,
            profile_ref=binding.profile_ref,
            model_ref=binding.model_ref,
            priority={"jailbreak": 50, "pii_semantic": 75, "content_safety": 100}[binding.capability_ref] + index,
            rail_type=_rail_name(binding.rail_type),
        )
        for binding in binding_sources
        for index, contract_ref in enumerate(binding.contract_refs)
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
    for capability, evaluator_type in (("jailbreak", JevJailbreakEvaluator), ("content_safety", JevContentSafetyEvaluator)):
        binding = bindings.get(f"{capability}.input")
        if binding is None or binding.profile_ref != JEV_PROFILE:
            continue
        runtime = _assigned_runtime(binding.model_ref, runtimes)
        evaluator = evaluator_type(
            base_url=runtime.base_url, model=runtime.model, api_key=runtime.api_key or "",
            provider_id=runtime.id, timeout_seconds=runtime.timeout_seconds,
            skip_tls_verify=runtime.skip_tls_verify, transport=transport,
            **({"lower_threshold": jev_thresholds[0], "upper_threshold": jev_thresholds[1]}
               if jev_thresholds else {}),
        )
        routes.append(EvaluationRoute(capability, next(iter(evaluator.contracts)), evaluator))
    providers: list[ActionProvider] = [
        *local_providers,
        EvaluationActionProvider(tuple(routes)),
    ]

    topic = bindings.get("topic_control.input")
    if topic is not None:
        runtime = _assigned_runtime(topic.model_ref, runtimes)
        source = next(item for item in configuration.runtimes if item.id == topic.model_ref)
        if (topic.profile_ref != source.profile_ref or topic.capability_ref != "topic_control"
            or _rail_name(topic.rail_type) != "input"
            or tuple(topic.contract_refs) != ("tali.guard.topic-control.semantic.v1",)):
            raise ValueError("Topic Control binding must match its runtime, capability, contract and Rail.")
        if topic.profile_ref in JEV_PROFILES:
            evaluator = JevTopicEvaluator(
                base_url=runtime.base_url, model=runtime.model, api_key=runtime.api_key or "",
                provider_id=runtime.id, timeout_seconds=runtime.timeout_seconds,
                skip_tls_verify=runtime.skip_tls_verify, transport=transport, profile_ref=topic.profile_ref,
            )
        else:
            if topic.profile_ref not in {"tali.taxonomy-judge.v1", "tali.nemoguard-topic-control.v1"}:
                raise ValueError("Unsupported Topic Control model profile.")
            evaluator = ChatTopicEvaluator(
                capability="topic_control", base_url=runtime.base_url, model=runtime.model,
                api_key_env_var=None, api_key=runtime.api_key, provider_id=runtime.id,
                skip_tls_verify=runtime.skip_tls_verify, timeout_seconds=runtime.timeout_seconds,
                request_options={"max_tokens": runtime.max_tokens}, transport=transport,
            )
        providers.append(TopicJudgeActionProvider(evaluator=evaluator))

    grounding = bindings.get("contextual_grounding.output")
    if grounding is not None:
        runtime = _assigned_runtime(grounding.model_ref, runtimes)
        providers.append(GroundingActionProvider(
            base_url=runtime.base_url,
            model=runtime.model,
            api_key=runtime.api_key,
            skip_tls_verify=runtime.skip_tls_verify,
            timeout_seconds=runtime.timeout_seconds,
            request_options={"max_tokens": runtime.max_tokens},
            transport=transport,
        ))

    reasoning = bindings.get("automated_reasoning.output")
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


def _rail_name(value: int) -> str:
    if value == 1:
        return "input"
    if value == 2:
        return "output"
    raise ValueError(f"Capability Binding uses unsupported RailType {value!r}.")


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
