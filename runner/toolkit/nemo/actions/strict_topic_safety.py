from __future__ import annotations

from functools import wraps
from inspect import signature
from threading import Lock
from typing import Any


_INSTALL_LOCK = Lock()


class _StrictTopicControlModel:
    """Reject malformed classifier output before the official action can allow it."""

    def __init__(self, delegate: Any) -> None:
        self._delegate = delegate

    def __getattr__(self, name: str) -> Any:
        return getattr(self._delegate, name)

    async def generate_async(self, *args: Any, **kwargs: Any) -> Any:
        response = await self._delegate.generate_async(*args, **kwargs)
        content = getattr(response, "content", None)
        if not isinstance(content, str) or content.strip().casefold() not in {
            "on-topic",
            "off-topic",
        }:
            raise ValueError(
                "Topic Control model must return exactly 'on-topic' or 'off-topic'."
            )
        return response

    async def stream_async(self, *args: Any, **kwargs: Any):
        async for chunk in self._delegate.stream_async(*args, **kwargs):
            yield chunk

    @property
    def model_name(self) -> str:
        return self._delegate.model_name

    @property
    def provider_name(self) -> str | None:
        return self._delegate.provider_name

    @property
    def provider_url(self) -> str | None:
        return self._delegate.provider_url


def install_strict_topic_safety_action() -> None:
    """Harden NeMo's standard Topic Action without replacing its rail contract."""

    from nemoguardrails.library.topic_safety import actions

    with _INSTALL_LOCK:
        current = actions.topic_safety_check_input
        if getattr(current, "__tasklattice_strict_topic_safety__", False):
            return
        action_signature = signature(current)

        @wraps(current)
        async def strict_topic_safety_check_input(*args: Any, **kwargs: Any) -> Any:
            bound = action_signature.bind(*args, **kwargs)
            models = dict(bound.arguments["llms"])
            model_name = str(bound.arguments["model_name"])
            selected = models.get(model_name)
            if selected is not None:
                models[model_name] = _StrictTopicControlModel(selected)
            bound.arguments["llms"] = models
            return await current(*bound.args, **bound.kwargs)

        strict_topic_safety_check_input.__tasklattice_strict_topic_safety__ = True
        actions.topic_safety_check_input = strict_topic_safety_check_input
