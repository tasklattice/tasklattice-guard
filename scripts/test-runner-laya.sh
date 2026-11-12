#!/usr/bin/env bash
set -euo pipefail

image=${1:?Usage: bash scripts/test-runner-laya.sh RUNNER_IMAGE}
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
expected_revision=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["revision"])' \
  "$repo_dir/controller/shared/builtin-laya-manifest.json")

docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --cpus 3 --memory 6g \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  -e "EXPECTED_LAYA_REVISION=$expected_revision" \
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
        print(f"English Laya offline CPU warmup: {model.revision}")
    finally:
        await model.close()


asyncio.run(main())
'
