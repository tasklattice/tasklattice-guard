#!/usr/bin/env bash
set -euo pipefail

required_commands=(cp helm sed)
for command_name in "${required_commands[@]}"; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command is not installed: $command_name" >&2
    exit 1
  fi
done

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="${1:-0.0.0-dev}"
controller_repository="${TALI_GUARD_CONTROLLER_IMAGE_REPOSITORY:-ghcr.io/tasklattice/tali-guard-controller}"
runner_repository="${TALI_GUARD_RUNNER_IMAGE_REPOSITORY:-ghcr.io/tasklattice/tali-guard-runner}"
chart_root="$repository_root/charts/tali-guard"
output_root="$repository_root/dist/runtime-chart"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/tali-guard-chart.XXXXXX")"

cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

cp -R "$chart_root" "$work_dir/tali-guard"
sed -i.bak \
  "s|repository: ghcr.io/tasklattice/tali-guard-controller|repository: ${controller_repository}|; s|repository: ghcr.io/tasklattice/tali-guard-runner|repository: ${runner_repository}|; s|tag: \"0.2.0\"|tag: \"${version}\"|g" \
  "$work_dir/tali-guard/values.yaml"
rm -f "$work_dir/tali-guard/values.yaml.bak"

mkdir -p "$output_root"
helm lint "$work_dir/tali-guard" --strict \
  --set database.url=postgresql://guard:guard@postgres:5432/guard \
  --set security.artifactSigning.existingSecret=guard-artifact-signing \
  --set security.controlTls.existingSecret=guard-control-tls \
  --set security.bootstrapAdmin.existingSecret=guard-bootstrap-admin \
  --set runner.callContextRedisUrl=redis://redis:6379/0
mkdir -p "$work_dir/packaged"
helm package "$work_dir/tali-guard" \
  --version "$version" \
  --app-version "$version" \
  --destination "$work_dir/packaged" >/dev/null
cp "$work_dir/packaged/"*.tgz \
  "$output_root/tali-guard.tgz"

echo "Packaged TALI Guard Helm chart at $output_root/tali-guard.tgz"
