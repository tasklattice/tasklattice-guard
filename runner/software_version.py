"""Identity of the running source or the workspace used to build its image."""
import json
import os
from pathlib import Path
import subprocess


def read_software_version(cwd: Path | None = None, build: str | None = None) -> dict:
    unknown = dict(version="unknown", commit=None, branch=None, dirty=None, source="unknown")
    build = os.environ.get("TALI_BUILD_INFO") if build is None else build
    if build:
        try:
            value = json.loads(build)
            if (isinstance(value, dict) and isinstance(value.get("version"), str)
                    and value.get("source") in ("workspace", "build")
                    and isinstance(value.get("dirty"), bool)
                    and isinstance(value.get("commit"), str)
                    and (value.get("branch") is None or isinstance(value.get("branch"), str))):
                return {key: value[key] for key in ("version", "commit", "branch", "dirty")} | {"source": "build"}
        except (ValueError, KeyError):
            pass
        return unknown
    cwd = cwd or Path(__file__).resolve().parent

    def git(*args: str) -> str:
        return subprocess.check_output(["git", "-C", str(cwd), *args], text=True, stderr=subprocess.DEVNULL, timeout=3).strip()

    try:
        commit = git("rev-parse", "HEAD")
        branch = git("rev-parse", "--abbrev-ref", "HEAD")
        description = git("describe", "--tags", "--always", "--long", "--abbrev=12")
        dirty = bool(git("status", "--porcelain", "--untracked-files=normal"))
        return dict(version=description + ("-dirty" if dirty else ""), commit=commit,
                    branch=None if branch == "HEAD" else branch, dirty=dirty, source="workspace")
    except (OSError, subprocess.SubprocessError):
        return unknown


SOFTWARE_VERSION = read_software_version()
