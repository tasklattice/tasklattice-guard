"""Resolve classifier questions from the Policy package.

Every word a decision model is asked is Policy content: it is authored in
``policies/library/<policy>`` as the ``questions`` parameter and compiled into
this runner's built-in catalog. A published Guardrail carries the resolved value
in its plan, so online traffic is evaluated with exactly what the customer
published; capability probes, which have no published plan, fall back to the
compiled Policy default.

The Runner owns only *when* a question applies (Rail, primary vs gray-area
review, external or memory boundaries) and how to project it onto a provider's
wire contract. It owns no prompt text of its own.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from functools import lru_cache

import yaml

PROVIDERS = ("jev", "laya")
STAGES = ("primary", "review")
RAILS = ("input", "output")
_PLACEHOLDER = re.compile(r"\{([a-z][a-z0-9_]*)\}")

CAPABILITY_POLICY = {
    "pii": "pii-semantic",
    "content_safety": "content-safety-model",
    "jailbreak": "prompt-instruction-attacks",
    "topic_control": "business-topics",
    # The gray-area reviewer answers the canonical content-safety questions.
    "classifier_review": "content-safety-model",
}


class PromptDefinitionError(ValueError):
    """The request and the Policy catalog both lack a usable question set."""


@dataclass(frozen=True, slots=True)
class PolicyQuestion:
    id: str
    instructions: str | dict[str, str]
    criteria: dict[str, str] | None
    providers: dict[str, str]
    rails: tuple[str, ...]
    when: str | None


def _fail(message: str) -> PromptDefinitionError:
    return PromptDefinitionError(message)


def parse_questions(raw: str, *, owner: str) -> tuple[PolicyQuestion, ...]:
    """Validate the Policy-authored YAML. Unknown shapes fail closed."""
    try:
        rows = yaml.safe_load(raw)
    except yaml.YAMLError as error:
        raise _fail(f"{owner}: questions is not valid YAML ({error.__class__.__name__}).") from error
    if not isinstance(rows, list) or not rows:
        raise _fail(f"{owner}: questions must be a non-empty YAML list.")
    questions: list[PolicyQuestion] = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise _fail(f"{owner}: question #{index + 1} must be a mapping.")
        question_id = row.get("id")
        if not isinstance(question_id, str) or not question_id.strip():
            raise _fail(f"{owner}: question #{index + 1} needs a non-empty id.")
        instructions = row.get("instructions")
        if isinstance(instructions, dict):
            if not instructions or any(not isinstance(key, str) or not isinstance(value, str) or not value.strip()
                                       for key, value in instructions.items()):
                raise _fail(f"{owner}: question {question_id} instructions must map names to non-empty text.")
        elif not (isinstance(instructions, str) and instructions.strip()):
            raise _fail(f"{owner}: question {question_id} needs instructions text or a mapping.")
        criteria = row.get("criteria")
        if isinstance(criteria, dict):
            criteria = {("true" if key is True else "false" if key is False else key): value
                        for key, value in criteria.items()}
        if criteria is not None and (not isinstance(criteria, dict) or set(criteria) != {"true", "false"}
                                     or any(not isinstance(value, str) or not value.strip() for value in criteria.values())):
            raise _fail(f"{owner}: question {question_id} criteria must define exactly true and false.")
        rails = row.get("rails", list(RAILS))
        if not isinstance(rails, list) or not rails or any(rail not in RAILS for rail in rails):
            raise _fail(f"{owner}: question {question_id} rails must list input and/or output.")
        declared = row.get("providers", {provider: "both" for provider in PROVIDERS})
        if isinstance(declared, list):
            if any(provider not in PROVIDERS for provider in declared):
                raise _fail(f"{owner}: question {question_id} names an unknown provider.")
            declared = {provider: "both" for provider in declared}
        if not isinstance(declared, dict) or not declared:
            raise _fail(f"{owner}: question {question_id} providers must be a mapping or list.")
        for provider, stage in declared.items():
            if provider not in PROVIDERS or stage not in (*STAGES, "both"):
                raise _fail(f"{owner}: question {question_id} has an unknown provider stage {provider}:{stage}.")
        when = row.get("when")
        if when is not None and (not isinstance(when, str) or not when.strip()):
            raise _fail(f"{owner}: question {question_id} when must be a non-empty selector.")
        questions.append(PolicyQuestion(id=question_id, instructions=instructions,
                                       criteria=dict(criteria) if criteria else None,
                                       providers={str(key): str(value) for key, value in declared.items()},
                                       rails=tuple(rails), when=str(when) if when else None))
    return tuple(questions)


@lru_cache(maxsize=None)
def _policy_questions(policy_id: str | None) -> tuple[PolicyQuestion, ...]:
    """Compiled Policy default, with ``{{parameter}}`` references resolved."""
    if not policy_id:
        return ()
    # Only validation probes need the catalog. Serving frozen artifacts works without it.
    from ...policy_library.loader import load_builtin_policies

    for policy in load_builtin_policies():
        if policy.id != policy_id:
            continue
        defaults = {parameter.name: parameter.default or "" for parameter in policy.parameters}
        for rule in policy.rules:
            raw = (rule.detector_options or {}).get("questions")
            if not isinstance(raw, str) or not raw.strip():
                continue
            resolved = re.sub(r"\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}", lambda match: defaults.get(match.group(1), ""), raw)
            return parse_questions(resolved, owner=f"{policy.id}/{rule.id}")
    return ()


def policy_questions(policy_id: str | None, capability: str, parameters: tuple[tuple[str, str], ...], *,
                     purpose: str = "online") -> tuple[tuple[PolicyQuestion, ...], str]:
    """Return the question set the Runner must submit, plus its provenance."""
    supplied = dict(parameters).get("questions", "").strip()
    if supplied:
        return parse_questions(supplied, owner=f"{policy_id or capability} (published)"), "published-guardrail"
    compiled = _policy_questions(policy_id or CAPABILITY_POLICY.get(capability)) if purpose == "validation" else ()
    if not compiled:
        raise _fail("The published Guardrail carries no classifier questions; "
                    "republish the Policy version that authors them.")
    return compiled, "policy-default"


def _render(text: str, parameters: dict[str, str], rail: str) -> str:
    field = "current_output" if rail == "output" else "current_input"
    subject = "assistant output" if rail == "output" else "current input"
    values = {"field": field, "subject": subject, **parameters}

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        return values[name] if name in values else match.group(0)

    return _PLACEHOLDER.sub(replace, text)


def questions_for(request, *, provider: str, stage: str = "primary", when: str | None = None,
                  only: tuple[str, ...] | None = None) -> dict[str, dict[str, object]]:
    """Select, render and project the Policy questions for one provider call."""
    if provider not in PROVIDERS:
        raise _fail(f"Unknown classifier provider {provider}.")
    definition, _source = policy_questions(request.policy_id, request.capability, request.parameters,
                                          purpose=request.execution_purpose)
    parameters = dict(request.parameters)
    rendered: dict[str, dict[str, object]] = {}
    for question in definition:
        if question.rails and request.rail_type not in question.rails:
            continue
        configured = question.providers.get(provider)
        if configured is None or (configured not in ("both", stage)):
            continue
        if when is not None and question.when is not None and question.when != when:
            continue
        if only is not None and question.id not in only:
            continue
        if question.id in rendered:
            raise _fail(f"Question {question.id} is declared twice for {provider}/{stage}/{request.rail_type}.")
        if isinstance(question.instructions, dict):
            if provider == "laya" and stage == "primary":
                raise _fail(f"Question {question.id} uses mapping instructions, which the Laya primary "
                            "encoder rejects; author a 'laya: primary' variant.")
            payload: dict[str, object] = {"type": "noul", "instructions": {
                name: _render(text, parameters, request.rail_type) for name, text in question.instructions.items()}}
        else:
            payload = {"type": "noul", "instructions": _render(question.instructions, parameters, request.rail_type)}
        if question.criteria:
            payload["criteria"] = {name: _render(text, parameters, request.rail_type)
                                   for name, text in question.criteria.items()}
        rendered[question.id] = payload
    return rendered


def definition_provenance(request, *, provider: str) -> dict[str, object]:
    """Evidence fields: where the questions came from and their content hash."""
    try:
        definition, source = policy_questions(request.policy_id, request.capability, request.parameters,
                                              purpose=request.execution_purpose)
        canonical = json.dumps([[question.id, question.instructions, question.criteria, sorted(question.providers.items()),
                                 list(question.rails), question.when] for question in definition],
                               sort_keys=True, ensure_ascii=False)
        return {"definition_source": source,
                "definition_sha256": hashlib.sha256(canonical.encode()).hexdigest(),
                "definition_revision": f"{request.capability}:{provider}:{hashlib.sha256(canonical.encode()).hexdigest()[:12]}"}
    except Exception:  # evidence is advisory; a decision never fails because it cannot be described
        return {}


def definition_revision(request, *, provider: str) -> str:
    provenance = definition_provenance(request, provider=provider)
    return str(provenance.get("definition_revision") or f"{request.capability}:{provider}:unknown")
