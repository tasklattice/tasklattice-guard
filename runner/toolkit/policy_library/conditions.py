"""Bounded text predicates and literal parameter expansion; no business vocabulary."""
from __future__ import annotations

import re
import unicodedata
from itertools import product
from typing import Any, Mapping

from .matching import keyword_expression


def resolve_terms(value: Any, parameters: Mapping[str, str]) -> tuple[str, ...]:
    if isinstance(value, list):
        return tuple(term for item in value for term in resolve_terms(item, parameters))
    if isinstance(value, str):
        reference = re.fullmatch(r"\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}", value)
        if reference:
            return tuple(x.strip() for x in re.split(r"[\n,]", parameters.get(reference[1], "")) if x.strip())
        rendered = value
        for key, replacement in parameters.items():
            rendered = rendered.replace("{{" + key + "}}", replacement)
        return (rendered,) if rendered.strip() else ()
    terms = resolve_terms("{{" + value["parameter"] + "}}", parameters)
    if value.get("strip_suffix"):
        terms = tuple(stripped for term in terms
                      if (stripped := re.sub(value["strip_suffix"], "", term, flags=re.I)).strip()
                      and (not value.get("changed_only") or stripped != term))
    if "templates" in value:
        terms = tuple(rendered for term, template in product(terms, value["templates"])
                      for rendered in resolve_terms(template.replace("{{item}}", term), parameters))
    return terms


def validate_terms(value: Any) -> None:
    if isinstance(value, str):
        return
    if isinstance(value, list):
        if len(value) > 10000:
            raise ValueError("Too many matching terms")
        for item in value:
            validate_terms(item)
        return
    if not isinstance(value, dict) or not isinstance(value.get("parameter"), str):
        raise ValueError("Matching terms require strings or a parameter reference")
    if set(value) - {"parameter", "templates", "strip_suffix", "changed_only"}:
        raise ValueError("Unknown term expansion option")
    if "templates" in value and (not isinstance(value["templates"], list) or not all(isinstance(x, str) for x in value["templates"])):
        raise ValueError("Term templates must be strings")
    if "strip_suffix" in value:
        re.compile(value["strip_suffix"])
    if "changed_only" in value and type(value["changed_only"]) is not bool:
        raise ValueError("changed_only must be boolean")


def validate_conditions(options: dict[str, Any]) -> None:
    if set(options) - {"match", "normalization"} or "match" not in options:
        raise ValueError("Conditions require match and optional normalization")
    normalization = options.get("normalization", {})
    if not isinstance(normalization, dict) or set(normalization) - {"nfkc", "remove", "translate", "collapse_whitespace"}:
        raise ValueError("Unknown normalization option")
    for key in ("nfkc", "collapse_whitespace"):
        if key in normalization and type(normalization[key]) is not bool:
            raise ValueError(f"{key} must be boolean")
    if "remove" in normalization:
        re.compile(normalization["remove"])
    mapping = normalization.get("translate", {})
    if not isinstance(mapping, dict) or any(not isinstance(k, str) or len(k) != 1 or not isinstance(v, str) for k, v in mapping.items()):
        raise ValueError("Invalid normalization translation")
    count = 0
    def visit(node: Any, depth: int = 0) -> None:
        nonlocal count
        count += 1
        if depth > 12 or count > 256:
            raise ValueError("Matching condition exceeds complexity limits")
        if not isinstance(node, dict) or len(node) != 1:
            raise ValueError("A matching condition requires exactly one operator")
        op, value = next(iter(node.items()))
        if op in {"any", "all"}:
            if not isinstance(value, list) or not value:
                raise ValueError(f"{op} requires nonempty conditions")
            for child in value:
                visit(child, depth + 1)
        elif op in {"not", "within_sentence"}:
            visit(value, depth + 1)
        elif op in {"keywords", "contains", "words"}:
            validate_terms(value)
        elif op == "parameter_in":
            if not isinstance(value, dict) or set(value) - {"name", "values", "default"} or not isinstance(value.get("name"), str):
                raise ValueError("Invalid parameter condition")
            if not isinstance(value.get("values"), list) or not all(isinstance(x, str) for x in value["values"]) or not isinstance(value.get("default", ""), str):
                raise ValueError("Parameter condition values must be strings")
        elif op == "regex":
            if not isinstance(value, str):
                raise ValueError("regex condition requires a string")
            re.compile(value)
        else:
            raise ValueError(f"Unknown matching condition {op!r}")
    visit(options["match"])


def evaluate_conditions(options: dict[str, Any], text: str, parameters: Mapping[str, str]):
    from .detectors import DetectionMatch
    normalization = options.get("normalization", {})
    def normalize(value: str, *, trim: bool = True) -> str:
        if normalization.get("remove"):
            value = re.sub(normalization["remove"], "", value)
        if normalization.get("nfkc"):
            value = unicodedata.normalize("NFKC", value)
        value = value.lower()
        if normalization.get("translate"):
            value = value.translate(str.maketrans(normalization["translate"]))
        if normalization.get("collapse_whitespace"):
            value = re.sub(r"\s+", " ", value)
            if trim:
                value = value.strip()
        return value
    checked = normalize(text) if normalization else text
    def evaluate(node: dict, content: str):
        op, value = next(iter(node.items()))
        if op == "any":
            return next((result for child in value if (result := evaluate(child, content)) is not None), None)
        if op == "all":
            results = [evaluate(child, content) for child in value]
            if any(result is None for result in results):
                return None
            return DetectionMatch(" + ".join(r.evidence for r in results), tuple(span for r in results for span in r.spans))
        if op == "not":
            return DetectionMatch("exclusion satisfied") if evaluate(value, content) is None else None
        if op == "within_sentence":
            for sentence in re.finditer(r"[^.!?]+", content):
                result = evaluate(value, sentence.group())
                if result is not None:
                    return DetectionMatch(result.evidence, tuple((a+sentence.start(), b+sentence.start()) for a,b in result.spans))
            return None
        if op == "parameter_in":
            configured = parameters.get(value["name"], "").strip().lower() or value.get("default", "")
            return DetectionMatch("parameter condition satisfied") if configured in value["values"] else None
        terms = (value,) if op == "regex" else resolve_terms(value, parameters)
        for term in terms:
            if op != "regex" and normalization:
                term = normalize(term, trim=False)
            expression = (term if op == "regex" else keyword_expression(term) if op == "keywords"
                          else r"\b" + re.escape(term) + r"\b" if op == "words" else re.escape(term))
            found = re.search(expression, content, re.I)
            if found:
                return DetectionMatch(found.group(), ((found.start(), found.end()),))
        return None
    result = evaluate(options["match"], checked)
    # Normalization can change offsets. Do not report invalid spans into original text.
    return DetectionMatch(result.evidence) if result is not None and checked != text else result
