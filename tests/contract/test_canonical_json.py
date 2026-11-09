"""Canonical JSON must match controller/shared/canonical-json.ts byte for byte."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from runner.protocol_codec import canonical_json

VECTORS = json.loads((Path(__file__).resolve().parents[1] / "fixtures/canonical-json/vectors.json").read_text("utf-8"))


@pytest.mark.parametrize("vector", VECTORS["valid"], ids=lambda item: item["name"])
def test_canonical_json_matches_shared_vectors(vector):
    assert canonical_json(vector["value"]) == vector["canonical"]


@pytest.mark.parametrize("vector", VECTORS["invalid"], ids=lambda item: item["name"])
def test_canonical_json_rejects_values_without_one_cross_language_encoding(vector):
    with pytest.raises(ValueError):
        canonical_json(vector["value"])
