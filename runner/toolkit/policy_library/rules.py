"""Canonical, versioned Rule resources shared by built-in Policy packages."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
from pathlib import Path

from .declarative import RuleDefinition, parse_yaml


@dataclass(frozen=True)
class RuleResource:
    id: str
    version: str
    definition: RuleDefinition
    checksum: str
    path: Path


class RuleRegistry:
    """Compile-time Rule index; Policy packages pin exact Rule versions."""

    def __init__(self, resources: tuple[RuleResource, ...]) -> None:
        index: dict[tuple[str, str], RuleResource] = {}
        for resource in resources:
            key = (resource.id, resource.version)
            if key in index:
                raise ValueError(f"Duplicate Rule resource {resource.id}@{resource.version}")
            index[key] = resource
        self._resources = tuple(resources)
        self._index = index

    @classmethod
    def load(cls, root: Path) -> RuleRegistry:
        resources: list[RuleResource] = []
        for path in sorted(root.rglob("rule.yaml")):
            definition = RuleDefinition.model_validate(parse_yaml(path.read_text()))
            checksum = hashlib.sha256(path.read_bytes()).hexdigest()
            resources.append(RuleResource(definition.id, definition.version, definition, checksum, path))
        return cls(tuple(resources))

    def resolve(self, rule_id: str, version: str) -> RuleResource:
        resource = self._index.get((rule_id, version))
        if resource is None:
            raise ValueError(f"Unavailable Rule resource {rule_id}@{version}")
        return resource
