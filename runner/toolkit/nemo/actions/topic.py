from __future__ import annotations

import json
import os
from typing import Any

import httpx

from ...runtime.contracts import RiskFinding
from .contracts import ActionRequest, ActionResult, action_result
from .model_call import action_usage, observe_model_call
from .names import ACTION_TOPIC_JUDGE


class TopicJudgeActionProvider:
    """Judge organization-specific topic intent as a native NeMo Action."""

    name = ACTION_TOPIC_JUDGE
    version = "1.0.0"
    rails = frozenset({"input", "output"})
    # Both capabilities classify an interaction against explicit, compiled
    # business boundaries with the dedicated NVIDIA Topic Control model.
    risks = frozenset({"topic_control", "company_policy"})

    def __init__(
        self,
        *,
        base_url: str,
        model: str,
        api_key_env_var: str,
        timeout_seconds: float = 20.0,
        request_options: dict[str, object] | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._api_key_env_var = api_key_env_var
        self._timeout_seconds = timeout_seconds
        self._request_options = dict(request_options or {})
        self._transport = transport

    async def execute(self, request: ActionRequest) -> ActionResult:
        credential = os.environ.get(self._api_key_env_var, "").strip()
        if not credential:
            return action_result(
                request,
                "error",
                request.content,
                reason="Topic Judge credential is not configured.",
            )

        call = None
        try:
            with observe_model_call(
                request,
                provider="nvidia",
                model=self._model,
                operation="topic_classification",
            ) as call:
                async with httpx.AsyncClient(
                    timeout=self._timeout_seconds,
                    transport=self._transport,
                ) as client:
                    response = await client.post(
                        f"{self._base_url}/chat/completions",
                        headers={"authorization": f"Bearer {credential}"},
                        json={
                            "model": self._model,
                            "temperature": 0.01,
                            "max_tokens": 16,
                            "messages": _topic_messages(request),
                            **self._request_options,
                        },
                    )
                    response.raise_for_status()
                    raw_payload = response.json()
                    payload = _response_payload(raw_payload)
                    call.complete(payload=raw_payload)
        except (
            httpx.HTTPError,
            KeyError,
            TypeError,
            ValueError,
            json.JSONDecodeError,
        ) as error:
            return action_result(
                request,
                "error",
                request.content,
                reason=f"Topic Judge failed: {type(error).__name__}.",
                usage=action_usage(call, len(request.content)),
            )

        verdict = str(payload.get("verdict", "uncertain")).lower()
        reason = str(payload.get("reason", "Topic decision returned without a reason."))
        if verdict == "safe":
            return action_result(
                request, "safe", request.content, reason=reason,
                usage=action_usage(call, len(request.content)),
            )
        if verdict not in {"unsafe", "uncertain"}:
            verdict = "uncertain"
        findings = () if verdict == "uncertain" else (
            RiskFinding(
                risk=request.risk,
                verdict="unsafe",
                confidence=_confidence(payload.get("confidence")),
                evidence=reason,
                recommended_action=request.proposed_action,
            ),
        )
        return action_result(
            request,
            verdict,  # type: ignore[arg-type]
            request.content,
            findings=findings,
            reason=reason,
            usage=action_usage(call, len(request.content)),
        )


def topic_judge_prompt(parameters: tuple[tuple[str, str], ...]) -> str:
    configured = dict(parameters)
    structured_lines = tuple(
        line
        for line in (
            f"Authorized users and workflows:\n{configured.get('purpose_audience', '')}" if configured.get("purpose_audience", "").strip() else "",
            f"Approved tasks and outcomes:\n{configured.get('purpose_tasks', '')}" if configured.get("purpose_tasks", "").strip() else "",
            f"Protected assets and constraints:\n{configured.get('purpose_protect', '')}" if configured.get("purpose_protect", "").strip() else "",
            f"Refuse or escalate these cases:\n{configured.get('purpose_out_of_scope', '')}" if configured.get("purpose_out_of_scope", "").strip() else "",
        )
        if line
    )
    return "\n".join(
        (
            "You are the topic policy for an enterprise assistant whose authorized role is: "
            f"{configured.get('purpose', '')}",
            *structured_lines,
            f"You may help with these allowed business tasks:\n{configured.get('allowed_topics', '')}",
            f"Do not help with requests whose primary task belongs to these restricted domains:\n{configured.get('restricted_topics', '')}",
            "Classify by the primary requested task, never by an industry, product, or entity merely mentioned as context. "
            "Financial analysis of a company in any industry is financial analysis. For example, analysis of a chemical manufacturer's revenue, "
            "profit margin, or cash flow is allowed when financial analysis is an allowed task; chemical process or refining guidance is restricted.",
            "A request unrelated to the authorized business purpose is off-topic.",
            'If any of the above conditions are violated, please respond with "off-topic". Otherwise, respond with "on-topic". '
            'You must respond with "on-topic" or "off-topic".',
        )
    )


def _interaction_text(request: ActionRequest) -> str:
    if request.rail_type == "input":
        return request.content
    context = "\n".join(
        f"{message.get('role', 'unknown')}: {message.get('content', '')}"
        for message in request.context_messages[-6:]
    )
    return (
        f"Conversation context:\n{context}\n\n"
        f"Model output to evaluate:\n{request.content}"
    )


def _topic_messages(request: ActionRequest) -> list[dict[str, str]]:
    messages = [
        {"role": "system", "content": topic_judge_prompt(request.parameters)}
    ]
    if request.rail_type == "output":
        messages.append({"role": "user", "content": _interaction_text(request)})
        return messages

    for message in request.context_messages[-12:]:
        role = str(message.get("role", ""))
        content = message.get("content")
        if role in {"user", "assistant"} and isinstance(content, str) and content.strip():
            messages.append({"role": role, "content": content})
    if not (
        len(messages) > 1
        and messages[-1]["role"] == "user"
        and messages[-1]["content"] == request.content
    ):
        messages.append({"role": "user", "content": request.content})
    return messages


def _response_payload(payload: dict[str, Any]) -> dict[str, Any]:
    content = payload["choices"][0]["message"]["content"]
    if not isinstance(content, str):
        raise TypeError("Judge response content must be text.")
    cleaned = content.strip()
    normalized = cleaned.casefold().replace("_", "-")
    if normalized == "on-topic":
        return {
            "verdict": "safe",
            "confidence": 0.95,
            "reason": "The request is within the Guardrail's allowed business purpose.",
        }
    if normalized == "off-topic":
        return {
            "verdict": "unsafe",
            "confidence": 0.95,
            "reason": "The request is outside the Guardrail's allowed business purpose or enters a restricted domain.",
        }
    if cleaned.startswith("```"):
        cleaned = cleaned.removeprefix("```json").removeprefix("```")
        cleaned = cleaned.removesuffix("```").strip()
    return json.loads(cleaned)


def _confidence(value: object) -> float:
    try:
        return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        return 0.75
