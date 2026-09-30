#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
image=${1:?Usage: bash scripts/test-runner-guardctl.sh RUNNER_IMAGE}

# Test the final image as shipped, without a source checkout or installed dev
# dependencies in the container. Loopback HTTP fixtures need no external network.
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,size=16m \
  --mount "type=bind,src=$repo_dir/scripts/guardctl-smoke.py,dst=/tmp/guardctl-smoke.py,readonly" \
  --mount "type=bind,src=$repo_dir/controller/openapi/controller.openapi.json,dst=/tmp/controller.openapi.json,readonly" \
  --env GUARDCTL_OPENAPI=/tmp/controller.openapi.json \
  --entrypoint python "$image" /tmp/guardctl-smoke.py

# Adding the CLI must leave the non-root runtime and Runner entrypoint intact.
docker run --rm --network none --read-only --tmpfs /tmp:rw,nosuid,nodev,size=16m --entrypoint python "$image" -c '
import os, shutil, tempfile
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
assert os.getuid() == 65532
assert shutil.which("guardctl")
assert not shutil.which("npm")
assert not os.path.exists("/build/controller")
with tempfile.TemporaryDirectory() as directory:
    key = Path(directory) / "artifact-public.pem"
    key.write_bytes(Ed25519PrivateKey.generate().public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo))
    os.environ.update(GUARD_CONTROLLER_TOKEN="offline-test-token-not-a-real-secret", GUARD_ARTIFACT_PUBLIC_KEY_PATH=str(key), GUARD_RUNNER_STATE_PATH=directory)
    from runner.main import app
    assert app is not None
print("Runner imports and non-root image contract: OK")
'
docker image inspect "$image" --format '{{json .Config.Cmd}}' | \
  python3 -c 'import json, sys; assert json.load(sys.stdin) == ["uvicorn", "runner.main:app", "--host", "0.0.0.0", "--port", "8091"]'
