#!/usr/bin/env bash
set -euo pipefail

image=${1:?Usage: bash scripts/test-runner-laya.sh RUNNER_IMAGE}
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
if [[ $# -ge 2 ]]; then
  expected_revision=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["artifactSha256"][:40])' "$2")
  expected_version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["modelVersion"])' "$2")
else
  expected_revision=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["revision"])' \
    "$repo_dir/controller/shared/builtin-laya-manifest.json")
  expected_version=$expected_revision
fi

docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --cpus 3 --memory 6g \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  -e "EXPECTED_LAYA_REVISION=$expected_revision" \
  -e "EXPECTED_LAYA_MODEL_VERSION=$expected_version" \
  --entrypoint python "$image" -c '
import asyncio
import os

from runner.builtin_laya import BuiltinLaya


async def main():
    model = BuiltinLaya.from_env()
    assert model is not None, "The shipped Runner must enable its packaged model"
    try:
        await model.start()
        assert model.revision == os.environ["EXPECTED_LAYA_REVISION"]
        identity = getattr(model, "model_identity", {"modelVersion": model.revision})
        assert identity["modelVersion"] == os.environ["EXPECTED_LAYA_MODEL_VERSION"]
        print(f"English Laya offline CPU warmup: {model.revision}")
    finally:
        await model.close()


asyncio.run(main())
'
