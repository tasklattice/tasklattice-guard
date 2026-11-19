"""Share moderation work only inside one inspection of a content block."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
import time

from .contracts import EvaluationUsage


@dataclass
class ReviewReply:
    model: str | None = None
    content: str = ""
    answers: dict[str, str] = field(default_factory=dict)
    error: str | None = None
    attempts: list = field(default_factory=list)
    usage: EvaluationUsage = field(default_factory=EvaluationUsage)
    claimed: bool = False

    def claim_usage(self):
        if self.claimed:
            return EvaluationUsage()
        self.claimed = True
        return self.usage


class ReviewScope:
    def __init__(self):
        self.native = {}
        self.pending = {}
        self.tasks = set()

    def start(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    async def moderate(self, key, send, deadline):
        task = self.native.get(key)
        if task is None or (task.done() and (task.cancelled() or task.exception() or task.result().error)):
            task = self.native[key] = self.start(send())
        async with asyncio.timeout(max(0, deadline - time.monotonic())):
            return await asyncio.shield(task)

    async def ask(self, key, send, questions, state, deadline):
        # Only simultaneously ready, independent Rules can supply chat questions.
        # Keep late arrivals in a new batch; never delay a Rule to await a sibling.
        loop = asyncio.get_running_loop()
        members = self.pending.get(key)
        if members is None:
            members = self.pending[key] = []
            self.start(self.flush(key, members, send))
        future = loop.create_future()
        members.append((questions, state, future, deadline))
        async with asyncio.timeout(max(0, deadline - time.monotonic())):
            return await future

    async def flush(self, key, members, send):
        self.pending.pop(key)
        members = [m for m in members if not m[2].done() and time.monotonic() < m[3]]
        if not members:
            return
        if len(members) == 1:
            questions, state, _, _ = members[0]
            document = {"questions": questions, "state": state}
            mappings = [{k: k for k in questions}]
        else:
            checks, mappings = [], []
            for index, (questions, state, _, _) in enumerate(members):
                mapping = {k: f"r{index}_{k}" for k in questions}
                checks.append({"questions": {mapping[k]: v for k, v in questions.items()}, "state": state})
                mappings.append(mapping)
            document = {"checks": checks}
        keys = {key for mapping in mappings for key in mapping.values()}
        try:
            reply = await send(document, keys, max(m[3] for m in members))
        except Exception as error:
            for _, _, future, _ in members:
                if not future.done():
                    future.set_exception(error)
            return
        for (_, _, future, _), mapping in zip(members, mappings, strict=True):
            if not future.done():
                answers = {k: reply.answers[v] for k, v in mapping.items()} if not reply.error else {}
                future.set_result((reply, answers))


_current = ContextVar("security_review_scope", default=None)


def current_review_scope():
    return _current.get()


@asynccontextmanager
async def review_scope():
    scope = ReviewScope()
    token = _current.set(scope)
    try:
        yield
    finally:
        _current.reset(token)
        tasks = list(scope.tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
