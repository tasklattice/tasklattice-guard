"""Helm starts the platform without configuring Runner admission policies."""
import json

import pytest

from tests.test_helm_chart import render


POLICIES = {
    "projectAdmission": {"capacity": 4, "project_limits": {"projectA": 2},
                         "max_queued": 8, "max_queued_per_project": 4, "queue_timeout_seconds": 0.25},
    "distributedRateAdmission": {"pool_id": "default", "revision": "v1", "window_ms": 1000,
                                 "pool_limit": 20, "project_limits": {"projectA": 12}},
    "groupRateAdmission": {"group_id": "group-ab", "revision": "v1", "window_ms": 1000,
                           "group_limit": 20, "project_limits": {"projectA": 12},
                           "pool_limits": {"default": 15, "batch": 15},
                           "pool_epochs": {"default": 0, "batch": 0}},
}


def test_platform_bootstrap_does_not_enable_runner_admission():
    runner, = [doc for doc in render() if doc["kind"] == "StatefulSet"]
    names = {entry["name"] for entry in runner["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert not any(feature in name for name in names
                   for feature in ("PROJECT_ADMISSION", "DISTRIBUTED_RATE", "GROUP_RATE"))


@pytest.mark.parametrize("feature", POLICIES)
def test_removed_admission_values_do_not_change_platform_bootstrap(feature):
    assert render("--set-json", f"runner.default.{feature}=" + json.dumps(POLICIES[feature])) == render()
