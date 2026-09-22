from __future__ import annotations

from .domain import PolicyTag


OWASP_LLM_2025_FRAMEWORK_ID = "owasp-llm-2025"
OWASP_LLM_2025_FRAMEWORK_LABEL = "OWASP LLM 2025"

# Phase-one discovery mapping. These Policies provide a direct runtime control
# or a scoped compensating control for at least one OWASP Top 10 for LLM
# Applications 2025 risk. The framework tag is intentionally Policy-level: it
# helps users discover candidates without implying that every Rule in a Policy
# covers every OWASP risk.
OWASP_LLM_2025_POLICY_IDS = frozenset(
    {
        # LLM01 Prompt Injection and LLM07 System Prompt Leakage.
        "builtin-prompt-injection",
        "builtin-indirect-prompt-injection",
        "builtin-jailbreak",
        "builtin-system-prompt-leakage",
        "prompt-injection-protection",
        "filter-prompt-injection-jailbreak",
        "filter-prompt-injection-data-exfiltration",
        "filter-prompt-injection-system-prompt",
        "claims-agent-safety",
        # LLM02 Sensitive Information Disclosure.
        "builtin-secrets",
        "builtin-pii",
        "pattern-matching",
        "baseline-pii-protection",
        "advanced-au-pii-protection",
        "airline-passenger-data-protection-uae",
        "gdpr-eu-pii-protection",
        "pdpa-singapore",
        "uae-regulatory-compliance",
        "aviation-operations-security",
        # LLM05 Improper Output Handling.
        "filter-prompt-injection-sql",
        "filter-prompt-injection-malicious-code",
        "block-code-execution",
        # Scoped runtime assurance for LLM09 Misinformation.
        "builtin-contextual-grounding",
        "builtin-automated-reasoning",
    }
)


def framework_tags_for_policy(policy_id: str) -> tuple[PolicyTag, ...]:
    """Return centrally reviewed framework-discovery tags for one Policy."""

    if policy_id not in OWASP_LLM_2025_POLICY_IDS:
        return ()
    return (
        PolicyTag(
            namespace="framework",
            value=OWASP_LLM_2025_FRAMEWORK_ID,
            label=OWASP_LLM_2025_FRAMEWORK_LABEL,
            source="declared",
        ),
    )
