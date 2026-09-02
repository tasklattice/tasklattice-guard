from __future__ import annotations

from collections.abc import Iterable
from dataclasses import replace

from ...runtime.contracts import ProviderEvidence, RiskFinding
from ...safety.mappings import ProviderCategoryMapping, provider_mapping
from ...safety.providers import NativeSafetyAssessment, SafetyModelProvider
from ...safety.taxonomy import taxonomy, taxonomy_for_evaluator
from ..actions.model_call import ModelCallTracker, observe_model_call
from .contracts import (
    EvaluationRequest,
    EvaluationResult,
    EvaluationUsage,
    evaluation_result,
)
from ...evaluation.contracts import (
    CONTRACT_TAXONOMY_NORMALIZATION,
    MODEL_SAFETY_CONTRACT_BY_CAPABILITY,
)


class SafetyModelEvaluator:
    """Capability-aware model evaluator normalized to the TALI taxonomy."""

    id = "model-safety"
    version = "1.0.0"
    rails = frozenset({"input", "output"})

    def __init__(self, providers: tuple[SafetyModelProvider, ...]) -> None:
        self._guards = tuple(
            sorted(
                (item for item in providers if item.config.role == "guard"),
                key=lambda item: (item.config.priority, item.config.id),
            )
        )
        self.capabilities = frozenset(
            capability
            for provider in self._guards
            for capability in provider.capabilities
        )
        self.contracts = frozenset(
            MODEL_SAFETY_CONTRACT_BY_CAPABILITY[capability]
            for capability in self.capabilities
            if capability in MODEL_SAFETY_CONTRACT_BY_CAPABILITY
        )
        self._judge = next(
            (
                item
                for item in providers
                if item.config.role == "taxonomy_judge"
                and item.config.contract_ref == CONTRACT_TAXONOMY_NORMALIZATION
            ),
            None,
        )

    async def evaluate(self, request: EvaluationRequest) -> EvaluationResult:
        messages = _assessment_messages(request)
        trackers: list[ModelCallTracker] = []
        errors: list[str] = []
        guards = tuple(
            item for item in self._guards if request.capability in item.capabilities
        )

        assessment = await self._first_success(
            request,
            messages,
            guards,
            trackers,
            errors,
        )
        usage = _combined_usage(trackers, len(request.content))
        if assessment is None:
            reason = (
                f"No configured Safety Provider supports capability {request.capability!r}."
                if not guards
                else "All eligible Safety Providers failed: " + "; ".join(errors)
            )
            return evaluation_result(
                request,
                "error",
                request.content,
                reason=reason,
                usage=usage,
            )

        if assessment.verdict == "safe":
            return evaluation_result(
                request,
                "safe",
                request.content,
                reason=(
                    f"Safety Provider {assessment.provider_id} classified "
                    f"capability {request.capability} as safe."
                ),
                usage=usage,
            )

        findings, unmapped, irrelevant = await self._canonical_findings(
            request,
            messages,
            assessment,
            trackers,
            errors,
        )
        usage = _combined_usage(trackers, len(request.content))
        if not findings:
            if irrelevant and not unmapped:
                return evaluation_result(
                    request,
                    "safe",
                    request.content,
                    reason=(
                        f"Safety Provider {assessment.provider_id} returned no "
                        f"category applicable to capability {request.capability}."
                    ),
                    usage=usage,
                )
            reason = (
                f"Safety Provider {assessment.provider_id} returned "
                f"{assessment.verdict}, but no applicable native category could "
                "be mapped to TALI."
            )
            if unmapped:
                reason += " Unmapped categories: " + ", ".join(unmapped) + "."
            return evaluation_result(
                request,
                "uncertain",
                request.content,
                reason=reason,
                usage=usage,
            )

        verdict = "unsafe" if assessment.verdict == "unsafe" else "uncertain"
        reason = (
            f"Safety Provider {assessment.provider_id} classified capability "
            f"{request.capability} as {assessment.verdict}; normalized to "
            + ", ".join(dict.fromkeys(item.taxonomy_id for item in findings))
            + "."
        )
        if unmapped:
            reason += " Some native categories were unmapped: " + ", ".join(unmapped) + "."

        content = request.content
        if (
            request.capability == "pii"
            and verdict == "unsafe"
            and request.proposed_action == "redact"
        ):
            # Generative classifiers do not return trustworthy character spans.
            # A semantic PII hit therefore redacts the complete evaluated block
            # instead of pretending to perform exact replacement.
            content = "[PII_REDACTED]"
            findings = tuple(
                replace(item, replacement="[PII_REDACTED]") for item in findings
            )
            reason += " The complete content block was conservatively redacted."

        return evaluation_result(
            request,
            verdict,  # type: ignore[arg-type]
            content,
            findings=findings,
            reason=reason,
            usage=usage,
        )

    async def _first_success(
        self,
        request: EvaluationRequest,
        messages: tuple[dict[str, str], ...],
        providers: tuple[SafetyModelProvider, ...],
        trackers: list[ModelCallTracker],
        errors: list[str],
    ) -> NativeSafetyAssessment | None:
        for provider in providers:
            result = await self._assess(
                request,
                messages,
                provider,
                (),
                trackers,
                errors,
            )
            if result is not None:
                return result
        return None

    async def _assess(
        self,
        request: EvaluationRequest,
        messages: tuple[dict[str, str], ...],
        provider: SafetyModelProvider,
        candidates: tuple[str, ...],
        trackers: list[ModelCallTracker],
        errors: list[str],
    ) -> NativeSafetyAssessment | None:
        tracker: ModelCallTracker | None = None
        try:
            with observe_model_call(
                request,
                provider=provider.config.id,
                model=provider.config.model,
                operation=(
                    f"{provider.config.adapter}_{request.capability}_"
                    f"{request.rail_type}_classification"
                ),
                profile_ref=provider.config.profile_ref or None,
                runtime_ref=provider.config.runtime_ref or None,
            ) as tracker:
                result = await provider.assess(
                    messages,
                    scope=request.rail_type,
                    candidate_taxonomy_ids=candidates,
                )
                tracker.complete(payload=result.payload)
                return result
        except Exception as error:
            errors.append(f"{provider.config.id}: {type(error).__name__}")
            return None
        finally:
            if tracker is not None:
                trackers.append(tracker)

    async def _canonical_findings(
        self,
        request: EvaluationRequest,
        messages: tuple[dict[str, str], ...],
        assessment: NativeSafetyAssessment,
        trackers: list[ModelCallTracker],
        errors: list[str],
    ) -> tuple[tuple[RiskFinding, ...], tuple[str, ...], tuple[str, ...]]:
        # Some native safety models return only an authoritative unsafe label.
        # Preserve that enforcement signal with the product-owned capability
        # fallback instead of converting a valid provider response into an
        # adapter error merely because the optional category line is absent.
        if assessment.verdict == "unsafe" and not assessment.categories:
            return (
                (
                    _finding(
                        request,
                        assessment,
                        taxonomy_for_evaluator(request.capability),
                        native_category="unspecified",
                        mapping_quality="partial",
                    ),
                ),
                (),
                (),
            )
        if assessment.canonical_categories:
            applicable = tuple(
                category_id
                for category_id in assessment.categories
                if _category_applies(request.capability, category_id)
            )
            irrelevant = tuple(
                category_id
                for category_id in assessment.categories
                if category_id not in applicable
            )
            return (
                tuple(
                    _finding(
                        request,
                        assessment,
                        category_id,
                        native_category=category_id,
                        mapping_quality="direct",
                    )
                    for category_id in applicable
                ),
                (),
                irrelevant,
            )

        mapped: list[tuple[str, ProviderCategoryMapping]] = []
        unmapped: list[str] = []
        irrelevant: list[str] = []
        for native_category in assessment.categories:
            mapping = provider_mapping(assessment.adapter, native_category)
            if mapping is None:
                unmapped.append(native_category)
            elif not _category_applies(request.capability, mapping.taxonomy_id):
                irrelevant.append(native_category)
            else:
                mapped.append((native_category, mapping))

        findings: list[RiskFinding] = []
        for native_category, mapping in mapped:
            refined = await self._refine(
                request,
                messages,
                assessment,
                native_category,
                mapping,
                trackers,
                errors,
            )
            findings.extend(
                refined
                or (
                    _finding(
                        request,
                        assessment,
                        mapping.taxonomy_id,
                        native_category=native_category,
                        mapping_quality=mapping.quality,
                    ),
                )
            )
        return (
            tuple(_deduplicate_findings(findings)),
            tuple(unmapped),
            tuple(irrelevant),
        )

    async def _refine(
        self,
        request: EvaluationRequest,
        messages: tuple[dict[str, str], ...],
        assessment: NativeSafetyAssessment,
        native_category: str,
        mapping: ProviderCategoryMapping,
        trackers: list[ModelCallTracker],
        errors: list[str],
    ) -> tuple[RiskFinding, ...]:
        if (
            assessment.verdict != "unsafe"
            or not mapping.requires_refinement
            or self._judge is None
        ):
            return ()
        candidates = _refinement_candidates(request, mapping.taxonomy_id)
        if not candidates:
            return ()
        refined = await self._assess(
            request,
            messages,
            self._judge,
            candidates,
            trackers,
            errors,
        )
        if refined is None or refined.verdict != "unsafe":
            return ()
        guard_evidence = ProviderEvidence(
            provider_id=assessment.provider_id,
            model=assessment.model,
            native_verdict=assessment.verdict,
            native_category=native_category,
            mapping_quality=mapping.quality,
        )
        registry = taxonomy()
        return tuple(
            _finding(
                request,
                refined,
                category_id,
                native_category=category_id,
                mapping_quality="direct",
                additional_evidence=(guard_evidence,),
            )
            for category_id in refined.categories
            if (
                category_id == mapping.taxonomy_id
                or registry.is_descendant(category_id, mapping.taxonomy_id)
            )
            and _category_applies(request.capability, category_id)
        )


def _assessment_messages(
    request: EvaluationRequest,
) -> tuple[dict[str, str], ...]:
    messages: list[dict[str, str]] = []
    for item in request.context_messages[-12:]:
        role = str(item.get("role", ""))
        content = item.get("content")
        if role in {"user", "assistant"} and isinstance(content, str) and content.strip():
            messages.append({"role": role, "content": content})
    target_role = "user" if request.rail_type == "input" else "assistant"
    if not (
        messages
        and messages[-1]["role"] == target_role
        and messages[-1]["content"] == request.content
    ):
        messages.append({"role": target_role, "content": request.content})
    return tuple(messages)


def _category_applies(capability: str, category_id: str) -> bool:
    if capability == "content_safety":
        return True
    if capability == "jailbreak":
        return category_id == "TALI-MODEL-SECURITY-JAILBREAK"
    if capability == "pii":
        return category_id in {"TALI-PRIVACY", "TALI-PRIVACY-PII"}
    return False


def _refinement_candidates(
    request: EvaluationRequest,
    taxonomy_id: str,
) -> tuple[str, ...]:
    registry = taxonomy()
    if request.capability == "pii" and taxonomy_id == "TALI-PRIVACY":
        return ("TALI-PRIVACY-PII",)
    return tuple(
        item.id
        for item in registry.descendants(taxonomy_id)
        if not registry.children(item.id) and request.rail_type in item.scopes
    )


def _finding(
    request: EvaluationRequest,
    assessment: NativeSafetyAssessment,
    taxonomy_id: str,
    *,
    native_category: str,
    mapping_quality: str,
    additional_evidence: tuple[ProviderEvidence, ...] = (),
) -> RiskFinding:
    taxonomy().get(taxonomy_id)
    evidence = assessment.reason or (
        f"{assessment.provider_id} returned {assessment.verdict} / {native_category}."
    )
    return RiskFinding(
        risk=request.capability,
        taxonomy_id=taxonomy_id,
        verdict="unsafe" if assessment.verdict == "unsafe" else "uncertain",
        confidence=None,
        evidence=evidence,
        recommended_action=request.proposed_action,
        provider_evidence=(
            *additional_evidence,
            ProviderEvidence(
                provider_id=assessment.provider_id,
                model=assessment.model,
                native_verdict=assessment.verdict,
                native_category=native_category,
                mapping_quality=mapping_quality,
            ),
        ),
    )


def _deduplicate_findings(
    findings: Iterable[RiskFinding],
) -> tuple[RiskFinding, ...]:
    output: dict[str, RiskFinding] = {}
    for finding in findings:
        output.setdefault(finding.taxonomy_id, finding)
    return tuple(output.values())


def _combined_usage(
    trackers: Iterable[ModelCallTracker],
    input_characters: int,
) -> EvaluationUsage:
    calls = tuple(item.usage for item in trackers)
    return EvaluationUsage(
        provider_latency_ms=sum(item.duration_ms for item in calls),
        model_invocations=len(calls),
        input_characters=max(0, input_characters),
        model_calls=calls,
    )
