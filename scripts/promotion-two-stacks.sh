#!/usr/bin/env bash
# Run two fully isolated local deployments for the Guardrail promotion
# regression: UAT (authoring, package export) and PROD (receiving only: no
# Policy Library, authoring disabled, trusts UAT's package key). Each has its
# own database, artifact signing key, Controller, Runner and Runner state.
#
#   scripts/promotion-two-stacks.sh start   # keys, databases, four processes
#   scripts/promotion-two-stacks.sh stop
#   scripts/promotion-two-stacks.sh reset   # stop, drop both databases and Runner state (keeps keys)
#   scripts/promotion-two-stacks.sh env     # exports for regress_guardrail_promotion.mjs
#
# Requires a loopback PostgreSQL (GUARD_PROMOTION_PG, default
# postgresql://guard:guard@127.0.0.1:55432), openssl, `npm run sync`.
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
WORK="${GUARD_PROMOTION_WORKDIR:-/tmp/guard-promotion}"
PG="${GUARD_PROMOTION_PG:-postgresql://guard:guard@127.0.0.1:55432}"
RUNNER_TOKEN="promotion-runner-token-000000000000000000"
AUTH_SECRET="promotion-better-auth-secret-0000000000000000"
PASSWORD="Promotion-Admin-2026!"

env_exports() {
  cat <<EOF
export GUARD_PROMOTION_WORKDIR="$WORK"
export GUARD_PROMOTION_UAT_URL="http://localhost:18080"
export GUARD_PROMOTION_UAT_RUNNER_URL="http://localhost:18091"
export GUARD_PROMOTION_PROD_URL="http://127.0.0.1:28080"
export GUARD_PROMOTION_PROD_RUNNER_URL="http://127.0.0.1:28091"
export GUARD_PROMOTION_UAT_DB="$PG/guard_uat"
export GUARD_PROMOTION_PROD_DB="$PG/guard_prod"
export GUARD_PROMOTION_UAT_EMAIL="admin@uat.local"
export GUARD_PROMOTION_PROD_EMAIL="admin@prod.local"
export GUARD_PROMOTION_PASSWORD="$PASSWORD"
export GUARD_PROMOTION_RUNNER_TOKEN="$RUNNER_TOKEN"
EOF
}

keypair() {
  openssl genpkey -algorithm ed25519 -out "$WORK/keys/$1.pem" 2>/dev/null
  openssl pkey -in "$WORK/keys/$1.pem" -pubout -out "$WORK/keys/$1.pub.pem"
}

wait_for() {
  local url="$1" label="$2" log="$3"
  for _ in $(seq 1 120); do
    if curl -fsS "$url" >/dev/null 2>&1; then echo "  $label ready"; return; fi
    sleep 1
  done
  echo "$label did not become ready; see $log" >&2
  tail -40 "$log" >&2
  exit 1
}

start_controller() {
  local name="$1"; shift
  (cd "$ROOT/controller" && env "$@" nohup node --import tsx server/index.ts >"$WORK/$name.log" 2>&1 & echo $! >"$WORK/$name.pid")
}

start_runner() {
  local name="$1" port="$2"; shift 2
  (cd "$ROOT" && env "$@" nohup .venv/bin/uvicorn runner.main:app --host 127.0.0.1 --port "$port" >"$WORK/$name.log" 2>&1 & echo $! >"$WORK/$name.pid")
}

start() {
  for port in 18080 19090 18091 28080 29090 28091; do
    if lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then echo "Port $port is in use; run stop first." >&2; exit 1; fi
  done
  mkdir -p "$WORK/keys" "$WORK/uat-runner-state" "$WORK/prod-runner-state" "$WORK/packages"
  for key in uat-artifact uat-package prod-artifact other-package system-package; do
    [ -f "$WORK/keys/$key.pem" ] || keypair "$key"
  done
  python3 - "$WORK" <<'PY'
import json, sys
from pathlib import Path
work = Path(sys.argv[1])
pem = lambda name: (work / "keys" / f"{name}.pub.pem").read_text()
(work / "trust.json").write_text(json.dumps({"sources": [
    {"id": "bank-uat", "name": "Bank UAT", "keys": [{"id": "uat-2026", "publicKeyPem": pem("uat-package")}]},
    {"id": "bank-uat-b", "name": "Second UAT", "keys": [{"id": "uat-b", "publicKeyPem": pem("other-package")}]},
    {"id": "bank-uat-system", "name": "UAT system baseline", "keys": [{"id": "system", "publicKeyPem": pem("system-package")}],
     "reservedGuardrailIds": ["guardrail-default"]},
]}, indent=2))
PY
  for db in guard_uat guard_prod; do
    psql "$PG/postgres" -qtc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 || psql "$PG/postgres" -qc "CREATE DATABASE $db"
  done
  # Always build the current UI: a stale dist would show yesterday's screens.
  (cd "$ROOT/controller" && npm run build:ui >/dev/null)
  local common=(NODE_ENV=development CONTROLLER_RUNNER_TOKEN="$RUNNER_TOKEN" BETTER_AUTH_SECRET="$AUTH_SECRET"
    CONTROLLER_UI_DIST="$ROOT/controller/dist" CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD="$PASSWORD" PATH="$PATH" HOME="$HOME")
  start_controller uat-controller "${common[@]}" CONTROLLER_DATABASE_URL="$PG/guard_uat" \
    CONTROLLER_HTTP_PORT=18080 CONTROLLER_GRPC_PORT=19090 CONTROLLER_PUBLIC_URL=http://localhost:18080 \
    BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:18080 CONTROLLER_RUNTIME_SERVICE_URL=http://localhost:18091 \
    CONTROLLER_ARTIFACT_SIGNING_KEY_PATH="$WORK/keys/uat-artifact.pem" CONTROLLER_BOOTSTRAP_ADMIN_EMAIL=admin@uat.local \
    CONTROLLER_PACKAGE_SOURCE_ID=bank-uat CONTROLLER_PACKAGE_SOURCE_NAME="Bank UAT" \
    CONTROLLER_PACKAGE_SIGNING_KEY_PATH="$WORK/keys/uat-package.pem" CONTROLLER_PACKAGE_SIGNING_KEY_ID=uat-2026
  start_controller prod-controller "${common[@]}" CONTROLLER_DATABASE_URL="$PG/guard_prod" \
    CONTROLLER_HTTP_PORT=28080 CONTROLLER_GRPC_PORT=29090 CONTROLLER_PUBLIC_URL=http://127.0.0.1:28080 \
    BETTER_AUTH_TRUSTED_ORIGINS=http://127.0.0.1:28080 CONTROLLER_RUNTIME_SERVICE_URL=http://127.0.0.1:28091 \
    CONTROLLER_ARTIFACT_SIGNING_KEY_PATH="$WORK/keys/prod-artifact.pem" CONTROLLER_BOOTSTRAP_ADMIN_EMAIL=admin@prod.local \
    CONTROLLER_AUTHORING_ENABLED=false CONTROLLER_POLICY_CATALOG_DIR=/nonexistent-policy-library \
    CONTROLLER_PACKAGE_TRUST_PATH="$WORK/trust.json"
  wait_for http://localhost:18080/health/ready "UAT Controller" "$WORK/uat-controller.log"
  wait_for http://127.0.0.1:28080/health/ready "PROD Controller" "$WORK/prod-controller.log"
  local runner=(GUARD_CONTROLLER_TOKEN="$RUNNER_TOKEN" GUARD_RUNNER_POOL_ID=default GUARD_RUNNER_MAX_CONCURRENCY=16 PATH="$PATH" HOME="$HOME")
  start_runner uat-runner 18091 "${runner[@]}" GUARD_RUNNER_ID=uat-runner-0 GUARD_RUNNER_COMPILER_CAPABLE=true \
    GUARD_CONTROLLER_TARGET=localhost:19090 GUARD_ARTIFACT_PUBLIC_KEY_PATH="$WORK/keys/uat-artifact.pub.pem" \
    GUARD_RUNNER_STATE_PATH="$WORK/uat-runner-state" GUARD_CONTROLLER_TELEMETRY_ENDPOINT=http://localhost:18080/api/internal/v1/runtime-events
  start_runner prod-runner 28091 "${runner[@]}" GUARD_RUNNER_ID=prod-runner-0 GUARD_RUNNER_COMPILER_CAPABLE=false \
    GUARD_CONTROLLER_TARGET=127.0.0.1:29090 GUARD_ARTIFACT_PUBLIC_KEY_PATH="$WORK/keys/prod-artifact.pub.pem" \
    GUARD_RUNNER_STATE_PATH="$WORK/prod-runner-state" GUARD_CONTROLLER_TELEMETRY_ENDPOINT=http://127.0.0.1:28080/api/internal/v1/runtime-events
  wait_for http://localhost:18091/health/live "UAT Runner" "$WORK/uat-runner.log"
  wait_for http://127.0.0.1:28091/health/live "PROD Runner" "$WORK/prod-runner.log"
  echo "Two isolated deployments are running. Work directory: $WORK"
  env_exports
}

stop() {
  for name in uat-runner prod-runner uat-controller prod-controller; do
    [ -f "$WORK/$name.pid" ] || continue
    local pid; pid="$(cat "$WORK/$name.pid")"
    kill "$pid" 2>/dev/null || true
    # A Runner may wait on its control-channel reconnect loop; do not leave it behind.
    for _ in $(seq 1 10); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$WORK/$name.pid"
  done
  # Never leave an older build serving: a new start would silently reuse it.
  for port in 18080 19090 18091 28080 29090 28091; do
    lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
  done
  echo "Stopped. Logs and keys remain in $WORK."
}

reset() {
  stop
  for db in guard_uat guard_prod; do psql "$PG/postgres" -qc "DROP DATABASE IF EXISTS $db WITH (FORCE)"; done
  rm -rf "$WORK/uat-runner-state" "$WORK/prod-runner-state" "$WORK/packages"
  echo "Reset both deployments; run start again."
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  reset) reset ;;
  env) env_exports ;;
  *) echo "Usage: $0 start|stop|reset|env" >&2; exit 2 ;;
esac
