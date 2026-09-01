"""Stable product evaluation contracts.

Contracts describe the evidence a Guardrail policy requires. They do not name
an implementation, provider, protocol adapter, or physical model endpoint.
"""

from __future__ import annotations


CONTRACT_SECRETS_EXACT = "tali.guard.secrets.exact.v1"
CONTRACT_PII_EXACT = "tali.guard.pii.exact.v1"
CONTRACT_PII_SEMANTIC = "tali.guard.pii.semantic.v1"
CONTRACT_CONTENT_FILTER = "tali.guard.content-filter.rules.v1"
CONTRACT_PROMPT_INJECTION = "tali.guard.prompt-injection.v1"
CONTRACT_INDIRECT_PROMPT_INJECTION = "tali.guard.indirect-prompt-injection.v1"
CONTRACT_JAILBREAK = "tali.guard.jailbreak.v1"
CONTRACT_SYSTEM_PROMPT_LEAKAGE = "tali.guard.system-prompt-leakage.v1"
CONTRACT_CONTENT_SAFETY = "tali.guard.content-safety.v1"
CONTRACT_TOPIC_RULES = "tali.guard.topic-control.rules.v1"
CONTRACT_TOPIC_SEMANTIC = "tali.guard.topic-control.semantic.v1"
CONTRACT_COMPANY_POLICY = "tali.guard.company-policy.v1"
CONTRACT_CONTEXTUAL_GROUNDING = "tali.guard.contextual-grounding.v1"
CONTRACT_AUTOMATED_REASONING = "tali.guard.automated-reasoning.v1"
CONTRACT_TAXONOMY_NORMALIZATION = "tali.guard.taxonomy-normalization.v1"


MODEL_SAFETY_CONTRACT_BY_CAPABILITY = {
    "pii": CONTRACT_PII_SEMANTIC,
    "content_safety": CONTRACT_CONTENT_SAFETY,
    "jailbreak": CONTRACT_JAILBREAK,
}
MODEL_SAFETY_CAPABILITY_BY_CONTRACT = {
    contract: capability
    for capability, contract in MODEL_SAFETY_CONTRACT_BY_CAPABILITY.items()
}


__all__ = [name for name in globals() if name.startswith("CONTRACT_")] + [
    "MODEL_SAFETY_CONTRACT_BY_CAPABILITY",
    "MODEL_SAFETY_CAPABILITY_BY_CONTRACT",
]
