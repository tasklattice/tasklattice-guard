"""Chart composition for shared-group rate budgets; never provisions Redis."""
import copy
import json

import pytest

from runner.group_rate_admission import GroupRateConfiguration
from tests.contract.test_helm_admission import LOCAL, RATE, environments, pool, render


POLICY = dict(group_id="group-ab", revision="group-v1", window_ms=1000, group_limit=20,
              tenant_limits={"tenantA": 12, "tenantB": 12},
              pool_limits={"default": 15, "batch": 15}, pool_epochs={"default": 0, "batch": 1})


def configuration():
    return {"runner": {"default": {"tenantAdmission": copy.deepcopy(LOCAL), "groupRateAdmission": copy.deepcopy(POLICY)},
        "pools": [pool("batch", tenantAdmission=copy.deepcopy(LOCAL), groupRateAdmission=copy.deepcopy(POLICY)), pool("other")]},
        "security": {"poolAuthentication": {"enabled": True, "controllerSecret": "pool-map", "controllerKey": "tokens",
            "runnerSecrets": {name: {"name": name + "-pool", "key": "control"} for name in ["default", "batch", "other"]}}}}


def both(config, change):
    for entry in [config["runner"]["default"], config["runner"]["pools"][0]]:
        entry["groupRateAdmission"].update(copy.deepcopy(change))


def test_same_group_policy_round_trips_on_all_declared_pools_without_inheriting_other_pool(tmp_path):
    docs = render(tmp_path, configuration())
    by_pool = environments(docs)
    for name in ["default", "batch"]:
        assert by_pool[name]["GUARD_RUNNER_GROUP_RATE_ENABLED"] == "true"
        raw = by_pool[name]["GUARD_RUNNER_GROUP_RATE_JSON"]
        assert json.loads(raw) == POLICY
        assert GroupRateConfiguration.from_json(raw).pool_epochs[name] == POLICY["pool_epochs"][name]
        assert "GUARD_RUNNER_DISTRIBUTED_RATE_ENABLED" not in by_pool[name]
    assert "GUARD_RUNNER_GROUP_RATE_ENABLED" not in by_pool["other"]
    assert all("group_rate_admission" not in json.dumps(doc) for doc in docs if doc["kind"] == "Job")


def test_group_policy_is_absent_by_default(tmp_path):
    for env in environments(render(tmp_path)).values():
        assert not any("GROUP_RATE" in key for key in env)


@pytest.mark.parametrize("change", [
    {"group_limit": 0}, {"group_limit": True}, {"window_ms": 99}, {"revision": " padded"},
    {"group_id": ""}, {"tenant_limits": {}}, {"pool_epochs": {"default": 0}},
    {"pool_epochs": {"default": -1, "batch": 0}}, {"pool_epochs": {"default": 0, "batch": 9007199254740992}},
    {"pool_limits": {"foreign": 10}, "pool_epochs": {"foreign": 0}}, {"unknown": 1},
    {"tenant_limits": {"foreign": 1}}, {"group_limit": 100000, "tenant_limits": {"tenantA": 100000, "tenantB": 1}},
    {"group_limit": 100000, "pool_limits": {"default": 100000, "batch": 1}},
])
def test_group_policy_constraints_fail_closed(tmp_path, change):
    config = configuration(); both(config, change)
    error = render(tmp_path, config, success=False)
    assert "groupRateAdmission" in error


@pytest.mark.parametrize("change", ["missing", "different", "missing_local", "v1", "no_auth", "no_redis", "ephemeral_redis"])
def test_incomplete_group_rollout_or_prerequisites_are_rejected(tmp_path, change):
    config = configuration()
    if change == "missing":
        del config["runner"]["pools"][0]["groupRateAdmission"]
    elif change == "different":
        config["runner"]["pools"][0]["groupRateAdmission"]["group_limit"] = 19
    elif change == "missing_local":
        del config["runner"]["default"]["tenantAdmission"]
    elif change == "v1":
        config["runner"]["default"]["distributedRateAdmission"] = copy.deepcopy(RATE)
    elif change == "no_auth":
        config["security"] = {}
    else:
        config["runner"]["callContextRedisUrl"] = ""
        config["redis"] = {"enabled": change == "ephemeral_redis"}
    assert "groupRateAdmission" in render(tmp_path, config, success=False)


def test_policy_can_cover_remote_pools_and_local_tenant_subset_without_claiming_remote_rollout(tmp_path):
    config = configuration()
    both(config, {"pool_limits": {**POLICY["pool_limits"], "remote": 10}, "pool_epochs": {**POLICY["pool_epochs"], "remote": 0}})
    config["runner"]["default"]["tenantAdmission"]["tenant_limits"] = {"tenantA": 2}
    assert environments(render(tmp_path, config))["default"]["GUARD_RUNNER_GROUP_RATE_ENABLED"] == "true"
