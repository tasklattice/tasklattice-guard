#!/usr/bin/env bash
set -euo pipefail

if (( $# < 4 )); then
  echo "Usage: bash scripts/helm-upgrade.sh RELEASE CHART CONTEXT NAMESPACE [Helm values/options...]" >&2
  exit 2
fi

release=$1
chart=$2
context=$3
namespace=$4
shift 4
cluster_args=(--kube-context "$context" --namespace "$namespace")

# Helm 4.0.0's `upgrade --install` does not forward --server-side=false to
# the install action. Adopting retained Secrets then fails with
# "metadata.managedFields must be nil". Select the action explicitly so both
# paths use client-side apply without deleting Secrets or taking ownership.
if release_status=$(helm status "$release" "${cluster_args[@]}" 2>&1); then
  if grep -Eq '^STATUS:[[:space:]]+uninstalled[[:space:]]*$' <<<"$release_status"; then
    # `helm uninstall --keep-history` retains a record but no active release.
    action=(install --replace --create-namespace)
  else
    action=(upgrade)
  fi
else
  status_code=$?
  if grep -Fxq 'Error: release: not found' <<<"$release_status"; then
    action=(install --create-namespace)
  else
    # A cluster/authentication failure is not evidence of an absent release.
    printf '%s\n' "$release_status" >&2
    exit "$status_code"
  fi
fi

printf 'Helm %s: release=%s namespace=%s context=%s\n' "${action[0]}" "$release" "$namespace" "$context"
exec helm "${action[@]}" "$release" "$chart" "${cluster_args[@]}" "$@" --server-side=false
