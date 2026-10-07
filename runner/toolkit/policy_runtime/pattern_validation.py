"""Technical checks on regex candidates; business formats belong to Rules."""
from __future__ import annotations

from datetime import date
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator


class _Validator(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class DateValidator(_Validator):
    type: Literal["date"]
    start: int = Field(default=0, ge=0)
    format: Literal["YYYYMMDD"] = "YYYYMMDD"


class WeightedChecksumValidator(_Validator):
    type: Literal["weighted_checksum"]
    alphabet: str = Field(min_length=2, max_length=128)
    weights: list[int] = Field(min_length=1, max_length=256)
    check_characters: str = Field(min_length=2, max_length=128)

    @field_validator("alphabet", "check_characters")
    @classmethod
    def uppercase_ascii(cls, value: str) -> str:
        if not value.isascii() or value.upper() != value or any(not c.isprintable() or c.isspace() for c in value):
            raise ValueError("Checksum characters must be uppercase printable ASCII without spaces")
        return value

    @field_validator("alphabet")
    @classmethod
    def unique_alphabet(cls, value: str) -> str:
        if len(set(value)) != len(value):
            raise ValueError("Checksum alphabet must contain unique characters")
        return value

    @field_validator("weights")
    @classmethod
    def valid_weights(cls, values: list[int]) -> list[int]:
        if any(value < 0 or value > 1_000_000_000 for value in values):
            raise ValueError("Checksum weights must be between 0 and 1000000000")
        return values


class LuhnValidator(_Validator):
    type: Literal["luhn"]


PatternValidator = Annotated[DateValidator | WeightedChecksumValidator | LuhnValidator, Field(discriminator="type")]
_VALIDATORS = TypeAdapter(list[PatternValidator])


def parse_pattern_validators(value: Any) -> tuple[dict[str, Any], ...]:
    """Validate configuration at compilation/loading, before checking traffic."""
    return tuple(item.model_dump() for item in _VALIDATORS.validate_python(value, strict=True))


def valid_pattern_candidate(value: str, validators: tuple[dict[str, Any], ...]) -> bool:
    return all(_matches(value, validator) for validator in validators)


def _matches(value: str, validator: dict[str, Any]) -> bool:
    match validator["type"]:
        case "date":
            part = value[validator["start"]:validator["start"] + 8]
            if len(part) != 8 or not part.isascii() or not part.isdigit():
                return False
            try:
                date(int(part[:4]), int(part[4:6]), int(part[6:]))
                return True
            except ValueError:
                return False
        case "weighted_checksum":
            normalized = value.upper()
            weights = validator["weights"]
            if len(normalized) != len(weights) + 1:
                return False
            try:
                total = sum(validator["alphabet"].index(char) * weight for char, weight in zip(normalized[:-1], weights, strict=True))
            except ValueError:
                return False
            checks = validator["check_characters"]
            return normalized[-1] == checks[total % len(checks)]
        case "luhn":
            digits = "".join(char for char in value if not char.isspace() and char != "-")
            if not digits or not digits.isascii() or not digits.isdigit():
                return False
            total = 0
            for index, char in enumerate(reversed(digits)):
                digit = int(char)
                if index % 2:
                    digit *= 2
                    if digit > 9:
                        digit -= 9
                total += digit
            return total % 10 == 0
        case _:
            raise ValueError(f"Unsupported pattern validator {validator['type']!r}")
