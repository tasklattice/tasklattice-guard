"""CPU capacity of the Runner process and its container."""

import os
from pathlib import Path


_CGROUP = Path("/sys/fs/cgroup")


def _cgroup_cpu_quota_cores() -> float | None:
    try:
        quota, period = (int(value) for value in (_CGROUP / "cpu.max").read_text().split())
        if quota > 0 and period > 0:
            return quota / period
    except (OSError, ValueError):
        pass

    for directory in (_CGROUP / "cpu", _CGROUP / "cpu,cpuacct"):
        try:
            quota = int((directory / "cpu.cfs_quota_us").read_text())
            period = int((directory / "cpu.cfs_period_us").read_text())
            if quota > 0 and period > 0:
                return quota / period
        except (OSError, ValueError):
            pass
    return None


def cpu_capacity_cores() -> float:
    available = os.process_cpu_count() or 1
    quota = _cgroup_cpu_quota_cores()
    return min(available, quota) if quota is not None else float(available)
