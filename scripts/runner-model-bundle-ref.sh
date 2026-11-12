#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_REPOSITORY_OWNER:?Set GITHUB_REPOSITORY_OWNER to the package namespace}"
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

sha256() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$@"
  else
    shasum -a 256 "$@"
  fi
}

# The bundle identity changes only when the model inputs or bundle recipe change.
recipe=$(awk '
  /^# BEGIN RUNNER MODEL BUNDLE$/ { starts++; in_bundle = 1; next }
  /^# END RUNNER MODEL BUNDLE$/ { ends++; in_bundle = 0; next }
  in_bundle { print }
  END { if (starts != 1 || ends != 1 || in_bundle) exit 1 }
' Dockerfile.runner)
[[ -n "$recipe" ]]

digest=$(
  {
    printf '%s\n' "$recipe" | sha256
    sha256 controller/shared/builtin-laya-manifest.json \
      deploy/runner-model-bundle/fetch.py deploy/runner-model-bundle/LICENSE
  } | sha256
)
owner=$(printf '%s' "$GITHUB_REPOSITORY_OWNER" | tr '[:upper:]' '[:lower:]')
printf 'ghcr.io/%s/tali-guard-runner-model-bundle:bundle-%s\n' "$owner" "${digest%% *}"
