"""Structured fault attribution at explicit execution and response boundaries."""
from contextlib import contextmanager
from dataclasses import dataclass
import json
from typing import Literal

ErrorSource = Literal["model", "configuration", "guard", "unknown", "mixed"]


@dataclass(frozen=True, slots=True)
class Failure:
    source: ErrorSource
    category: str
    error_type: str
    http_status: int | None = None


class ModelResponseError(ValueError):
    """The provider response violated the selected protocol, not test quality."""

    def __init__(self, category: str, error_type: str):
        self.category, self.error_type = category, error_type
        # Never retain response bodies, decoder excerpts or exception messages.
        super().__init__(f"Model response failed {category} validation ({error_type}).")


class ModelConfigurationError(ValueError):
    pass


@contextmanager
def model_response():
    """Wrap only response decoding/schema validation, never request construction."""
    try:
        yield
    except ModelResponseError:
        raise
    except json.JSONDecodeError as error:
        raise ModelResponseError("json_decode", type(error).__name__) from None
    except (ValueError, TypeError, KeyError, IndexError, AttributeError) as error:
        raise ModelResponseError("response_schema", type(error).__name__) from None
