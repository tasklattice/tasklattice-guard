"""One construction worker, separate from the serving event loop."""
from __future__ import annotations

import asyncio
import contextvars
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from typing import Awaitable, Callable, TypeVar


_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="runner-preparation")
T = TypeVar("T")


async def prepare(function: Callable[..., T], *args,
                  on_cancel: Callable[[T], Awaitable[None]] | None = None, **kwargs) -> T:
    """Serialize expensive builds without taking serving locks.

    Cancellation drains already submitted work: a state transaction must not
    continue publishing after its caller has reported cancellation. Temporary
    runtimes additionally supply cleanup for an otherwise abandoned result.
    """
    context = contextvars.copy_context()
    future = asyncio.get_running_loop().run_in_executor(
        _executor, context.run, partial(function, *args, **kwargs),
    )
    try:
        return await asyncio.shield(future)
    except asyncio.CancelledError:
        while not future.done():
            try:
                await asyncio.shield(future)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        try:
            result = future.result()
        except Exception:
            pass
        else:
            if on_cancel is not None:
                cleanup = asyncio.create_task(on_cancel(result))
                while not cleanup.done():
                    try:
                        await asyncio.shield(cleanup)
                    except asyncio.CancelledError:
                        continue
                cleanup.result()
        raise
