from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from tests.classifier_cases import CLASSIFIER_BACKENDS


ROOT = Path(__file__).resolve().parents[1]
GENERATE_ARTIFACT_FIXTURES = ROOT / "scripts" / "generate_test_artifacts.py"


@pytest.fixture(scope="session", autouse=True)
def generated_artifact_fixtures() -> None:
    """Signed Artifact fixtures are generator output, not committed source.

    Regenerating once per session keeps a fresh checkout, CI and a working tree
    on one path: data-plane and contract tests never consume a stale blob, and a
    compiler or Policy change never needs a binary fixture commit. Generation is
    deterministic and writes only changed bytes, so repeated runs are inert.
    """
    result = subprocess.run(
        [sys.executable, str(GENERATE_ARTIFACT_FIXTURES)],
        cwd=ROOT, capture_output=True, text=True, timeout=600,
    )
    if result.returncode != 0:
        pytest.fail(
            "Artifact fixture generation failed. It needs the development "
            "dependencies (`npm run sync`); run "
            f"`{GENERATE_ARTIFACT_FIXTURES.relative_to(ROOT)}` to see the cause.\n"
            f"{result.stdout}{result.stderr}"
        )


@pytest.fixture(scope="module", params=CLASSIFIER_BACKENDS, ids=lambda backend: backend.name)
def classifier_backend(request):
    return request.param


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
    "test_custom_content_rules.py",
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
    "test_runner_transport_outage.py",
    "test_safety_model_providers.py",
})
_CONTRACT = frozenset({
    "test_control_protocol_contract.py",
    "test_enforcement_action_contract.py",
    "test_helm_chart.py",
    "test_litellm_dev_chart.py",
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


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        "--control-plane-shard",
        metavar="INDEX/COUNT",
        help="Run one deterministic shard of control-plane tests, for example 1/2.",
    )


def pytest_collection_modifyitems(
    config: pytest.Config,
    items: list[pytest.Item],
) -> None:
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

    shard = config.getoption("control_plane_shard")
    if shard is None:
        return
    try:
        index, count = map(int, shard.split("/"))
        if not 1 <= index <= count:
            raise ValueError
    except ValueError:
        raise pytest.UsageError("--control-plane-shard must use INDEX/COUNT with 1 <= INDEX <= COUNT.") from None

    # Interleave sorted cases so parametrized, similarly expensive tests are
    # spread across runners while retaining the original execution order.
    control_plane = sorted((item for item in items if item.get_closest_marker("control_plane")), key=lambda item: item.nodeid)
    selected = {item.nodeid for item in control_plane[index - 1::count]}
    deselected = [item for item in control_plane if item.nodeid not in selected]
    items[:] = [item for item in items if not item.get_closest_marker("control_plane") or item.nodeid in selected]
    config.hook.pytest_deselected(items=deselected)
