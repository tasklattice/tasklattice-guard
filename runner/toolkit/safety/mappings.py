from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .taxonomy import taxonomy


MappingQuality = Literal["direct", "parent", "partial"]


@dataclass(frozen=True, slots=True)
class ProviderCategoryMapping:
    native_category: str
    taxonomy_id: str
    quality: MappingQuality
    requires_refinement: bool = False


def _normalized(value: str) -> str:
    return " ".join(value.replace("_", " ").replace("-", " ").casefold().split())


_QWEN3GUARD = (
    ProviderCategoryMapping("Violent", "TALI-PHYSICAL-HARM", "parent", True),
    ProviderCategoryMapping("Non-violent Illegal Acts", "TALI-ILLEGAL-ACTIVITY", "parent", True),
    ProviderCategoryMapping("Sexual Content or Sexual Acts", "TALI-SEXUAL-SAFETY", "parent", True),
    ProviderCategoryMapping("PII", "TALI-PRIVACY", "parent", True),
    ProviderCategoryMapping("Personally Identifiable Information", "TALI-PRIVACY", "parent", True),
    ProviderCategoryMapping("Suicide & Self-Harm", "TALI-SELF-HARM", "direct"),
    ProviderCategoryMapping("Unethical Acts", "TALI-SOCIAL-HARM", "partial", True),
    ProviderCategoryMapping("Politically Sensitive Topics", "TALI-CIVIC-INTEGRITY-POLITICAL-MISINFORMATION", "direct"),
    ProviderCategoryMapping("Copyright Violation", "TALI-INTELLECTUAL-PROPERTY-COPYRIGHT", "direct"),
    ProviderCategoryMapping("Jailbreak", "TALI-MODEL-SECURITY-JAILBREAK", "direct"),
)

_LLAMA_GUARD_3 = (
    ProviderCategoryMapping("S1", "TALI-PHYSICAL-HARM-VIOLENT-CRIME", "direct"),
    ProviderCategoryMapping("S2", "TALI-ILLEGAL-ACTIVITY", "parent", True),
    ProviderCategoryMapping("S3", "TALI-SEXUAL-SAFETY-CRIME", "direct"),
    ProviderCategoryMapping("S4", "TALI-SEXUAL-SAFETY-CHILD-EXPLOITATION", "direct"),
    ProviderCategoryMapping("S5", "TALI-SOCIAL-HARM-DEFAMATION", "direct"),
    ProviderCategoryMapping("S6", "TALI-PROFESSIONAL-ADVICE", "parent", True),
    ProviderCategoryMapping("S7", "TALI-PRIVACY", "parent", True),
    ProviderCategoryMapping("S8", "TALI-INTELLECTUAL-PROPERTY", "parent", True),
    ProviderCategoryMapping("S9", "TALI-PHYSICAL-HARM-INDISCRIMINATE-WEAPONS", "direct"),
    ProviderCategoryMapping("S10", "TALI-SOCIAL-HARM-HATE", "direct"),
    ProviderCategoryMapping("S11", "TALI-SELF-HARM", "direct"),
    ProviderCategoryMapping("S12", "TALI-SEXUAL-SAFETY-CONTENT", "direct"),
    ProviderCategoryMapping("S13", "TALI-CIVIC-INTEGRITY-ELECTIONS", "direct"),
    ProviderCategoryMapping("S14", "TALI-TOOL-SECURITY-CODE-INTERPRETER-ABUSE", "direct"),
)

_NEMOTRON_CONTENT_SAFETY = (
    ProviderCategoryMapping("Violence", "TALI-PHYSICAL-HARM", "parent", True),
    ProviderCategoryMapping("Criminal Planning/Confessions", "TALI-ILLEGAL-ACTIVITY", "parent", True),
    ProviderCategoryMapping("Guns and Illegal Weapons", "TALI-PHYSICAL-HARM-WEAPONS", "direct"),
    ProviderCategoryMapping("Controlled/Regulated Substances", "TALI-ILLEGAL-ACTIVITY-DRUGS", "direct"),
    ProviderCategoryMapping("Sexual", "TALI-SEXUAL-SAFETY-CONTENT", "direct"),
    ProviderCategoryMapping("Sexual (minor)", "TALI-SEXUAL-SAFETY-CHILD-EXPLOITATION", "direct"),
    ProviderCategoryMapping("Suicide and Self Harm", "TALI-SELF-HARM", "direct"),
    ProviderCategoryMapping("Hate/Identity Hate", "TALI-SOCIAL-HARM-HATE", "direct"),
    ProviderCategoryMapping("PII/Privacy", "TALI-PRIVACY", "parent", True),
    ProviderCategoryMapping("Harassment", "TALI-SOCIAL-HARM-HARASSMENT", "direct"),
    ProviderCategoryMapping("Threat", "TALI-SOCIAL-HARM-THREAT", "direct"),
    ProviderCategoryMapping("Profanity", "TALI-SOCIAL-HARM-HARASSMENT", "partial"),
    ProviderCategoryMapping("Fraud/Deception", "TALI-ILLEGAL-ACTIVITY-FRAUD", "direct"),
    ProviderCategoryMapping("Malware", "TALI-ILLEGAL-ACTIVITY-CYBER", "direct"),
    ProviderCategoryMapping("Political/Misinformation/Conspiracy", "TALI-CIVIC-INTEGRITY-POLITICAL-MISINFORMATION", "direct"),
    ProviderCategoryMapping("Copyright/Trademark/Plagiarism", "TALI-INTELLECTUAL-PROPERTY", "parent", True),
    ProviderCategoryMapping("Unauthorized Advice", "TALI-PROFESSIONAL-ADVICE", "parent", True),
    ProviderCategoryMapping("Illegal Activity", "TALI-ILLEGAL-ACTIVITY", "parent", True),
    ProviderCategoryMapping("Immoral/Unethical", "TALI-SOCIAL-HARM", "partial", True),
)

_MAPPINGS = {
    "qwen3guard": {_normalized(item.native_category): item for item in _QWEN3GUARD},
    "llama_guard_3": {_normalized(item.native_category): item for item in _LLAMA_GUARD_3},
    "nemotron_content_safety": {_normalized(item.native_category): item for item in _NEMOTRON_CONTENT_SAFETY},
    # Safety Guard v3 keeps NVIDIA's native category vocabulary while changing
    # the prompt and response envelope to strict JSON.
    "nemotron_safety_guard_v3": {
        _normalized(item.native_category): item
        for item in _NEMOTRON_CONTENT_SAFETY
    },
}


def provider_mapping(adapter: str, native_category: str) -> ProviderCategoryMapping | None:
    item = _MAPPINGS.get(adapter, {}).get(_normalized(native_category))
    if item is not None:
        taxonomy().get(item.taxonomy_id)
    return item


def mappings_for(adapter: str) -> tuple[ProviderCategoryMapping, ...]:
    return tuple(_MAPPINGS.get(adapter, {}).values())
