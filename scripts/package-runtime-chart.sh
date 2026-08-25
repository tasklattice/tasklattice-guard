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
image_repository="${TASKLATTICE_GUARD_IMAGE_REPOSITORY:-ghcr.io/tasklattice/tasklattice-guard}"
chart_root="$repository_root/charts/tasklattice-guard"
output_root="$repository_root/dist/runtime-chart"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/tasklattice-guard-chart.XXXXXX")"

cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

cp -R "$chart_root" "$work_dir/tasklattice-guard"
sed -i.bak \
  "s|repository: ghcr.io/tasklattice/tasklattice-guard|repository: ${image_repository}|" \
  "$work_dir/tasklattice-guard/values.yaml"
rm -f "$work_dir/tasklattice-guard/values.yaml.bak"

mkdir -p "$output_root"
helm lint "$work_dir/tasklattice-guard" --strict
helm package "$work_dir/tasklattice-guard" \
  --version "$version" \
  --app-version "$version" \
  --destination "$work_dir/packaged" >/dev/null
cp "$work_dir/packaged/tasklattice-guard-${version}.tgz" \
  "$output_root/tasklattice-guard.tgz"

echo "Packaged TaskLattice Guard Helm chart at $output_root/tasklattice-guard.tgz"
