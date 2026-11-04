from __future__ import annotations

import httpx

from runner.model_concurrency import ModelConcurrencyTransport, configure_model_limit

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
from runner.toolkit.nemo.evaluators.classifier_review import ClassifierReviewer, REVIEW_PROFILE, REVIEW_CONTRACT
from runner.toolkit.nemo.evaluators.jev import JEV_PROFILE, JEV_PROFILES, JEV_TOPIC_PROFILE
from runner.toolkit.nemo.evaluators.jev_topic import JevTopicEvaluator
from runner.toolkit.nemo.evaluators.jev_jailbreak import JevJailbreakEvaluator
from runner.toolkit.nemo.evaluators.jev_content_safety import JevContentSafetyEvaluator
from runner.toolkit.nemo.evaluators.laya import LAYA_PROFILE, LAYA_PROFILES, LAYA_TOPIC_PROFILE
from runner.toolkit.nemo.evaluators.laya_topic import LayaTopicEvaluator
from runner.toolkit.nemo.evaluators.laya_jailbreak import LayaJailbreakEvaluator
from runner.toolkit.nemo.evaluators.laya_content_safety import LayaContentSafetyEvaluator
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

def dynamic_runtime_action_providers(
    configuration: object,
    credentials: dict[str, str],
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> tuple[ActionProvider, ...]:
    """Build providers using each Model's Controller-owned runtime settings."""

    source_profiles = {item.id: item.profile_ref for item in configuration.runtimes}
    for binding in configuration.bindings:
        if JEV_PROFILES.intersection({binding.profile_ref, source_profiles.get(binding.model_ref)}):
            phase = _rail_name(binding.rail_type)
            allowed = {"topic_control": JevTopicEvaluator.contracts}
            if binding.profile_ref == JEV_PROFILE:
                allowed["jailbreak"] = JevJailbreakEvaluator.contracts
                allowed["content_safety"] = JevContentSafetyEvaluator.contracts
            if (binding.profile_ref not in JEV_PROFILES or source_profiles.get(binding.model_ref) != binding.profile_ref
                or binding.capability_ref not in allowed or binding.binding_id != f"{binding.capability_ref}.{phase}"
                or (phase == "output" and binding.capability_ref != "content_safety")
                or tuple(binding.contract_refs) != tuple(allowed.get(binding.capability_ref, ()))):
                scope = "input Topic Control" if binding.profile_ref == JEV_TOPIC_PROFILE else "input Topic Control, input Jailbreak detection or input/output Content Safety"
                raise ValueError(f"Jev supports only {scope} with matching capability, contract and runtime profile.")
        if LAYA_PROFILES.intersection({binding.profile_ref, source_profiles.get(binding.model_ref)}):
            phase = _rail_name(binding.rail_type)
            allowed = {"topic_control": LayaTopicEvaluator.contracts}
            if binding.profile_ref == LAYA_PROFILE:
                allowed["jailbreak"] = LayaJailbreakEvaluator.contracts
                allowed["content_safety"] = LayaContentSafetyEvaluator.contracts
            if (binding.profile_ref not in LAYA_PROFILES or source_profiles.get(binding.model_ref) != binding.profile_ref
                or binding.capability_ref not in allowed or binding.binding_id != f"{binding.capability_ref}.{phase}"
                or (phase == "output" and binding.capability_ref != "content_safety")
                or tuple(binding.contract_refs) != tuple(allowed.get(binding.capability_ref, ()))):
                scope = "input Topic Control" if binding.profile_ref == LAYA_TOPIC_PROFILE else "input Topic Control, input Jailbreak detection or input/output Content Safety"
                raise ValueError(f"Laya supports only {scope} with matching capability, contract and runtime profile.")
    runtimes = {
        item.id: ModelRuntimeConfig(
            id=item.id,
            base_url=item.base_url.rstrip("/"),
            model=item.model,
            api_key=credentials.get(item.credential_ref, ""),
            timeout_seconds=float(item.timeout_seconds or 20),
            max_tokens=int(item.max_tokens or 128),
            max_concurrency=int(item.max_concurrency or 2),
            rate_limit_attempts=int(item.rate_limit_attempts or 3),
            lower_threshold=item.lower_threshold if item.HasField("lower_threshold") else 0.1,
            upper_threshold=item.upper_threshold if item.HasField("upper_threshold") else 0.9,
            skip_tls_verify=item.skip_tls_verify,
        )
        for item in configuration.runtimes
    }
    for runtime in runtimes.values():
        configure_model_limit(runtime.id, runtime.max_concurrency)
    transports = {runtime.id: ModelConcurrencyTransport(runtime.id, timeout_seconds=runtime.timeout_seconds,
        skip_tls_verify=runtime.skip_tls_verify, transport=transport) for runtime in runtimes.values()}
    bindings = {item.binding_id: item for item in configuration.bindings}
    reviewers = {}
    for item in configuration.bindings:
        if (item.capability_ref == "classifier_review" or item.binding_id.startswith("classifier_review.")
            or REVIEW_PROFILE in {item.profile_ref, source_profiles.get(item.model_ref)}):
            phase = _rail_name(item.rail_type)
            if (item.binding_id != f"classifier_review.{phase}" or item.capability_ref != "classifier_review"
                or item.profile_ref not in {REVIEW_PROFILE, "generic-chat"}
                or source_profiles.get(item.model_ref) != item.profile_ref or tuple(item.contract_refs) != (REVIEW_CONTRACT,)):
                raise ValueError("Classifier review requires its own matching Rail binding, runtime and contract.")
            runtime = _assigned_runtime(item.model_ref,runtimes)
            reviewers[phase] = ClassifierReviewer(base_url=runtime.base_url,model=runtime.model,api_key=runtime.api_key or "",
                provider_id=runtime.id,timeout_seconds=runtime.timeout_seconds,max_tokens=runtime.max_tokens,
                skip_tls_verify=runtime.skip_tls_verify,transport=transports[runtime.id],rail_type=phase,
                rate_limit_attempts=runtime.rate_limit_attempts)
    local_providers = local_action_providers(PromptSecurityActionProvider())
    pii_evaluator = PiiEvaluator()

    binding_sources = [
        item
        for item in configuration.bindings
        if item.capability_ref in {"content_safety", "jailbreak", "pii_semantic"}
        and item.profile_ref not in JEV_PROFILES and item.profile_ref not in LAYA_PROFILES
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
        build_safety_model_provider(item, transport=transports[item.runtime_ref])
        for item in provider_configs
    ))
    routes = [EvaluationRoute("pii", CONTRACT_PII_EXACT, pii_evaluator)]
    for reviewer in reviewers.values():
        routes.append(EvaluationRoute("classifier_review",REVIEW_CONTRACT,reviewer))
    routes.extend(
        EvaluationRoute(
            capability,
            MODEL_SAFETY_CONTRACT_BY_CAPABILITY[capability],
            safety_evaluator,
        )
        for capability in ("pii", "content_safety", "jailbreak")
        if capability in safety_evaluator.capabilities
    )
    for capability, phase, evaluator_type in (("jailbreak", "input", JevJailbreakEvaluator),
            ("content_safety", "input", JevContentSafetyEvaluator), ("content_safety", "output", JevContentSafetyEvaluator)):
        binding = bindings.get(f"{capability}.{phase}")
        if binding is None or binding.profile_ref != JEV_PROFILE:
            continue
        runtime = _assigned_runtime(binding.model_ref, runtimes)
        evaluator = evaluator_type(
            base_url=runtime.base_url, model=runtime.model, api_key=runtime.api_key or "",
            provider_id=runtime.id, timeout_seconds=runtime.timeout_seconds,
            skip_tls_verify=runtime.skip_tls_verify, transport=transports[runtime.id],
            reviewer=reviewers.get(phase), rail_type=phase,
            lower_threshold=runtime.lower_threshold, upper_threshold=runtime.upper_threshold,
            rate_limit_attempts=runtime.rate_limit_attempts,
        )
        routes.append(EvaluationRoute(capability, next(iter(evaluator.contracts)), evaluator))
    for capability, phase, evaluator_type in (("jailbreak", "input", LayaJailbreakEvaluator),
            ("content_safety", "input", LayaContentSafetyEvaluator), ("content_safety", "output", LayaContentSafetyEvaluator)):
        binding = bindings.get(f"{capability}.{phase}")
        if binding is None or binding.profile_ref != LAYA_PROFILE:
            continue
        runtime = _assigned_runtime(binding.model_ref, runtimes)
        evaluator = evaluator_type(
            base_url=runtime.base_url, model=runtime.model, api_key=runtime.api_key or "",
            provider_id=runtime.id, timeout_seconds=runtime.timeout_seconds,
            skip_tls_verify=runtime.skip_tls_verify, transport=transports[runtime.id],
            reviewer=reviewers.get(phase), rail_type=phase,
            lower_threshold=runtime.lower_threshold, upper_threshold=runtime.upper_threshold,
            rate_limit_attempts=runtime.rate_limit_attempts,
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
                skip_tls_verify=runtime.skip_tls_verify, transport=transports[runtime.id], profile_ref=topic.profile_ref,
                lower_threshold=runtime.lower_threshold, upper_threshold=runtime.upper_threshold,
                rate_limit_attempts=runtime.rate_limit_attempts,
                reviewer=reviewers.get("input"),
            )
        elif topic.profile_ref in LAYA_PROFILES:
            evaluator = LayaTopicEvaluator(
                base_url=runtime.base_url, model=runtime.model, api_key=runtime.api_key or "",
                provider_id=runtime.id, timeout_seconds=runtime.timeout_seconds,
                skip_tls_verify=runtime.skip_tls_verify, transport=transports[runtime.id], profile_ref=topic.profile_ref,
                lower_threshold=runtime.lower_threshold, upper_threshold=runtime.upper_threshold,
                rate_limit_attempts=runtime.rate_limit_attempts,
                reviewer=reviewers.get("input"),
            )
        else:
            if topic.profile_ref not in {"tali.taxonomy-judge.v1", "tali.nemoguard-topic-control.v1"}:
                raise ValueError("Unsupported Topic Control model profile.")
            evaluator = ChatTopicEvaluator(
                capability="topic_control", base_url=runtime.base_url, model=runtime.model,
                api_key_env_var=None, api_key=runtime.api_key, provider_id=runtime.id,
                skip_tls_verify=runtime.skip_tls_verify, timeout_seconds=runtime.timeout_seconds,
                request_options={"max_tokens": runtime.max_tokens}, transport=transports[runtime.id],
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
            transport=transports[runtime.id],
        ))

    reasoning = bindings.get("automated_reasoning.output")
    if reasoning is not None:
        runtime = _assigned_runtime(reasoning.model_ref, runtimes)
        providers.append(ReasoningActionProvider(HTTPAutomatedReasoningProvider(
            endpoint_url=runtime.base_url,
            api_key=runtime.api_key,
            skip_tls_verify=runtime.skip_tls_verify,
            timeout_seconds=runtime.timeout_seconds,
            transport=transports[runtime.id],
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
