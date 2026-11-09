from __future__ import annotations

import re


def keyword_expression(keyword: str) -> str:
    """Build the case-insensitive expression used by local keyword Rules."""

    escaped = re.escape(keyword).replace(r"\*", ".?")
    if " " in keyword:
        return escaped
    prefix = r"\b" if keyword and (keyword[0].isalnum() or keyword[0] == "_") else ""
    suffix = r"\b" if keyword and (keyword[-1].isalnum() or keyword[-1] == "_") else ""
    return f"{prefix}{escaped}{suffix}"


def severity_applies(severity: str, threshold: str) -> bool:
    """Return whether a Rule keyword meets its configured severity threshold."""

    order = {"low": 0, "medium": 1, "high": 2}
    return order.get(severity, 0) >= order.get(threshold, 1)
