"""Admission is explicit per pool; charts never initialize or reset Redis quotas."""
from __future__ import annotations

import copy
import json
import subprocess

import pytest
import yaml

from tests.test_helm_chart import CHART, REQUIRED
from runner.distributed_rate_admission import DistributedRateConfiguration
from runner.tenant_admission import TenantAdmissionConfiguration


LOCAL = dict(capacity=4, tenant_limits={"tenantA": 2, "tenantB": 2}, max_queued=8,
             max_queued_per_tenant=4, queue_timeout_seconds=0.25)
RATE = dict(pool_id="default", revision="v1", window_ms=1000, pool_limit=20,
            tenant_limits={"tenantA": 12, "tenantB": 12})


def values(*, rate=True):
    result = {"runner": {"default": {"tenantAdmission": copy.deepcopy(LOCAL)}}}
    if rate:
        result["runner"]["default"]["distributedRateAdmission"] = copy.deepcopy(RATE)
        result["security"] = {"poolAuthentication": {"enabled": True,
            "controllerSecret": "pool-map", "controllerKey": "tokens",
            "runnerSecrets": {"default": {"name": "default-pool", "key": "control"}}}}
    return result


def render(tmp_path, configuration=None, *, success=True):
    path = tmp_path / "admission-values.yaml"
    path.write_text(yaml.safe_dump(configuration or {}))
    required = list(REQUIRED)
    if "callContextRedisUrl" in (configuration or {}).get("runner", {}):
        index = next(i for i, value in enumerate(required) if value.startswith("runner.callContextRedisUrl="))
        del required[index - 1:index + 1]
    result = subprocess.run(["helm", "template", "contract", str(CHART), *required,
                             "--values", str(path)], capture_output=True, text=True)
    if not success:
        assert result.returncode != 0
        return result.stderr
    assert result.returncode == 0, result.stderr
    return [item for item in yaml.safe_load_all(result.stdout) if item]


def environments(documents):
    return {doc["metadata"]["labels"]["tasklattice.io/runner-pool"]:
        {entry["name"]: entry.get("value") for entry in doc["spec"]["template"]["spec"]["containers"][0]["env"]}
        for doc in documents if doc["kind"] == "StatefulSet" and
        doc["metadata"]["labels"].get("app.kubernetes.io/component") == "runner"}


def pool(name, **settings):
    return dict(name=name, replicaCount=1, maxConcurrency=4, resources={}, **settings)


def test_admission_is_absent_by_default(tmp_path):
    for environment in environments(render(tmp_path)).values():
        assert not any("TENANT_ADMISSION" in key or "DISTRIBUTED_RATE" in key for key in environment)


def test_local_admission_is_explicit_per_pool_without_inheritance(tmp_path):
    configuration = values(rate=False)
    batch = {**LOCAL, "capacity": 1, "tenant_limits": {"batchTenant": 1}}
    configuration["runner"]["pools"] = [pool("batch", tenantAdmission=batch), pool("other")]
    environments_by_pool = environments(render(tmp_path, configuration))
    for name, expected in [("default", LOCAL), ("batch", batch)]:
        environment = environments_by_pool[name]
        assert environment["GUARD_RUNNER_TENANT_ADMISSION_ENABLED"] == "true"
        assert json.loads(environment["GUARD_RUNNER_TENANT_ADMISSION_JSON"]) == expected
        assert TenantAdmissionConfiguration.from_json(environment["GUARD_RUNNER_TENANT_ADMISSION_JSON"]).capacity == expected["capacity"]
        assert "GUARD_RUNNER_DISTRIBUTED_RATE_ENABLED" not in environment
    assert "GUARD_RUNNER_TENANT_ADMISSION_ENABLED" not in environments_by_pool["other"]


def test_distributed_policy_round_trips_exactly_for_default_and_named_pool(tmp_path):
    configuration = values()
    batch_local = {**LOCAL, "tenant_limits": {"tenantC": 2}}
    batch_rate = {**RATE, "pool_id": "batch", "tenant_limits": {"tenantC": 8}}
    configuration["runner"]["pools"] = [pool("batch", tenantAdmission=batch_local, distributedRateAdmission=batch_rate)]
    configuration["security"]["poolAuthentication"]["runnerSecrets"]["batch"] = {"name": "batch-pool", "key": "control"}
    documents = render(tmp_path, configuration)
    for name, expected in [("default", RATE), ("batch", batch_rate)]:
        environment = environments(documents)[name]
        assert environment["GUARD_RUNNER_DISTRIBUTED_RATE_ENABLED"] == "true"
        assert json.loads(environment["GUARD_RUNNER_DISTRIBUTED_RATE_JSON"]) == expected
        assert DistributedRateConfiguration.from_json(environment["GUARD_RUNNER_DISTRIBUTED_RATE_JSON"]).pool_id == name
    assert not any("distributed_rate_admission" in json.dumps(document) for document in documents if document["kind"] == "Job")


@pytest.mark.parametrize("field,bad", [("capacity", 0), ("capacity", True), ("max_queued", -1),
    ("queue_timeout_seconds", 31), ("tenant_limits", {}), ("tenant_limits", {" padded": 1}),
    ("tenant_limits", {"tenant": False}), ("tenant_limits", {"x" * 257: 1}),
    ("tenant_limits", {f"tenant{i}": 1 for i in range(1001)}), ("unknown", 1)])
def test_local_schema_rejects_bad_fields(tmp_path, field, bad):
    configuration = values(rate=False)
    configuration["runner"]["default"]["tenantAdmission"][field] = bad
    error = render(tmp_path, configuration, success=False)
    assert "tenantAdmission" in error or "invalid propertyName" in error


@pytest.mark.parametrize("field,bad", [("window_ms", 99), ("window_ms", True), ("pool_limit", 0),
    ("pool_limit", 100001), ("revision", ""), ("tenant_limits", {"tenantA": 100001}), ("unknown", 1)])
def test_distributed_schema_rejects_bad_fields(tmp_path, field, bad):
    configuration = values()
    configuration["runner"]["default"]["distributedRateAdmission"][field] = bad
    assert "distributedRateAdmission" in render(tmp_path, configuration, success=False)


def test_distributed_requires_local_admission_and_pool_auth(tmp_path):
    configuration = values()
    del configuration["runner"]["default"]["tenantAdmission"]
    assert "requires tenantAdmission" in render(tmp_path, configuration, success=False)
    configuration = values()
    configuration["security"] = {}
    assert "requires security.poolAuthentication.enabled=true" in render(tmp_path, configuration, success=False)


@pytest.mark.parametrize("bundled", [False, True])
def test_distributed_requires_external_redis_and_rejects_bundled_ephemeral_redis(tmp_path, bundled):
    configuration = values()
    configuration["runner"]["callContextRedisUrl"] = ""
    configuration["redis"] = {"enabled": bundled}
    assert "requires external persistent Redis" in render(tmp_path, configuration, success=False)


@pytest.mark.parametrize("change,expected", [({"pool_id": "foreign"}, "must match its trusted pool name"),
    ({"tenant_limits": {"foreign": 2}}, "tenant IDs must match tenantAdmission"),
    ({"pool_limit": 100000, "tenant_limits": {"tenantA": 100000, "tenantB": 1}}, "must not exceed 100000")])
def test_distributed_cross_field_constraints_fail_closed(tmp_path, change, expected):
    configuration = values()
    configuration["runner"]["default"]["distributedRateAdmission"].update(change)
    assert expected in render(tmp_path, configuration, success=False)
