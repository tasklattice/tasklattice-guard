from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from runner import generated as protocol
from runner.toolkit.runtime.enforcement_action_generated import (
    ENFORCEMENT_ACTIONS,
    ENFORCEMENT_ACTION_CONFLICT_ORDER,
    ENFORCEMENT_ACTION_CONFLICT_PRIORITIES,
    ENFORCEMENT_ACTION_DESCRIPTIONS,
    ENFORCEMENT_ACTION_DISPLAY_ORDER,
)


ROOT = Path(__file__).resolve().parent.parent
GENERATOR = ROOT / "scripts" / "generate_enforcement_action_contract.py"


def _proto_actions() -> list[tuple[str, int]]:
    prefix = "ENFORCEMENT_ACTION_"
    return [
        (item.name.removeprefix(prefix).lower(), item.number)
        for item in protocol.EnforcementAction.DESCRIPTOR.values
        if item.name != f"{prefix}UNSPECIFIED"
    ]


def test_generated_enforcement_action_bindings_are_current() -> None:
    """CI must reject hand-edited or stale Controller/Runner bindings."""

    result = subprocess.run(
        [sys.executable, str(GENERATOR), "--check"],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stdout + result.stderr


def test_enforcement_action_contract_centralizes_semantics_and_precedence() -> None:
    """Proto declaration order and numbers own display and conflict semantics."""

    actions = _proto_actions()
    values = tuple(value for value, _priority in actions)
    display_values = values
    conflict_values = tuple(
        value for value, _priority in sorted(actions, key=lambda item: item[1], reverse=True)
    )
    priorities = tuple(priority for _value, priority in actions)

    assert protocol.ENFORCEMENT_ACTION_UNSPECIFIED == 0
    assert display_values == ENFORCEMENT_ACTION_DISPLAY_ORDER
    assert conflict_values == ENFORCEMENT_ACTION_CONFLICT_ORDER
    assert frozenset(values) == ENFORCEMENT_ACTIONS
    assert len(set(priorities)) == len(priorities)
    assert tuple(
        ENFORCEMENT_ACTION_CONFLICT_PRIORITIES[value] for value in conflict_values
    ) == tuple(sorted(priorities, reverse=True))
    assert conflict_values[-1] == "pass"
    assert set(ENFORCEMENT_ACTION_DESCRIPTIONS) == set(values)
    assert set(ENFORCEMENT_ACTION_CONFLICT_PRIORITIES) == set(values)
    assert all(ENFORCEMENT_ACTION_DESCRIPTIONS[value] for value in values)
