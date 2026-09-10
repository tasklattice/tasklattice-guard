from __future__ import annotations

import asyncio
import hashlib
import json
import time
from dataclasses import asdict, dataclass, field, replace
from contextlib import asynccontextmanager
from typing import AsyncIterator, Awaitable, Callable, Protocol

from redis.asyncio import Redis
from redis.asyncio.lock import Lock

from runner.toolkit.runtime.contracts import (
    GuardContentBlock,
    OutputDeliveryMode,
    ProtectionDecision,
    ProtectionRequest,
    RequestContext,
)


StreamEvaluator = Callable[[ProtectionRequest], Awaitable[ProtectionDecision]]


class OutputStreamEvaluationError(RuntimeError):
    """A failed/invalid check is not a successful Policy rejection."""

    def __init__(self, message: str, *, timed_out: bool = False) -> None:
        super().__init__(message)
        self.timed_out = timed_out

# Checking ownership separately from SET leaves a lease-expiry race between the
# two commands. Commit the state and its idle TTL only while this token owns the
# lock, in one Redis operation. A stale evaluator must never overwrite a newer
# replica, even though releasing its expired lock would subsequently fail.
_COMMIT_OWNED_STREAM = """
if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('set', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 1
"""


class OutputStreamProcessor(Protocol):
    async def process(
        self,
        *,
        stream_key: str,
        sequence: int,
        text: str,
        final: bool,
        mode: OutputDeliveryMode,
        request: ProtectionRequest,
        evaluate: StreamEvaluator,
    ) -> "OutputStreamResult": ...


@dataclass(slots=True)
class OutputStreamResult:
    mode: OutputDeliveryMode
    status: str
    sequence: int
    next_sequence: int
    released_text: str
    terminate: bool
    final: bool
    decision: ProtectionDecision | None = None


@dataclass(slots=True)
class _OutputStreamSession:
    mode: OutputDeliveryMode
    request: ProtectionRequest
    next_sequence: int = 0
    all_text: str = ""
    pending_text: str = ""
    released_text: str = ""
    complete: bool = False
    expires_at: float = 0.0
    active_users: int = 0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class OutputStreamSessionStore:
    """Apply one pinned output-delivery state machine to ordered model chunks.

    Complete-response checks hold all text. Incremental checks evaluate accumulated
    context, retaining one window before release. The caller must await each result,
    forward only released_text, and cancel generation when terminate is true.
    """

    def __init__(
        self,
        *,
        window_characters: int = 2_048,
        max_characters: int = 1_000_000,
        ttl_seconds: float = 300.0,
        max_sessions: int = 10_000,
    ) -> None:
        if window_characters < 1 or max_characters < window_characters:
            raise ValueError("Output stream buffer limits are invalid.")
        self._window_characters = window_characters
        self._max_characters = max_characters
        self._ttl_seconds = ttl_seconds
        self._max_sessions = max_sessions
        self._sessions: dict[str, _OutputStreamSession] = {}
        self._index_lock = asyncio.Lock()

    async def process(
        self,
        *,
        stream_key: str,
        sequence: int,
        text: str,
        final: bool,
        mode: OutputDeliveryMode,
        request: ProtectionRequest,
        evaluate: StreamEvaluator,
    ) -> OutputStreamResult:
        async with self._session(stream_key, mode, request) as session, session.lock:
            _check_identity(session.request, request)
            if session.complete:
                raise ValueError("The output stream is already complete.")
            if sequence != session.next_sequence:
                raise ValueError(
                    f"Expected output stream sequence {session.next_sequence}, received {sequence}."
                )
            if mode != session.mode:
                raise ValueError("The Guardrail output-delivery mode changed during one stream.")
            if len(session.all_text) + len(text) > self._max_characters:
                session.complete = True
                raise ValueError("The output stream exceeded the configured maximum size.")

            # Work on a copy: a timeout/cancellation must not consume the sequence
            # or duplicate its text on retry. Redis uses this same transition.
            candidate = replace(session)
            result = await _advance(candidate, sequence, text, final, self._window_characters, evaluate)
            session.next_sequence = candidate.next_sequence
            session.all_text = candidate.all_text
            session.pending_text = candidate.pending_text
            session.released_text = candidate.released_text
            session.complete = candidate.complete
            session.expires_at = time.monotonic() + self._ttl_seconds
            return result

    @asynccontextmanager
    async def _session(
        self,
        key: str,
        mode: OutputDeliveryMode,
        request: ProtectionRequest,
    ) -> AsyncIterator[_OutputStreamSession]:
        async with self._index_lock:
            self._prune()
            session = self._sessions.get(key)
            if session is None:
                if len(self._sessions) >= self._max_sessions:
                    raise ValueError("Output stream capacity reached; retry after an existing stream expires.")
                session = _OutputStreamSession(
                    mode=mode,
                    request=request,
                    expires_at=time.monotonic() + self._ttl_seconds,
                )
                self._sessions[key] = session
            # Pin both the current evaluator and callers queued on its lock.
            # A TTL is an idle expiry, not permission to fork in-flight state.
            session.active_users += 1
        try:
            yield session
        finally:
            session.active_users -= 1

    def _prune(self) -> None:
        now = time.monotonic()
        for key, session in list(self._sessions.items()):
            if session.expires_at <= now and session.active_users == 0:
                self._sessions.pop(key, None)

    @staticmethod
    def _result(
        session: _OutputStreamSession,
        sequence: int,
        status: str,
        released_text: str,
        terminate: bool,
        final: bool,
        decision: ProtectionDecision | None = None,
    ) -> OutputStreamResult:
        return OutputStreamResult(
            mode=session.mode,
            status=status,
            sequence=sequence,
            next_sequence=session.next_sequence,
            released_text=released_text,
            terminate=terminate,
            final=final,
            decision=decision,
        )


class RedisOutputStreamSessionStore:
    """Share ordered output-stream buffers across horizontally scaled Runners."""

    def __init__(
        self,
        url: str,
        *,
        window_characters: int = 2_048,
        max_characters: int = 1_000_000,
        ttl_seconds: int = 300,
    ) -> None:
        if window_characters < 1 or max_characters < window_characters:
            raise ValueError("Output stream buffer limits are invalid.")
        self._redis: Redis = Redis.from_url(url, decode_responses=True)
        self._window_characters = window_characters
        self._max_characters = max_characters
        self._ttl_seconds = ttl_seconds

    async def process(
        self,
        *,
        stream_key: str,
        sequence: int,
        text: str,
        final: bool,
        mode: OutputDeliveryMode,
        request: ProtectionRequest,
        evaluate: StreamEvaluator,
    ) -> OutputStreamResult:
        key = self._key(stream_key)
        # Evaluation runs while the lock is held so two replicas cannot release
        # the same window or advance one stream out of order.
        async with self._redis.lock(
            f"{key}:lock",
            timeout=120,
            blocking_timeout=15,
            raise_on_release_error=False,
        ) as lock:
            raw = await self._redis.get(key)
            state = json.loads(raw) if isinstance(raw, str) else self._new_state(mode, request)
            _check_identity(_request_from_dict(state["request"]), request)
            if bool(state["complete"]):
                raise ValueError("The output stream is already complete.")
            expected = int(state["next_sequence"])
            if sequence != expected:
                raise ValueError(f"Expected output stream sequence {expected}, received {sequence}.")
            if mode != state["mode"]:
                raise ValueError("The Guardrail output-delivery mode changed during one stream.")
            if len(str(state["all_text"])) + len(text) > self._max_characters:
                state["complete"] = True
                await self._save(key, state, lock)
                raise ValueError("The output stream exceeded the configured maximum size.")

            session = _OutputStreamSession(
                mode=mode, request=_request_from_dict(state["request"]),
                next_sequence=expected, all_text=str(state["all_text"]),
                pending_text=str(state["pending_text"]),
                released_text=str(state.get("released_text", "")),
            )
            result = await _advance(session, sequence, text, final, self._window_characters, evaluate)
            state.update(next_sequence=session.next_sequence, all_text=session.all_text,
                         pending_text=session.pending_text, released_text=session.released_text,
                         complete=session.complete)
            await self._save(key, state, lock)
            return result

    def _new_state(self, mode: OutputDeliveryMode, request: ProtectionRequest) -> dict[str, object]:
        return {
            "mode": mode,
            "request": asdict(request),
            "next_sequence": 0,
            "all_text": "",
            "pending_text": "",
            "released_text": "",
            "complete": False,
        }

    async def _save(self, key: str, state: dict[str, object], lock: Lock) -> None:
        committed = await self._redis.eval(
            _COMMIT_OWNED_STREAM, 2, lock.name, key, lock.local.token,
            json.dumps(state, separators=(",", ":")), self._ttl_seconds,
        )
        if committed != 1:
            raise RuntimeError("Output stream lease expired before commit; unchecked output was withheld.")

    @staticmethod
    def _key(stream_key: str) -> str:
        digest = hashlib.sha256(stream_key.encode()).hexdigest()
        return f"tasklattice:guard:output-stream:{digest}"


def _request_from_dict(value: object) -> ProtectionRequest:
    if not isinstance(value, dict):
        raise ValueError("The output stream request state is invalid.")
    context = value.get("context")
    if not isinstance(context, dict):
        raise ValueError("The output stream request context is invalid.")
    content_blocks = value.get("content_blocks", ())
    messages = value.get("messages", ())
    return ProtectionRequest(
        phase=str(value.get("phase", "output")),  # type: ignore[arg-type]
        texts=tuple(str(item) for item in value.get("texts", ())),
        context=RequestContext(
            protocol=str(context.get("protocol", "http")),
            endpoint_id=(str(context["endpoint_id"]) if context.get("endpoint_id") is not None else None),
            headers=tuple((str(key), str(item)) for key, item in context.get("headers", ())),
            jwt_claims=tuple((str(key), str(item)) for key, item in context.get("jwt_claims", ())),
            fields=tuple((str(key), str(item)) for key, item in context.get("fields", ())),
        ),
        content_blocks=tuple(
            GuardContentBlock(
                id=str(item["id"]),
                text=str(item["text"]),
                role=str(item["role"]),  # type: ignore[arg-type]
                trust=str(item["trust"]),  # type: ignore[arg-type]
                source=str(item["source"]),
                qualifiers=tuple(item.get("qualifiers", ())),
                metadata=tuple((str(key), str(data)) for key, data in item.get("metadata", ())),
            )
            for item in content_blocks
            if isinstance(item, dict)
        ),
        call_id=(str(value["call_id"]) if value.get("call_id") is not None else None),
        messages=tuple(item for item in messages if isinstance(item, dict)),
        mode=str(value.get("mode", "enforce")),  # type: ignore[arg-type]
        evidence_scope=str(value.get("evidence_scope", "interventions")),  # type: ignore[arg-type]
    )


def _check_identity(pinned: ProtectionRequest, incoming: ProtectionRequest) -> None:
    if incoming.phase != "output" or (pinned.call_id, pinned.context.endpoint_id, pinned.mode) != (
        incoming.call_id, incoming.context.endpoint_id, incoming.mode,
    ):
        raise ValueError("Output stream identity or enforcement mode changed. Start a new stream.")


async def _advance(
    session: _OutputStreamSession,
    sequence: int,
    text: str,
    final: bool,
    window_characters: int,
    evaluate: StreamEvaluator,
) -> OutputStreamResult:
    session.all_text += text
    session.pending_text += text
    session.next_sequence += 1
    if not final and (
        session.mode == "full_buffered"
        or session.mode == "window_buffered" and len(session.pending_text) < window_characters
    ):
        return OutputStreamSessionStore._result(session, sequence, "buffering", "", False, False)

    # Do not reset semantic context at a network chunk/window boundary. Text is
    # the output candidate, not stale content blocks from the initial request.
    decision = await evaluate(replace(session.request, texts=(session.all_text,), content_blocks=()))
    checked, terminate = _release_after_evaluation(session.all_text, decision)
    if not terminate and not checked.startswith(session.released_text):
        # A later check changed already released text. Never slice transformed
        # output using original offsets or pretend earlier bytes can be recalled.
        raise OutputStreamEvaluationError("Output changed an already released prefix; use full-buffered delivery.")
    end = len(checked)
    if session.mode == "window_buffered" and not final:
        end = max(len(session.released_text), end - window_characters)
    released = "" if terminate else checked[len(session.released_text):end]
    session.released_text += released
    session.pending_text = ""
    session.complete = final or terminate
    status = "blocked" if terminate else "completed" if final else "released" if released else "buffering"
    return OutputStreamSessionStore._result(
        session, sequence, status, released, terminate, final, decision,
    )


def _release_after_evaluation(text: str, decision: ProtectionDecision) -> tuple[str, bool]:
    if decision.usage is not None and decision.usage.fail_closed:
        raise OutputStreamEvaluationError(
            "Output protection could not complete; unchecked output was withheld.",
            timed_out=any(step.timed_out for step in decision.trace),
        )
    if decision.decision == "block":
        return "", True
    if decision.decision == "transform":
        if len(decision.texts) != 1 or not isinstance(decision.texts[0], str):
            raise OutputStreamEvaluationError("Output protection returned an invalid transformation; unchecked output was withheld.")
        return decision.texts[0], False
    if decision.decision != "allow":
        raise OutputStreamEvaluationError("Output protection returned an invalid decision; unchecked output was withheld.")
    return text, False
