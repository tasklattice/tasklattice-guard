from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass
from functools import lru_cache
from typing import Literal


TALI_TAXONOMY_ID = "tali-safety"
TALI_TAXONOMY_VERSION = "0.1.0"
TaxonomyScope = Literal["input", "output", "retrieval", "tool_call"]
_ID = re.compile(r"^TALI(?:-[A-Z0-9]+)+$")


@dataclass(frozen=True, slots=True)
class TaxonomyCategory:
    """One immutable semantic category owned by TaskLattice, not a model vendor."""

    id: str
    title: str
    definition: str
    parent_id: str | None = None
    scopes: tuple[TaxonomyScope, ...] = ("input", "output")
    includes: tuple[str, ...] = ()
    excludes: tuple[str, ...] = ()


class TaxonomyRegistry:
    def __init__(
        self,
        categories: tuple[TaxonomyCategory, ...],
        *,
        taxonomy_id: str = TALI_TAXONOMY_ID,
        version: str = TALI_TAXONOMY_VERSION,
    ) -> None:
        if not categories:
            raise ValueError("A Taxonomy requires at least one category.")
        index: dict[str, TaxonomyCategory] = {}
        for item in categories:
            if not _ID.fullmatch(item.id):
                raise ValueError(f"Invalid TALI Taxonomy ID {item.id!r}.")
            if item.id in index:
                raise ValueError(f"Duplicate TALI Taxonomy ID {item.id!r}.")
            if not item.title.strip() or not item.definition.strip():
                raise ValueError(f"TALI Taxonomy category {item.id!r} is incomplete.")
            index[item.id] = item
        for item in categories:
            if item.parent_id is not None and item.parent_id not in index:
                raise ValueError(
                    f"TALI Taxonomy category {item.id!r} has unknown parent "
                    f"{item.parent_id!r}."
                )
            visited = {item.id}
            parent_id = item.parent_id
            while parent_id is not None:
                if parent_id in visited:
                    raise ValueError(f"TALI Taxonomy category {item.id!r} has a cycle.")
                visited.add(parent_id)
                parent_id = index[parent_id].parent_id
        self.id = taxonomy_id
        self.version = version
        self._categories = categories
        self._index = index
        canonical = json.dumps(
            [asdict(item) for item in categories],
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        self.checksum = hashlib.sha256(canonical.encode()).hexdigest()

    @property
    def categories(self) -> tuple[TaxonomyCategory, ...]:
        return self._categories

    def get(self, category_id: str) -> TaxonomyCategory:
        try:
            return self._index[category_id]
        except KeyError as error:
            raise KeyError(f"Unknown TALI Taxonomy category {category_id!r}.") from error

    def contains(self, category_id: str) -> bool:
        return category_id in self._index

    def children(self, category_id: str) -> tuple[TaxonomyCategory, ...]:
        self.get(category_id)
        return tuple(item for item in self._categories if item.parent_id == category_id)

    def descendants(self, category_id: str) -> tuple[TaxonomyCategory, ...]:
        pending = list(self.children(category_id))
        output: list[TaxonomyCategory] = []
        while pending:
            item = pending.pop(0)
            output.append(item)
            pending.extend(self.children(item.id))
        return tuple(output)

    def is_descendant(self, category_id: str, parent_id: str) -> bool:
        item = self.get(category_id)
        while item.parent_id is not None:
            if item.parent_id == parent_id:
                return True
            item = self.get(item.parent_id)
        return False


def _category(
    id: str,
    title: str,
    definition: str,
    *,
    parent: str | None = None,
    scopes: tuple[TaxonomyScope, ...] = ("input", "output"),
) -> TaxonomyCategory:
    return TaxonomyCategory(
        id=id,
        title=title,
        definition=definition,
        parent_id=parent,
        scopes=scopes,
    )


_CATEGORIES = (
    _category("TALI-PHYSICAL-HARM", "Physical harm", "Violence, violent crime, graphic violence, or weapons-related harm."),
    _category("TALI-PHYSICAL-HARM-VIOLENT-CRIME", "Violent crime", "Content that enables, encourages, or endorses violent crime.", parent="TALI-PHYSICAL-HARM"),
    _category("TALI-PHYSICAL-HARM-GRAPHIC-VIOLENCE", "Graphic violence", "Graphic depiction or glorification of severe physical violence.", parent="TALI-PHYSICAL-HARM"),
    _category("TALI-PHYSICAL-HARM-WEAPONS", "Weapons", "Instructions or assistance to manufacture, acquire, or use weapons for harm.", parent="TALI-PHYSICAL-HARM"),
    _category("TALI-PHYSICAL-HARM-INDISCRIMINATE-WEAPONS", "Indiscriminate weapons", "Weapons capable of indiscriminate or mass-casualty harm.", parent="TALI-PHYSICAL-HARM"),
    _category("TALI-ILLEGAL-ACTIVITY", "Illegal activity", "Assistance that materially enables non-violent illegal activity."),
    _category("TALI-ILLEGAL-ACTIVITY-CYBER", "Cyber abuse", "Unauthorized access, malware, credential theft, or other abusive cyber activity.", parent="TALI-ILLEGAL-ACTIVITY"),
    _category("TALI-ILLEGAL-ACTIVITY-FRAUD", "Fraud", "Fraud, scams, impersonation, money laundering, or financial deception.", parent="TALI-ILLEGAL-ACTIVITY"),
    _category("TALI-ILLEGAL-ACTIVITY-THEFT", "Theft", "Theft of property, services, identities, or protected information.", parent="TALI-ILLEGAL-ACTIVITY"),
    _category("TALI-ILLEGAL-ACTIVITY-DRUGS", "Illegal drugs", "Unauthorized production, acquisition, distribution, or use of regulated drugs.", parent="TALI-ILLEGAL-ACTIVITY"),
    _category("TALI-SEXUAL-SAFETY", "Sexual safety", "Sexual content, sexual crime, and sexual exploitation risks."),
    _category("TALI-SEXUAL-SAFETY-CONTENT", "Sexual content", "Explicit sexual imagery, descriptions, or acts.", parent="TALI-SEXUAL-SAFETY"),
    _category("TALI-SEXUAL-SAFETY-CRIME", "Sex-related crime", "Content that enables, encourages, or depicts non-consensual or illegal sexual acts.", parent="TALI-SEXUAL-SAFETY"),
    _category("TALI-SEXUAL-SAFETY-CHILD-EXPLOITATION", "Child sexual exploitation", "Any sexual exploitation or sexualized content involving minors.", parent="TALI-SEXUAL-SAFETY"),
    _category("TALI-PRIVACY", "Privacy", "Unauthorized collection, inference, disclosure, or transfer of private data."),
    _category("TALI-PRIVACY-PII", "Personally identifiable information", "Information that identifies or can be linked to a natural person.", parent="TALI-PRIVACY"),
    _category("TALI-PRIVACY-CREDENTIAL", "Credentials", "Passwords, tokens, private keys, authentication material, or account secrets.", parent="TALI-PRIVACY"),
    _category("TALI-PRIVACY-DOXXING", "Doxxing", "Malicious aggregation or disclosure of private identifying information.", parent="TALI-PRIVACY"),
    _category("TALI-PRIVACY-SENSITIVE-ATTRIBUTE", "Sensitive attributes", "Private or protected demographic, religious, political, disability, sexuality, or similar sensitive attributes.", parent="TALI-PRIVACY"),
    _category("TALI-PRIVACY-BIOMETRIC", "Biometric data", "Biometric identifiers, templates, or measurements used to recognize or profile a person.", parent="TALI-PRIVACY"),
    _category("TALI-PRIVACY-HEALTH", "Health data", "Private medical, diagnosis, treatment, or health-status information.", parent="TALI-PRIVACY"),
    _category("TALI-PRIVACY-FINANCIAL", "Financial data", "Private financial records, account data, payment data, or tax identifiers.", parent="TALI-PRIVACY"),
    _category("TALI-PRIVACY-DATA-EXFILTRATION", "Data exfiltration", "Unauthorized extraction or transfer of protected data.", parent="TALI-PRIVACY", scopes=("input", "output", "retrieval", "tool_call")),
    _category("TALI-SELF-HARM", "Suicide and self-harm", "Encouragement, instruction, or facilitation of suicide, self-harm, or dangerous self-injury."),
    _category("TALI-SELF-HARM-ENCOURAGEMENT", "Self-harm encouragement", "Content that advocates or encourages suicide or self-harm.", parent="TALI-SELF-HARM"),
    _category("TALI-SELF-HARM-INSTRUCTIONS", "Self-harm instructions", "Actionable methods or instructions for suicide or self-harm.", parent="TALI-SELF-HARM"),
    _category("TALI-SOCIAL-HARM", "Social and ethical harm", "Hate, discrimination, harassment, threats, defamation, or extremist harm."),
    _category("TALI-SOCIAL-HARM-HATE", "Hate", "Hateful or dehumanizing content targeting protected characteristics.", parent="TALI-SOCIAL-HARM"),
    _category("TALI-SOCIAL-HARM-DISCRIMINATION", "Discrimination", "Discriminatory treatment or stereotyping of people or groups.", parent="TALI-SOCIAL-HARM"),
    _category("TALI-SOCIAL-HARM-HARASSMENT", "Harassment", "Targeted harassment, abuse, intimidation, or severe insults.", parent="TALI-SOCIAL-HARM"),
    _category("TALI-SOCIAL-HARM-THREAT", "Threat", "Threats of harm, intimidation, or coercion.", parent="TALI-SOCIAL-HARM"),
    _category("TALI-SOCIAL-HARM-DEFAMATION", "Defamation", "Unsupported harmful factual claims about an identifiable person or organization.", parent="TALI-SOCIAL-HARM"),
    _category("TALI-SOCIAL-HARM-EXTREMISM", "Extremism", "Promotion, recruitment, or operational support for extremist organizations or ideologies.", parent="TALI-SOCIAL-HARM"),
    _category("TALI-PROFESSIONAL-ADVICE", "Specialized advice", "High-impact medical, legal, or financial guidance requiring contextual policy controls."),
    _category("TALI-PROFESSIONAL-ADVICE-MEDICAL", "Medical advice", "Diagnosis, treatment, or other consequential medical guidance.", parent="TALI-PROFESSIONAL-ADVICE"),
    _category("TALI-PROFESSIONAL-ADVICE-LEGAL", "Legal advice", "Consequential legal interpretation or personalized legal guidance.", parent="TALI-PROFESSIONAL-ADVICE"),
    _category("TALI-PROFESSIONAL-ADVICE-FINANCIAL", "Financial advice", "Consequential or personalized financial guidance.", parent="TALI-PROFESSIONAL-ADVICE"),
    _category("TALI-INTELLECTUAL-PROPERTY", "Intellectual property", "Unauthorized use or disclosure of protected intellectual property."),
    _category("TALI-INTELLECTUAL-PROPERTY-COPYRIGHT", "Copyright", "Unauthorized reproduction, distribution, display, or derivative use of copyrighted works.", parent="TALI-INTELLECTUAL-PROPERTY"),
    _category("TALI-CIVIC-INTEGRITY", "Civic integrity", "Election and political-information risks that can mislead the public."),
    _category("TALI-CIVIC-INTEGRITY-ELECTIONS", "Elections", "Misleading, suppressive, or harmful content about elections and voting.", parent="TALI-CIVIC-INTEGRITY"),
    _category("TALI-CIVIC-INTEGRITY-POLITICAL-MISINFORMATION", "Political misinformation", "Demonstrably false political information likely to cause public deception or harm.", parent="TALI-CIVIC-INTEGRITY"),
    _category("TALI-MODEL-SECURITY", "Model security", "Attacks against model instructions, policy controls, or protected prompts."),
    _category("TALI-MODEL-SECURITY-JAILBREAK", "Jailbreak", "Attempts to override or bypass model safety conditioning.", parent="TALI-MODEL-SECURITY", scopes=("input",)),
    _category("TALI-MODEL-SECURITY-PROMPT-INJECTION", "Prompt injection", "Untrusted instructions that attempt to override trusted instructions.", parent="TALI-MODEL-SECURITY", scopes=("input", "retrieval", "tool_call")),
    _category("TALI-MODEL-SECURITY-INDIRECT-PROMPT-INJECTION", "Indirect prompt injection", "Prompt injection embedded in retrieved data or tool output.", parent="TALI-MODEL-SECURITY", scopes=("retrieval", "tool_call")),
    _category("TALI-MODEL-SECURITY-PROMPT-LEAKAGE", "Prompt leakage", "Disclosure of protected system or developer instructions.", parent="TALI-MODEL-SECURITY", scopes=("output",)),
    _category("TALI-TOOL-SECURITY", "Tool security", "Unsafe, unauthorized, or abusive use of tools and execution environments.", scopes=("input", "output", "tool_call")),
    _category("TALI-TOOL-SECURITY-CODE-INTERPRETER-ABUSE", "Code interpreter abuse", "Abuse of a code interpreter to perform prohibited actions.", parent="TALI-TOOL-SECURITY", scopes=("input", "output", "tool_call")),
    _category("TALI-TOOL-SECURITY-UNAUTHORIZED-EXECUTION", "Unauthorized execution", "Execution attempted without sufficient authority or user approval.", parent="TALI-TOOL-SECURITY", scopes=("input", "output", "tool_call")),
    _category("TALI-BUSINESS-POLICY", "Business policy", "A product- or organization-specific policy boundary."),
    _category("TALI-BUSINESS-POLICY-OFF-TOPIC", "Off-topic business request", "A request outside the application's authorized business purpose.", parent="TALI-BUSINESS-POLICY"),
    _category("TALI-RESPONSE-INTEGRITY", "Response integrity", "Unsupported, irrelevant, or logically invalid model output.", scopes=("output",)),
    _category("TALI-RESPONSE-INTEGRITY-UNGROUNDED", "Ungrounded response", "A response whose material claims are unsupported by the supplied evidence.", parent="TALI-RESPONSE-INTEGRITY", scopes=("output",)),
)


@lru_cache(maxsize=1)
def taxonomy() -> TaxonomyRegistry:
    return TaxonomyRegistry(_CATEGORIES)


_EVALUATOR_DEFAULTS = {
    "secrets": "TALI-PRIVACY-CREDENTIAL",
    "pii": "TALI-PRIVACY-PII",
    "prompt_injection": "TALI-MODEL-SECURITY-PROMPT-INJECTION",
    "indirect_prompt_injection": "TALI-MODEL-SECURITY-INDIRECT-PROMPT-INJECTION",
    "jailbreak": "TALI-MODEL-SECURITY-JAILBREAK",
    "system_prompt_leakage": "TALI-MODEL-SECURITY-PROMPT-LEAKAGE",
    "topic_control": "TALI-BUSINESS-POLICY-OFF-TOPIC",
    "company_policy": "TALI-BUSINESS-POLICY",
    "contextual_grounding": "TALI-RESPONSE-INTEGRITY-UNGROUNDED",
    "automated_reasoning": "TALI-BUSINESS-POLICY",
    "builtin_content_filter": "TALI-BUSINESS-POLICY",
    "content_safety": "TALI-SOCIAL-HARM",
}


def taxonomy_for_evaluator(evaluator_id: str) -> str:
    """Return the narrowest safe fallback when an evaluator has no richer label."""

    return _EVALUATOR_DEFAULTS.get(evaluator_id, "TALI-BUSINESS-POLICY")
