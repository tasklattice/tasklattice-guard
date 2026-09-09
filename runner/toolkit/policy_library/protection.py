"""Business ownership and runtime requirements from the shared catalog contract."""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from .domain import PolicySpec


@lru_cache(maxsize=1)
def protection_contracts() -> dict:
    return json.loads((Path(__file__).parent / "assets" / "protection-contracts.json").read_text())


def policy_protection(item: PolicySpec) -> dict:
    contracts = protection_contracts()
    directories = [tag.value for tag in item.tags if tag.namespace == "protection"]
    if len(directories) != 1 or directories[0] not in contracts["directories"]:
        raise ValueError(f"Policy {item.id} must declare exactly one valid protection directory.")
    directory = directories[0]
    native = contracts["nativePolicies"].get(item.id, {})
    if native and set(item.rails).difference(native["rails"]):
        raise ValueError(f"Policy {item.id} declares a Rail outside its runtime contract.")
    execution = native.get("execution", "custom" if "colang_flow" in item.forms else "local")
    limitations = []
    if execution == "local":
        limitations.append("Matches configured local patterns; it does not provide comprehensive semantic detection.")
    if native.get("modelCapabilities"):
        limitations.append("Requires a compatible, validated runtime assignment; model callability alone is not validation.")
    if item.id == "builtin-content-safety":
        limitations.append("Incremental checks cannot recall previously released text. Transforming actions require a complete response.")
    if directory == "business_rules":
        limitations.append("Screens text against configured business rules; it does not establish regulatory compliance or authorize actions.")
    if directory == "application_injection":
        limitations.append("Content screening does not replace parameterized queries, output encoding, sandboxing or tool authorization.")
    return {
        "directory": directory,
        "execution": execution,
        "modelCapabilities": native.get("modelCapabilities", []),
        "requiredContext": native.get("requiredContext", []),
        "outputStreaming": "not_applicable" if "output" not in item.rails else native.get("outputStreaming", "complete_response"),
        "limitations": limitations,
    }
