"""Explicit v2 rate of admission starts shared across a Controller tenant group.

All participating pools/replicas use one canonical policy and Redis hash slot.
No counters are created from requests; concurrency and reservations are separate.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Mapping

from redis.asyncio import Redis
from redis.backoff import NoBackoff
from redis.exceptions import RedisError
from redis.retry import Retry

from .distributed_rate_admission import _PROVISION
from .tenant_admission import AdmissionRejected, AdmissionUnavailable


@dataclass(frozen=True)
class GroupRateConfiguration:
    group_id: str
    revision: str
    window_ms: int
    group_limit: int
    tenant_limits: Mapping[str, int]
    pool_limits: Mapping[str, int]
    pool_epochs: Mapping[str, int]

    @classmethod
    def from_json(cls, raw: str) -> GroupRateConfiguration:
        def unique(items):
            result = {}
            for key, value in items:
                if key in result:
                    raise ValueError("Group rate policy contains duplicate keys.")
                result[key] = value
            return result

        try:
            values = json.loads(raw, object_pairs_hook=unique)
        except (TypeError, json.JSONDecodeError) as error:
            raise ValueError("Group rate policy must be a JSON object.") from error
        fields = {"group_id", "revision", "window_ms", "group_limit", "tenant_limits", "pool_limits", "pool_epochs"}
        if not isinstance(values, dict) or set(values) != fields:
            raise ValueError("Group rate policy must contain exactly group_id, revision, window_ms, group_limit, tenant_limits, pool_limits and pool_epochs.")

        def identity(value):
            if not isinstance(value, str) or not value or value != value.strip() or len(value) > 256:
                raise ValueError("Group rate IDs must be nonempty, unpadded UTF-8 strings of at most 256 characters.")
            try:
                value.encode("utf-8")
            except UnicodeEncodeError as error:
                raise ValueError("Group rate IDs must be valid UTF-8.") from error

        identity(values["group_id"])
        identity(values["revision"])
        window = values["window_ms"]
        if type(window) is not int or not 100 <= window <= 86_400_000:
            raise ValueError("Group rate window_ms must be an integer between 100 and 86400000.")
        for field in ("tenant_limits", "pool_limits", "pool_epochs"):
            mapping = values[field]
            if not isinstance(mapping, dict) or not 1 <= len(mapping) <= 1000:
                raise ValueError("Group rate maps must contain 1 to 1000 named entries.")
            for key in mapping:
                identity(key)
        for limit in [values["group_limit"], *values["tenant_limits"].values(), *values["pool_limits"].values()]:
            if type(limit) is not int or not 1 <= limit <= 100_000:
                raise ValueError("Group rate limits must be integers between 1 and 100000.")
        if set(values["pool_limits"]) != set(values["pool_epochs"]) or any(
            type(epoch) is not int or not 0 <= epoch <= 9_007_199_254_740_991 for epoch in values["pool_epochs"].values()
        ):
            raise ValueError("Group rate pool_epochs must match pool_limits with nonnegative safe-integer epochs.")
        for field in ("tenant_limits", "pool_limits"):
            if sum(min(limit, values["group_limit"]) for limit in values[field].values()) > 100_000:
                raise ValueError("Group rate retained tenant and pool histories must each not exceed 100000 entries.")
        return cls(**{**values, **{field: MappingProxyType(dict(values[field]))
            for field in ("tenant_limits", "pool_limits", "pool_epochs")}})

    @property
    def canonical_json(self) -> str:
        return json.dumps({"group_id": self.group_id, "revision": self.revision, "window_ms": self.window_ms,
            "group_limit": self.group_limit, "tenant_limits": dict(self.tenant_limits),
            "pool_limits": dict(self.pool_limits), "pool_epochs": dict(self.pool_epochs)}, sort_keys=True, separators=(",", ":"))

    @property
    def digest(self) -> str:
        return hashlib.sha256(self.canonical_json.encode()).hexdigest()

    def validate_runner(self, pool_id: str, local_tenants: Mapping[str, int]) -> None:
        if pool_id not in self.pool_limits or not set(local_tenants).issubset(self.tenant_limits):
            raise ValueError("Group rate policy must include the trusted Runner pool and all local admission tenants.")


_ADMIT_GROUP = """
if redis.call('TYPE', KEYS[1]).ok ~= 'hash' or redis.call('HGET', KEYS[1], 'digest') ~= ARGV[1] then
  return {-1, 0}
end
for i = 1, 4 do
  if redis.call('PTTL', KEYS[i]) ~= -1 then return {-1, 0} end
end
for i = 2, 4 do
  if redis.call('TYPE', KEYS[i]).ok ~= 'zset' or
     tonumber(redis.call('ZSCORE', KEYS[i], '!initialized')) ~= -1 or
     redis.call('ZCOUNT', KEYS[i], '-inf', '-0.000001') ~= 1 then return {-1, 0} end
end
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local last = tonumber(redis.call('HGET', KEYS[1], 'last_ms'))
if not last or last < 0 or last ~= math.floor(last) or now < last then return {-1, 0} end
redis.call('HSET', KEYS[1], 'last_ms', now)
local window = tonumber(ARGV[2])
local retry = 0
for i = 2, 4 do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], 0, now - window)
  if redis.call('ZCARD', KEYS[i]) - 1 >= tonumber(ARGV[i + 1]) then
    local oldest = redis.call('ZRANGE', KEYS[i], 1, 1, 'WITHSCORES')
    if #oldest ~= 2 then return {-1, 0} end
    retry = math.max(retry, tonumber(oldest[2]) + window - now)
  end
end
if retry > 0 then return {0, retry} end
for i = 2, 4 do
  if redis.call('ZSCORE', KEYS[i], ARGV[6]) then return {-1, 0} end
end
for i = 2, 4 do redis.call('ZADD', KEYS[i], now, ARGV[6]) end
return {1, 0}
"""


class RedisGroupRateAdmission:
    def __init__(self, redis: Redis, configuration: GroupRateConfiguration, pool_id: str):
        if pool_id not in configuration.pool_limits:
            raise ValueError("Trusted Runner pool is absent from group rate policy.")
        self._redis, self.configuration, self.pool_id = redis, configuration, pool_id
        group = hashlib.sha256(configuration.group_id.encode()).hexdigest()
        self._prefix = f"tasklattice:guard:rate:v2:{{{group}}}"
        self._digest = configuration.digest
        self._policy_key = f"{self._prefix}:policy"
        self._group_key = f"{self._prefix}:group"

    @classmethod
    def connect(cls, url: str, configuration: GroupRateConfiguration, pool_id: str) -> RedisGroupRateAdmission:
        return cls(Redis.from_url(url, socket_timeout=1, socket_connect_timeout=1,
            retry=Retry(NoBackoff(), 0), retry_on_timeout=False, max_connections=32), configuration, pool_id)

    def _pool_key(self, pool: str) -> str:
        return f"{self._prefix}:pool:{hashlib.sha256(pool.encode()).hexdigest()}"

    def _tenant_key(self, tenant: str) -> str:
        return f"{self._prefix}:tenant:{hashlib.sha256(tenant.encode()).hexdigest()}"

    @property
    def state_keys(self) -> tuple[str, ...]:
        return (self._policy_key, self._group_key,
            *(self._tenant_key(tenant) for tenant in sorted(self.configuration.tenant_limits)),
            *(self._pool_key(pool) for pool in sorted(self.configuration.pool_limits)))

    def validate_allocation(self, tenant: str, group_id: str, epoch: int) -> None:
        if (group_id != self.configuration.group_id or type(epoch) is not int or
            epoch != self.configuration.pool_epochs[self.pool_id] or tenant not in self.configuration.tenant_limits):
            raise AdmissionUnavailable("Controller allocation has no matching group rate policy.")

    async def provision(self) -> None:
        """Operator-only initialization. No startup/request caller may reset state."""
        try:
            async with asyncio.timeout(2):
                result = await self._redis.eval(_PROVISION, len(self.state_keys), *self.state_keys,
                    self._digest, self.configuration.canonical_json)
        except (RedisError, OSError, TimeoutError) as error:
            raise AdmissionUnavailable("Group rate provisioning failed; preserve and inspect retained state.") from error
        if result != 1:
            raise AdmissionUnavailable("Group rate state already exists; provisioning cannot reset or replace it.")

    async def admit(self, tenant: str, *, group_id: str, epoch: int) -> None:
        self.validate_allocation(tenant, group_id, epoch)
        keys = (self._policy_key, self._group_key, self._tenant_key(tenant), self._pool_key(self.pool_id))
        try:
            async with asyncio.timeout(2):
                result = await self._redis.eval(_ADMIT_GROUP, 4, *keys, self._digest,
                    self.configuration.window_ms, self.configuration.group_limit,
                    self.configuration.tenant_limits[tenant], self.configuration.pool_limits[self.pool_id], uuid.uuid4().hex)
        except (RedisError, OSError, TimeoutError) as error:
            raise AdmissionUnavailable("Group rate authority is unavailable.") from error
        if (not isinstance(result, (list, tuple)) or len(result) != 2 or any(type(value) is not int for value in result)):
            raise AdmissionUnavailable("Group rate state is unavailable.")
        status, delay = result
        if status == 1 and delay == 0:
            return
        if status == 0 and delay > 0:
            raise AdmissionRejected("rate_limited", retry_after=max(1, math.ceil(delay / 1000)))
        raise AdmissionUnavailable("Group rate state is missing, mismatched or unavailable.")

    async def aclose(self) -> None:
        await self._redis.aclose()


async def _provision_cli(path: Path):
    configuration = GroupRateConfiguration.from_json(path.read_text())
    url = os.environ.get("GUARD_RUNNER_CALL_CONTEXT_REDIS_URL", "").strip()
    if not url:
        raise ValueError("GUARD_RUNNER_CALL_CONTEXT_REDIS_URL is required for group rate provisioning.")
    admission = RedisGroupRateAdmission.connect(url, configuration, next(iter(configuration.pool_limits)))
    try:
        await admission.provision()
    finally:
        await admission.aclose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Provision a new group-wide rate policy; existing state is never reset.")
    parser.add_argument("command", choices=["provision"])
    parser.add_argument("--policy", type=Path, required=True)
    arguments = parser.parse_args()
    try:
        asyncio.run(_provision_cli(arguments.policy))
    except (AdmissionUnavailable, ValueError, OSError) as error:
        parser.exit(1, f"{error}\n")
    print("Group rate policy provisioned.")
