"""Content-free, correlated test lifecycle events for ordinary Runner logs."""
from __future__ import annotations

import json
import logging
from datetime import UTC, datetime

# Inherit Uvicorn's configured INFO handler in the standard container entrypoint.
logger = logging.getLogger("uvicorn.error.tasklattice.validation")


def validation_event(event: str, *, level: int = logging.INFO, **fields: object) -> None:
    # Callers pass identifiers, counters and classifications only: never prompts,
    # credentials, provider responses or raw exception messages.
    logger.log(level, "%s", json.dumps({"event": event, "occurred_at": datetime.now(UTC).isoformat(), **fields}, ensure_ascii=False))
