"""Carry request-local diagnostics through NeMo's reusable queue workers."""
import asyncio
from contextvars import copy_context
from functools import wraps
from threading import Lock

_INSTALL_LOCK = Lock()


def install_work_queue_context() -> None:
    # The pinned NeMo queue awaits each work item in a long-lived worker. Its
    # submit API does not copy ContextVars, so workers otherwise retain the
    # first caller's trace, model observation and validation diagnostic scopes.
    from nemoguardrails.guardrails.async_work_queue import AsyncWorkQueue

    with _INSTALL_LOCK:
        original = AsyncWorkQueue.submit
        if getattr(original, "__tasklattice_request_context__", False):
            return

        @wraps(original)
        async def submit(self, func, *args, **kwargs):
            context = copy_context()

            async def run():
                return await asyncio.create_task(func(*args, **kwargs), context=context)

            return await original(self, run)

        submit.__tasklattice_request_context__ = True
        AsyncWorkQueue.submit = submit
