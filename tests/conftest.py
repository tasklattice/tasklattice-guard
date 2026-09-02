from __future__ import annotations

from pathlib import Path

import pytest


# Test ownership is explicit and exhaustive. New top-level test modules must be
# assigned to one architectural plane before they can enter CI.
_CONTROL_PLANE = frozenset({
    "test_pii_model_escalation.py",
    "test_policy_library_facets.py",
    "test_runner_draft_preview.py",
    "test_runner_validator.py",
    "test_tali_taxonomy.py",
})
_DATA_PLANE = frozenset({
    "test_dynamic_model_configuration.py",
    "test_evaluation_action_routing.py",
    "test_pii_evaluator.py",
    "test_runner_api.py",
    "test_runner_artifact_store.py",
    "test_runner_control_client.py",
    "test_runner_metrics.py",
    "test_runner_model_config.py",
    "test_runner_observability.py",
    "test_runner_telemetry.py",
    "test_safety_model_providers.py",
})
_CONTRACT = frozenset({
    "test_control_protocol_contract.py",
    "test_enforcement_action_contract.py",
    "test_helm_chart.py",
    "test_release_contract.py",
})


def architectural_suite(path: Path) -> str | None:
    parts = path.parts
    return (
        "control_plane"
        if "control_plane" in parts or path.name in _CONTROL_PLANE
        else "data_plane"
        if "data_plane" in parts or path.name in _DATA_PLANE
        else "e2e"
        if "e2e" in parts
        else "contract"
        if "contract" in parts or path.name in _CONTRACT
        else None
    )


def pytest_collection_modifyitems(
    config: pytest.Config,
    items: list[pytest.Item],
) -> None:
    del config
    unclassified: list[str] = []
    for item in items:
        path = Path(str(item.path))
        marker = architectural_suite(path)
        if marker is None:
            unclassified.append(str(path))
            continue
        item.add_marker(getattr(pytest.mark, marker))
    if unclassified:
        raise pytest.UsageError(
            "Tests must declare an architectural suite in tests/conftest.py or "
            "live under tests/control_plane, tests/data_plane, tests/e2e, or "
            f"tests/contract: {', '.join(sorted(set(unclassified)))}"
        )
