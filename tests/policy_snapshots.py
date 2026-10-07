"""Authoring-side fixture preparation; runtime calls receive explicit snapshots."""
from runner.toolkit.policy_library import policy


def library_definitions(ids):
    return {key: definition for key in ids if (definition := policy(key)) is not None}
