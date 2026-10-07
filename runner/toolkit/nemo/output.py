"""One output lifecycle for complete text and externally generated streams."""
from __future__ import annotations

import asyncio
from dataclasses import replace

from opentelemetry.trace import Status, StatusCode

from ..runtime.content_views import content_view, request_view
from ..runtime.streaming import OutputStreamContract, OutputStreamEvaluationError, OutputStreamResult
from .native_streaming import native_output_config, run_native_output_stream


async def protect_output(runtime, request, source, *, emit, observe, ready, timeout_seconds):
    """NeMo owns rule execution; the published configuration selects delivery.

    Both delivery modes share source limits, cancellation, deadlines, check
    failures and cleanup. Complete text is just a one-item source. Callbacks
    preserve transport backpressure without a second queue or producer task.
    """
    from .runtime import _TRACER

    iterator = source.__aiter__()
    checks = 0

    async def checked(decision):
        nonlocal checks
        checks += 1
        if observe is not None:
            await observe(decision)
        if decision.usage and decision.usage.fail_closed:
            raise OutputStreamEvaluationError("Output protection failed.",
                timed_out=any(step.timed_out for step in decision.trace))

    async def bounded_source():
        size = frames = 0
        async for text in iterator:
            frames += 1
            if not isinstance(text, str):
                raise OutputStreamEvaluationError("Protected output must be text.")
            size += len(text)
            if size > 1_000_000 or frames > 100_000:
                raise OutputStreamEvaluationError("Output exceeded the stream limits.")
            yield text

    bounded = bounded_source()
    with _TRACER.start_as_current_span("guardrail.output", record_exception=False,
        set_status_on_exception=False, attributes={
            "guardrail.id": request.plan.guardrail_id,
            "guardrail.version": request.plan.guardrail_version,
        }) as span:
        try:
            if request.phase != "output" or timeout_seconds <= 0:
                raise ValueError("Output protection requires output phase and a positive timeout.")
            async with asyncio.timeout(timeout_seconds):
                acquisition = await runtime._registry.acquire_async(request.plan,
                    **({"release_id": request.effective_release_id} if request.effective_release_id else {}))
                native = bool(native_output_config(acquisition[0].config).get("streaming", {}).get("enabled"))
                contract = OutputStreamContract(request.plan.output_delivery,
                    "window_buffered" if native else "full_buffered",
                    "NeMo checks overlapping windows before release." if native
                    else "The compiled output rules require one complete-response check.")
                if ready is not None:
                    await ready(contract)
                if native:
                    result = await run_native_output_stream(runtime, request, bounded,
                        emit=emit, observe=checked, acquisition=acquisition)
                    return replace(result, checks=checks)

                text = "".join([part async for part in bounded])
                # Replace the placeholder output in the same trusted/contextual
                # view used by ordinary checks, including its source digest.
                view = request_view(request)
                if any(block.id == view.active_block_id and block.text != text for block in view.blocks):
                    view = content_view(tuple(replace(block, text=text)
                        if block.id == view.active_block_id else block for block in view.blocks),
                        view.active_block_id, kind=view.kind)
                candidate = replace(request, text=text, content_view=view)
                decision = await runtime._evaluate_complete(candidate, acquisition=acquisition)
                await checked(decision)
                if decision.decision == "block":
                    return OutputStreamResult("blocked", 0, checks)
                transformed = decision.decision == "transform"
                approved = decision.texts[0] if transformed else text
                for offset in range(0, len(approved), 16_384):
                    await emit(approved[offset:offset + 16_384])
                return OutputStreamResult("completed", len(approved), checks, transformed)
        except asyncio.CancelledError:
            span.set_status(Status(StatusCode.ERROR, "CancelledError"))
            raise
        except TimeoutError:
            span.set_status(Status(StatusCode.ERROR, "TimeoutError"))
            raise OutputStreamEvaluationError("Output protection timed out.", timed_out=True) from None
        except OutputStreamEvaluationError:
            span.set_status(Status(StatusCode.ERROR, "OutputStreamEvaluationError"))
            raise
        except Exception as error:
            span.set_status(Status(StatusCode.ERROR, type(error).__name__))
            raise OutputStreamEvaluationError("Output protection failed; unchecked text was withheld.") from None
        finally:
            try:
                await bounded.aclose()
            finally:
                close = getattr(iterator, "aclose", None)
                if close is not None:
                    # A broken source must not hold the connection indefinitely.
                    try:
                        async with asyncio.timeout(2):
                            await close()
                    except Exception:
                        span.set_status(Status(StatusCode.ERROR, "OutputSourceCloseError"))
                        raise OutputStreamEvaluationError("The output source could not close.") from None
