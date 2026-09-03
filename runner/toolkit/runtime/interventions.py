"""Deterministic replacement text for interventions without a supplied value."""


def fallback_content(action: str, text: str) -> str:
    return {
        "clarify": "More information is required before the request can be evaluated safely.",
        "redirect": "I can help with topics inside this assistant's approved purpose.",
        "regenerate": "The response was withheld and should be regenerated under the active Guardrail.",
        "rewrite": "The response was rewritten to comply with the active Guardrail.",
        "fallback": "A safe fallback response was selected by the active Guardrail.",
    }.get(action, text)
