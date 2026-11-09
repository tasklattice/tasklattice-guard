import json
import subprocess

import pytest

from runner.software_version import read_software_version

pytestmark = pytest.mark.data_plane


def test_git_workspace_states(tmp_path):
    def git(*args):
        return subprocess.check_output(["git", "-C", str(tmp_path), *args], stderr=subprocess.DEVNULL)

    git("init")
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "Test")
    source = tmp_path / "source"
    source.write_text("initial")
    git("add", ".")
    git("commit", "-m", "initial")
    git("tag", "v1.0.0")
    clean = read_software_version(tmp_path, "")
    assert clean["dirty"] is False
    assert clean["version"].startswith("v1.0.0-0-g")
    (tmp_path / "new").write_text("untracked")
    assert read_software_version(tmp_path, "")["dirty"] is True
    git("add", "new")
    assert read_software_version(tmp_path, "")["dirty"] is True
    git("commit", "-m", "new")
    source.write_text("modified")
    assert read_software_version(tmp_path, "")["version"].endswith("-dirty")
    git("checkout", "--", "source")
    git("checkout", "--detach")
    assert read_software_version(tmp_path, "")["branch"] is None
    assert read_software_version(tmp_path, json.dumps(clean)) == clean | {"source": "build"}


def test_missing_metadata_is_unknown(tmp_path):
    assert read_software_version(tmp_path, "")["dirty"] is None
    assert read_software_version(tmp_path, "invalid")["source"] == "unknown"
