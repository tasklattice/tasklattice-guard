#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
image=${1:?Usage: bash scripts/build-runner-model-candidate.sh IMAGE [PLATFORM]}
platform=${2:-}
bundle=$(python3 -c 'from pathlib import Path; from runner.model_bundle_contract import load_lock; print(load_lock(Path("deploy/runner-model-bundle/model-lock.json"))["image"])')
build_info=$(python3 -c 'import json; from runner.software_version import SOFTWARE_VERSION; print(json.dumps(SOFTWARE_VERSION, separators=(",",":")))')
options=()
if [[ -n "$platform" ]]; then
  options+=(--platform "$platform")
fi
docker buildx build --load -f Dockerfile.runner --target runtime-candidate -t "$image" \
  --build-context "laya_candidate_bundle=docker-image://$bundle" \
  --build-arg "TALI_BUILD_INFO=$build_info" ${options[@]+"${options[@]}"} .
bash scripts/test-runner-laya.sh "$image" deploy/runner-model-bundle/model-lock.json
