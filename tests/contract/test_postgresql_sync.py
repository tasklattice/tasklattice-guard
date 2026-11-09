"""Opt-in database recovery tests using the cached official PostgreSQL image.

RUN_POSTGRESQL_SYNC_TESTS=1 uv run pytest tests/contract/test_postgresql_sync.py
Creates isolated Docker containers/volumes; never connects to an installed DB.
"""
from __future__ import annotations

import os
from pathlib import Path
import secrets
import subprocess
import time
import uuid

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "controller/scripts/runtime/sync-postgresql.sh"
IMAGE = "postgres:17-alpine"
pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_POSTGRESQL_SYNC_TESTS") != "1",
    reason="Set RUN_POSTGRESQL_SYNC_TESTS=1 to run isolated Docker database tests",
)


@pytest.mark.parametrize("role", ["guard", "custom guard"])
def test_recreated_credentials_preserve_data_and_auth_configuration(role):
    suffix = uuid.uuid4().hex[:12]
    container, volume = f"guard-pg-sync-{suffix}", f"guard-pg-sync-data-{suffix}"
    original = secrets.token_hex(32)
    replacement = secrets.token_hex(32) + "'\\\"%\ncredential"
    environment = {**os.environ, "POSTGRES_USER": role, "POSTGRES_DB": "guard", "PGDATA": "/var/lib/postgresql/data/pgdata"}

    def redacted(text):
        for value in (original, replacement, "never-log-this-credential"):
            text = text.replace(value, "[redacted]")
        return text

    def docker(*args, check=True, env=None, input=None):
        result = subprocess.run(["docker", *args], env={**environment, **(env or {})}, input=input,
                                text=True, capture_output=True, timeout=150)
        if check:
            # Do not let a failing test print credentials in subprocess diagnostics.
            assert result.returncode == 0, f"Docker operation failed: {args[0]} (exit {result.returncode}): {redacted(result.stderr)}"
        return result

    def query(credential, sql="SELECT 1", check=True):
        return docker("exec", "-i", "-e", "PGPASSWORD", container, "psql", "-X", "-w", "-At",
                      "-h", "127.0.0.1", "-U", role, "-d", "guard", "-v", "ON_ERROR_STOP=1",
                      env={"PGPASSWORD": credential}, input=sql, check=check)

    def start(credential):
        docker("run", "-d", "--pull=never", "--name", container, "--user", "70:70",
               "-v", f"{volume}:/var/lib/postgresql/data", "-e", "POSTGRES_USER", "-e", "POSTGRES_DB",
               "-e", "PGDATA", "-e", "POSTGRES_PASSWORD", "-e", "POSTGRES_INITDB_ARGS=--auth-local=scram-sha-256 --auth-host=scram-sha-256",
               IMAGE, env={"POSTGRES_PASSWORD": credential})
        deadline = time.monotonic() + 45
        while query(credential, check=False).returncode:
            if time.monotonic() >= deadline:
                pytest.fail("PostgreSQL did not accept the expected credential: " + redacted(docker("logs", container).stderr))
            time.sleep(0.25)

    def stop():
        docker("stop", "--time", "30", container)
        docker("rm", container)

    def synchronize(credential, username=role, check=True):
        result = docker("run", "--rm", "--pull=never", "--network", "none", "--user", "70:70",
                        "-v", f"{volume}:/var/lib/postgresql/data", "-v", f"{SCRIPT}:/sync.sh:ro",
                        "-e", "POSTGRES_USER", "-e", "POSTGRES_PASSWORD", "-e", "PGDATA",
                        "--entrypoint", "bash", IMAGE, "/sync.sh",
                        env={"POSTGRES_USER": username, "POSTGRES_PASSWORD": credential}, check=check)
        assert credential not in result.stdout + result.stderr
        return result

    docker("volume", "create", volume)
    try:
        assert "New PostgreSQL" in synchronize(original).stdout
        start(original)
        query(original, "CREATE TABLE preserved_data (value text); INSERT INTO preserved_data VALUES ('kept across recovery');")
        hba = docker("exec", container, "sha256sum", "/var/lib/postgresql/data/pgdata/pg_hba.conf").stdout
        stop()

        # Normal restart, recreated Secret, and a second startup with that Secret.
        for credential in (original, replacement, replacement):
            assert "synchronized" in synchronize(credential).stdout
            start(credential)
            assert query(credential, "SELECT value FROM preserved_data").stdout.strip() == "kept across recovery"
            assert docker("exec", container, "sha256sum", "/var/lib/postgresql/data/pgdata/pg_hba.conf").stdout == hba
            if credential == replacement:
                assert query(original, check=False).returncode != 0
            stop()

        # A wrong configured role must fail closed and stop the temporary server.
        result = synchronize("never-log-this-credential", username="missing_role", check=False)
        assert result.returncode != 0
        assert "synchronization failed" in result.stderr
        start(replacement)
        assert query(replacement, "SELECT value FROM preserved_data").stdout.strip() == "kept across recovery"
        assert query(replacement, "SELECT count(*) FROM pg_roles WHERE rolname = 'missing_role'").stdout.strip() == "0"
        stop()
    finally:
        docker("rm", "-f", container, check=False)
        docker("volume", "rm", volume, check=False)
