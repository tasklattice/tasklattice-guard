"""Explicitly provisioned Redis rate-of-starts budgets shared by a Runner pool.

This is neither a distributed concurrency semaphore nor a queue. Persistent
state is deliberate: a missing/evicted counter must never become a fresh budget.
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
from typing import Mapping
from types import MappingProxyType

from redis.asyncio import Redis
from redis.backoff import NoBackoff
from redis.exceptions import RedisError
from redis.retry import Retry

from .project_admission import AdmissionRejected, AdmissionUnavailable


@dataclass(frozen=True)
class DistributedRateConfiguration:
    pool_id: str
    revision: str
    window_ms: int
    pool_limit: int
    project_limits: Mapping[str, int]

    @classmethod
    def from_json(cls, raw: str) -> DistributedRateConfiguration:
        def unique_object(items):
            result = {}
            for key, value in items:
                if key in result:
                    raise ValueError("Distributed rate policy contains duplicate keys.")
                result[key] = value
            return result

        try:
            values = json.loads(raw, object_pairs_hook=unique_object)
        except (TypeError, json.JSONDecodeError) as error:
            raise ValueError("Distributed rate policy must be a JSON object.") from error
        fields = {"pool_id", "revision", "window_ms", "pool_limit", "project_limits"}
        if not isinstance(values, dict) or set(values) != fields:
            raise ValueError("Distributed rate policy must contain exactly pool_id, revision, window_ms, pool_limit and project_limits.")
        for field in ("pool_id", "revision"):
            value = values[field]
            if not isinstance(value, str) or not value or value != value.strip() or len(value) > 256:
                raise ValueError(f"Distributed rate {field} must be a nonempty unpadded string of at most 256 characters.")
            try:
                value.encode("utf-8")
            except UnicodeEncodeError as error:
                raise ValueError(f"Distributed rate {field} must be valid UTF-8.") from error
        window = values["window_ms"]
        if isinstance(window, bool) or not isinstance(window, int) or not 100 <= window <= 86_400_000:
            raise ValueError("Distributed rate window_ms must be an integer between 100 and 86400000.")
        limits = values["project_limits"]
        if not isinstance(limits, dict) or not 1 <= len(limits) <= 1000 or any(
            not key or key != key.strip() or len(key) > 256 for key in limits
        ):
            raise ValueError("Distributed rate project_limits requires 1 to 1000 nonempty unpadded project IDs of at most 256 characters.")
        for limit in [values["pool_limit"], *limits.values()]:
            if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100_000:
                raise ValueError("Distributed rate limits must be integers between 1 and 100000.")
        if sum(min(limit, values["pool_limit"]) for limit in limits.values()) > 100_000:
            raise ValueError("Distributed rate retained project history must not exceed 100000 entries per pool.")
        try:
            for key in limits:
                key.encode("utf-8")
        except UnicodeEncodeError as error:
            raise ValueError("Distributed rate project IDs must be valid UTF-8.") from error
        return cls(**{**values, "project_limits": MappingProxyType(dict(limits))})

    @property
    def canonical_json(self) -> str:
        return json.dumps({"pool_id": self.pool_id, "revision": self.revision,
            "window_ms": self.window_ms, "pool_limit": self.pool_limit,
            "project_limits": dict(self.project_limits)}, sort_keys=True, separators=(",", ":"))

    @property
    def digest(self) -> str:
        return hashlib.sha256(self.canonical_json.encode()).hexdigest()


# KEYS are in one pool hash slot. Validate every required key before mutation.
# No TTL and the sentinel distinguish initialized empty history from lost state.
# TIME, not a client-supplied timestamp, determines the sliding window.
_ADMIT = """
if redis.call('TYPE', KEYS[1]).ok ~= 'hash' then return {-1, 0} end
if redis.call('HGET', KEYS[1], 'digest') ~= ARGV[1] then return {-1, 0} end
for i = 1, 3 do
  if redis.call('PTTL', KEYS[i]) ~= -1 then return {-1, 0} end
end
for i = 2, 3 do
  if redis.call('TYPE', KEYS[i]).ok ~= 'zset' or
     tonumber(redis.call('ZSCORE', KEYS[i], '!initialized')) ~= -1 or
     redis.call('ZCOUNT', KEYS[i], '-inf', '-0.000001') ~= 1 then
    return {-1, 0}
  end
end
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local last = tonumber(redis.call('HGET', KEYS[1], 'last_ms'))
if not last or last < 0 or last ~= math.floor(last) or now < last then return {-1, 0} end
redis.call('HSET', KEYS[1], 'last_ms', now)
local window = tonumber(ARGV[2])
local retry = 0
for i = 2, 3 do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], 0, now - window)
  local limit = tonumber(ARGV[i + 1])
  if redis.call('ZCARD', KEYS[i]) - 1 >= limit then
    local oldest = redis.call('ZRANGE', KEYS[i], 1, 1, 'WITHSCORES')
    if #oldest ~= 2 then return {-1, 0} end
    retry = math.max(retry, tonumber(oldest[2]) + window - now)
  end
end
if retry > 0 then return {0, retry} end
-- UUID is generated once per attempt. Automatic retries are disabled.
if redis.call('ZSCORE', KEYS[2], ARGV[5]) or redis.call('ZSCORE', KEYS[3], ARGV[5]) then
  return {-1, 0}
end
redis.call('ZADD', KEYS[2], now, ARGV[5])
redis.call('ZADD', KEYS[3], now, ARGV[5])
return {1, 0}
"""

_PROVISION = """
for i = 1, #KEYS do
  if redis.call('EXISTS', KEYS[i]) ~= 0 then return 0 end
end
-- The final digest is the ready marker. An interrupted/failed provisioning
-- never authorizes requests, and a subsequent invocation cannot reset state.
redis.call('HSET', KEYS[1], 'pending', '1')
for i = 2, #KEYS do redis.call('ZADD', KEYS[i], -1, '!initialized') end
redis.call('HSET', KEYS[1], 'digest', ARGV[1], 'policy', ARGV[2], 'last_ms', '0')
redis.call('HDEL', KEYS[1], 'pending')
return 1
"""


class RedisRateAdmission:
    def __init__(self, redis: Redis, configuration: DistributedRateConfiguration):
        self._redis = redis
        self.configuration = configuration
        # Hashing prevents project/pool IDs from injecting Redis hash tags.
        pool = hashlib.sha256(configuration.pool_id.encode()).hexdigest()
        self._prefix = f"tasklattice:guard:rate:{{{pool}}}"
        self._digest = configuration.digest
        self._policy_key = f"{self._prefix}:policy"
        self._pool_key = f"{self._prefix}:pool"

    @classmethod
    def connect(cls, url: str, configuration: DistributedRateConfiguration) -> RedisRateAdmission:
        # EVAL can have succeeded when a response is lost. Never retry that
        # ambiguous charge and never execute the request without its response.
        client = Redis.from_url(url, socket_timeout=1, socket_connect_timeout=1,
            retry=Retry(NoBackoff(), 0), retry_on_timeout=False, max_connections=32)
        return cls(client, configuration)

    @property
    def state_keys(self) -> tuple[str, ...]:
        """Exact provisioned keys; useful for ACL setup and admin inspection."""
        return (self._policy_key, self._pool_key, *(
            self._project_key(project) for project in sorted(self.configuration.project_limits)))

    def _project_key(self, project: str) -> str:
        return f"{self._prefix}:project:{hashlib.sha256(project.encode()).hexdigest()}"

    async def provision(self) -> None:
        """Privileged explicit initialization; refuses any existing state.

        Never call this during Runner startup or from a request handler. Policy
        changes/recovery require an operator-controlled drain and reconciliation.
        """
        try:
            async with asyncio.timeout(2):
                result = await self._redis.eval(_PROVISION, len(self.state_keys), *self.state_keys,
                    self._digest, self.configuration.canonical_json)
        except (RedisError, OSError, TimeoutError) as error:
            raise AdmissionUnavailable("Distributed rate policy provisioning failed; inspect state before recovery.") from error
        if result != 1:
            raise AdmissionUnavailable("Distributed rate state already exists; provisioning cannot reset or replace it.")

    async def admit(self, project: str) -> None:
        limit = self.configuration.project_limits.get(project)
        if limit is None:
            raise AdmissionUnavailable("Endpoint project has no provisioned distributed rate policy.")
        keys = (self._policy_key, self._pool_key, self._project_key(project))
        try:
            async with asyncio.timeout(2):
                result = await self._redis.eval(_ADMIT, 3, *keys, self._digest,
                    self.configuration.window_ms, self.configuration.pool_limit, limit, uuid.uuid4().hex)
        except (RedisError, OSError, TimeoutError) as error:
            raise AdmissionUnavailable("Distributed rate authority is unavailable.") from error
        if (not isinstance(result, (list, tuple)) or len(result) != 2 or
            any(type(value) is not int for value in result)):
            raise AdmissionUnavailable("Distributed rate state is unavailable.")
        status, delay = result
        if status == 1 and delay == 0:
            return
        if status == 0 and isinstance(delay, int) and delay > 0:
            raise AdmissionRejected("rate_limited", retry_after=max(1, math.ceil(delay / 1000)))
        raise AdmissionUnavailable("Distributed rate state is missing, mismatched or unavailable.")

    async def aclose(self) -> None:
        await self._redis.aclose()


async def _provision_cli(path: Path) -> None:
    configuration = DistributedRateConfiguration.from_json(path.read_text())
    url = os.environ.get("GUARD_RUNNER_CALL_CONTEXT_REDIS_URL", "").strip()
    if not url:
        raise ValueError("GUARD_RUNNER_CALL_CONTEXT_REDIS_URL is required for provisioning.")
    admission = RedisRateAdmission.connect(url, configuration)
    try:
        await admission.provision()
    finally:
        await admission.aclose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Explicitly provision a new distributed rate policy. Never resets existing state.")
    parser.add_argument("command", choices=["provision"])
    parser.add_argument("--policy", type=Path, required=True)
    arguments = parser.parse_args()
    try:
        asyncio.run(_provision_cli(arguments.policy))
    except (AdmissionUnavailable, ValueError, OSError) as error:
        parser.exit(1, f"{error}\n")
    print("Distributed rate policy provisioned.")
