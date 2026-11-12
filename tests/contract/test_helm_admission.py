"""Helm starts the platform without configuring Runner admission policies."""
from tests.test_helm_chart import render


def test_platform_bootstrap_does_not_enable_runner_admission():
    runner, = [doc for doc in render() if doc["kind"] == "StatefulSet"]
    names = {entry["name"] for entry in runner["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert not any(feature in name for name in names
                   for feature in ("PROJECT_ADMISSION", "DISTRIBUTED_RATE", "GROUP_RATE"))
