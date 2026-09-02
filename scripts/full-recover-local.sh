#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
STATE_ROOT="${ROOT_DIR}/.tasklattice-recovery"
LOG_DIR="${STATE_ROOT}/logs"
PID_DIR="${STATE_ROOT}/pids"
KEY_DIR="${STATE_ROOT}/keys"
RUNNER_STATE_DIR="${STATE_ROOT}/runner-state"

ENV_FILE="${ROOT_DIR}/.env"
ENV_EXAMPLE="${ROOT_DIR}/.env.example"

PG_CONTAINER="${PG_CONTAINER:-tali-local-postgres}"
PG_IMAGE="${PG_IMAGE:-postgres:17-alpine}"
PG_HOST="${PG_HOST:-127.0.0.1}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-guard}"
PG_PASSWORD="${PG_PASSWORD:-guard}"
PG_DB="${PG_DB:-guard}"

CONTROLLER_HTTP_PORT="${CONTROLLER_HTTP_PORT:-8080}"
CONTROLLER_GRPC_PORT="${CONTROLLER_GRPC_PORT:-9090}"
RUNNER_HTTP_PORT="${RUNNER_HTTP_PORT:-8091}"
UI_HTTP_PORT="${UI_HTTP_PORT:-8092}"

START_UI=1
SYNC_DEPS=1
DRY_RUN=0
ENV_BACKUP_PATH=""

usage() {
  cat <<'EOF'
Usage: scripts/full-recover-local.sh [options]

Recovers the TaskLattice Guard local host-mode stack by:
1. preparing a runnable .env,
2. generating artifact signing keys,
3. starting or reusing local PostgreSQL,
4. stopping stale local controller/runner/UI processes,
5. syncing dependencies,
6. starting controller, runner, and optional Vite UI,
7. waiting for health endpoints to pass.

Options:
  --no-ui      Skip the Vite UI server on port 8092
  --no-sync    Skip "make sync"
  --dry-run    Print actions without executing them
  --help       Show this help text
EOF
}

log() {
  printf '[recover] %s\n' "$*"
}

warn() {
  printf '[recover] WARN: %s\n' "$*" >&2
}

fail() {
  printf '[recover] ERROR: %s\n' "$*" >&2
  exit 1
}

run() {
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    printf '+'
    for arg in "$@"; do
      printf ' %q' "$arg"
    done
    printf '\n'
    return 0
  fi
  "$@"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

require_command() {
  local command_name="$1"
  command_exists "${command_name}" || fail "Required command not found: ${command_name}"
}

ensure_dirs() {
  run mkdir -p "${LOG_DIR}" "${PID_DIR}" "${KEY_DIR}" "${RUNNER_STATE_DIR}"
}

backup_env_once() {
  if [[ -n "${ENV_BACKUP_PATH}" || ! -f "${ENV_FILE}" ]]; then
    return 0
  fi
  ENV_BACKUP_PATH="${ENV_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
  run cp "${ENV_FILE}" "${ENV_BACKUP_PATH}"
  log "Backed up .env to ${ENV_BACKUP_PATH}"
}

ensure_env_file() {
  if [[ -f "${ENV_FILE}" ]]; then
    return 0
  fi
  [[ -f "${ENV_EXAMPLE}" ]] || fail "Missing ${ENV_EXAMPLE}"
  log "Creating ${ENV_FILE} from ${ENV_EXAMPLE}"
  run cp "${ENV_EXAMPLE}" "${ENV_FILE}"
}

read_env_value() {
  local key="$1"
  [[ -f "${ENV_FILE}" ]] || return 1
  awk -F= -v key="${key}" '$1 == key { print substr($0, length(key) + 2) }' "${ENV_FILE}" | tail -n 1
}

write_env_value() {
  local key="$1"
  local value="$2"
  local temp_file
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    printf '+ write_env %s=%q\n' "${key}" "${value}"
    return 0
  fi
  backup_env_once
  temp_file="$(mktemp)"
  awk -v key="${key}" -v value="${value}" '
    BEGIN { updated = 0 }
    $0 ~ ("^" key "=") {
      print key "=" value
      updated = 1
      next
    }
    { print }
    END {
      if (!updated) {
        print key "=" value
      }
    }
  ' "${ENV_FILE}" > "${temp_file}"
  mv "${temp_file}" "${ENV_FILE}"
}

random_secret() {
  openssl rand -hex 24
}

is_real_secret() {
  local value="${1:-}"
  [[ -n "${value}" && "${value}" != replace-* && "${value}" != "<"* && "${#value}" -ge 32 ]]
}

is_real_api_key() {
  local value="${1:-}"
  [[ -n "${value}" && "${value}" != replace-* && "${value}" != replace-me* && "${value}" != "<"* ]]
}

ensure_signing_keys() {
  local private_key="${KEY_DIR}/guard-private.pem"
  local public_key="${KEY_DIR}/guard-public.pem"
  if [[ ! -f "${private_key}" || ! -f "${public_key}" ]]; then
    log "Generating Ed25519 signing keypair"
    run openssl genpkey -algorithm ED25519 -out "${private_key}"
    run openssl pkey -in "${private_key}" -pubout -out "${public_key}"
  fi
  write_env_value "CONTROLLER_ARTIFACT_SIGNING_KEY_PATH" "${private_key}"
  write_env_value "GUARD_ARTIFACT_PUBLIC_KEY_PATH" "${public_key}"
}

normalize_local_env() {
  local controller_token
  local runner_token
  local metrics_token
  local auth_secret
  local control_plane_api_key
  local deepseek_api_key
  local nvidia_api_key
  local automated_reasoning_endpoint
  local automated_reasoning_api_key

  ensure_env_file

  controller_token="$(read_env_value CONTROLLER_RUNNER_TOKEN || true)"
  runner_token="$(read_env_value GUARD_CONTROLLER_TOKEN || true)"
  if ! is_real_secret "${controller_token}" || [[ "${controller_token}" != "${runner_token}" ]]; then
    controller_token="$(random_secret)"
    write_env_value "CONTROLLER_RUNNER_TOKEN" "${controller_token}"
    write_env_value "GUARD_CONTROLLER_TOKEN" "${controller_token}"
  fi

  metrics_token="$(read_env_value CONTROLLER_METRICS_TOKEN || true)"
  if ! is_real_secret "${metrics_token}"; then
    metrics_token="$(random_secret)"
  fi
  write_env_value "CONTROLLER_METRICS_TOKEN" "${metrics_token}"
  write_env_value "GUARD_METRICS_TOKEN" "${metrics_token}"

  auth_secret="$(read_env_value BETTER_AUTH_SECRET || true)"
  if ! is_real_secret "${auth_secret}"; then
    auth_secret="$(random_secret)"
    write_env_value "BETTER_AUTH_SECRET" "${auth_secret}"
  fi

  control_plane_api_key="$(read_env_value MODEL_GUARDRAILS_CONTROL_PLANE_AI_API_KEY || true)"
  deepseek_api_key="$(read_env_value DEEPSEEK_API_KEY || true)"
  if ! is_real_api_key "${control_plane_api_key}" && is_real_api_key "${deepseek_api_key}"; then
    write_env_value "MODEL_GUARDRAILS_CONTROL_PLANE_AI_API_KEY" "${deepseek_api_key}"
  fi

  write_env_value "NODE_ENV" "development"
  write_env_value "CONTROLLER_HTTP_HOST" "0.0.0.0"
  write_env_value "CONTROLLER_HTTP_PORT" "${CONTROLLER_HTTP_PORT}"
  write_env_value "CONTROLLER_GRPC_HOST" "0.0.0.0"
  write_env_value "CONTROLLER_GRPC_PORT" "${CONTROLLER_GRPC_PORT}"
  write_env_value "CONTROLLER_DATABASE_URL" "postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${PG_DB}"
  write_env_value "CONTROLLER_PUBLIC_URL" "http://localhost:${CONTROLLER_HTTP_PORT}"
  write_env_value "CONTROLLER_RUNTIME_SERVICE_URL" "http://localhost:${RUNNER_HTTP_PORT}"
  write_env_value "BETTER_AUTH_TRUSTED_ORIGINS" "http://localhost:${CONTROLLER_HTTP_PORT},http://localhost:${UI_HTTP_PORT}"
  write_env_value "CONTROLLER_ALLOW_LOCAL_DEFAULT_CREDENTIALS" "true"
  write_env_value "CONTROLLER_BOOTSTRAP_ADMIN_EMAIL" "admin@tasklattice.local"
  write_env_value "CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD" "admin"
  write_env_value "CONTROLLER_BOOTSTRAP_ADMIN_NAME" "Local Administrator"

  write_env_value "GUARD_RUNNER_ID" "local-default-1"
  write_env_value "GUARD_RUNNER_POOL_ID" "default"
  write_env_value "GUARD_RUNNER_COMPILER_CAPABLE" "true"
  write_env_value "GUARD_RUNNER_MAX_CONCURRENCY" "64"
  write_env_value "GUARD_CONTROLLER_TARGET" "localhost:${CONTROLLER_GRPC_PORT}"
  write_env_value "GUARD_CONTROLLER_TELEMETRY_ENDPOINT" "http://localhost:${CONTROLLER_HTTP_PORT}/api/internal/v1/runtime-events"
  write_env_value "GUARD_RUNNER_STATE_PATH" "${RUNNER_STATE_DIR}"

  nvidia_api_key="$(read_env_value NVAPI_API_KEY || true)"
  if ! is_real_api_key "${nvidia_api_key}"; then
    nvidia_api_key="$(read_env_value MODEL_GUARDRAILS_NVIDIA_API_KEY || true)"
  else
    write_env_value "MODEL_GUARDRAILS_NVIDIA_API_KEY_ENV_VAR" "NVAPI_API_KEY"
  fi
  if ! is_real_api_key "${nvidia_api_key}"; then
    log "No NVIDIA API key found; disabling optional runner evaluators so the runner can boot locally"
    write_env_value "MODEL_GUARDRAILS_NVIDIA_BASE_URL" ""
    write_env_value "MODEL_GUARDRAILS_CONTENT_SAFETY_MODEL" ""
    write_env_value "MODEL_GUARDRAILS_TOPIC_CONTROL_MODEL" ""
    write_env_value "MODEL_GUARDRAILS_JAILBREAK_MODEL" ""
    write_env_value "MODEL_GUARDRAILS_GROUNDING_MODEL" ""
  fi

  automated_reasoning_endpoint="$(read_env_value MODEL_GUARDRAILS_AUTOMATED_REASONING_ENDPOINT_URL || true)"
  automated_reasoning_api_key="$(read_env_value MODEL_GUARDRAILS_AUTOMATED_REASONING_API_KEY || true)"
  if [[ -n "${automated_reasoning_endpoint}" ]] && ! is_real_api_key "${automated_reasoning_api_key}"; then
    warn "Automated reasoning endpoint is configured without an API key; disabling it for local recovery"
    write_env_value "MODEL_GUARDRAILS_AUTOMATED_REASONING_ENDPOINT_URL" ""
  fi
}

port_pids() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true
}

kill_matching_port_processes() {
  local port="$1"
  local pattern="$2"
  local description="$3"
  local pid
  local command_line

  while read -r pid; do
    [[ -n "${pid}" ]] || continue
    command_line="$(ps -p "${pid}" -o command= 2>/dev/null || true)"
    if [[ "${command_line}" =~ ${pattern} ]]; then
      log "Stopping ${description} process on port ${port}: pid ${pid}"
      run kill "${pid}"
      if [[ "${DRY_RUN}" -eq 0 ]]; then
        for _ in $(seq 1 20); do
          if ! kill -0 "${pid}" 2>/dev/null; then
            break
          fi
          sleep 1
        done
        if kill -0 "${pid}" 2>/dev/null; then
          warn "Process ${pid} did not exit after SIGTERM; sending SIGKILL"
          kill -9 "${pid}" 2>/dev/null || true
        fi
      fi
    else
      warn "Port ${port} is busy with a non-TaskLattice process; leaving it untouched: ${command_line}"
    fi
  done < <(port_pids "${port}")
}

stop_stale_processes() {
  kill_matching_port_processes "${CONTROLLER_HTTP_PORT}" 'tasklattice-guard|server/index\.ts|dist-server/server/index\.js' "controller"
  kill_matching_port_processes "${RUNNER_HTTP_PORT}" 'tasklattice-guard|runner\.main:app|uvicorn' "runner"
  if [[ "${START_UI}" -eq 1 ]]; then
    kill_matching_port_processes "${UI_HTTP_PORT}" 'tasklattice-guard|vite --host 0\.0\.0\.0 --port 8092|vite' "UI"
  fi
}

container_exists() {
  command_exists docker || return 1
  docker ps -a --format '{{.Names}}' | grep -Fx "${PG_CONTAINER}" >/dev/null 2>&1
}

container_running() {
  command_exists docker || return 1
  docker ps --format '{{.Names}}' | grep -Fx "${PG_CONTAINER}" >/dev/null 2>&1
}

ensure_postgres() {
  local listener_pid

  if container_exists && ! container_running; then
    log "Starting existing PostgreSQL container ${PG_CONTAINER}"
    run docker start "${PG_CONTAINER}"
  fi

  listener_pid="$(port_pids "${PG_PORT}" | head -n 1 || true)"
  if [[ -z "${listener_pid}" ]]; then
    if container_running; then
      :
    else
      require_command docker
      log "Starting local PostgreSQL container ${PG_CONTAINER}"
      run docker run -d \
        --name "${PG_CONTAINER}" \
        -e "POSTGRES_USER=${PG_USER}" \
        -e "POSTGRES_PASSWORD=${PG_PASSWORD}" \
        -e "POSTGRES_DB=${PG_DB}" \
        -p "${PG_PORT}:5432" \
        "${PG_IMAGE}"
    fi
  else
    log "Port ${PG_PORT} is already listening; reusing the existing PostgreSQL service"
  fi

  if container_running; then
    log "Waiting for PostgreSQL container readiness"
    if [[ "${DRY_RUN}" -eq 0 ]]; then
      for _ in $(seq 1 60); do
        if docker exec "${PG_CONTAINER}" pg_isready -U "${PG_USER}" -d "${PG_DB}" >/dev/null 2>&1; then
          return 0
        fi
        sleep 1
      done
      fail "PostgreSQL container ${PG_CONTAINER} did not become ready"
    fi
    return 0
  fi

  if command_exists psql; then
    log "Waiting for external PostgreSQL readiness"
    if [[ "${DRY_RUN}" -eq 0 ]]; then
      for _ in $(seq 1 30); do
        if PGPASSWORD="${PG_PASSWORD}" psql \
          "postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DB}" \
          -c 'select 1' >/dev/null 2>&1; then
          return 0
        fi
        sleep 1
      done
      fail "PostgreSQL on ${PG_HOST}:${PG_PORT} is listening but not reachable with the configured guard credentials"
    fi
    return 0
  fi

  warn "PostgreSQL is listening on ${PG_HOST}:${PG_PORT}, but psql is unavailable so connectivity was not verified"
}

sync_dependencies() {
  if [[ "${SYNC_DEPS}" -eq 0 ]]; then
    log "Skipping dependency sync"
    return 0
  fi
  log "Syncing Python and controller dependencies"
  run make -C "${ROOT_DIR}" sync
}

start_background_service() {
  local name="$1"
  local log_file="${LOG_DIR}/${name}.log"
  local pid_file="${PID_DIR}/${name}.pid"
  shift

  log "Starting ${name}"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    printf '+ start %s -> %q\n' "${name}" "$*"
    return 0
  fi

  nohup "$@" >"${log_file}" 2>&1 &
  echo "$!" > "${pid_file}"
}

wait_for_http_ok() {
  local name="$1"
  local url="$2"
  local attempts="${3:-60}"
  local delay="${4:-1}"
  local http_code

  if [[ "${DRY_RUN}" -eq 1 ]]; then
    printf '+ wait_for_http_ok %s %s\n' "${name}" "${url}"
    return 0
  fi

  log "Waiting for ${name}: ${url}"
  for _ in $(seq 1 "${attempts}"); do
    http_code="$(curl -sS -o /dev/null -w '%{http_code}' "${url}" || true)"
    if [[ "${http_code}" == "200" ]]; then
      return 0
    fi
    sleep "${delay}"
  done
  return 1
}

show_recent_logs() {
  local log_file="$1"
  if [[ -f "${log_file}" ]]; then
    warn "Last 40 lines from ${log_file}:"
    tail -n 40 "${log_file}" >&2 || true
  fi
}

start_controller() {
  start_background_service "controller" bash -lc "
    set -euo pipefail
    set -a
    source \"${ENV_FILE}\"
    set +a
    cd \"${ROOT_DIR}/controller\"
    exec npm run dev
  "
  if ! wait_for_http_ok "controller live health" "http://127.0.0.1:${CONTROLLER_HTTP_PORT}/health/live" 90 1; then
    show_recent_logs "${LOG_DIR}/controller.log"
    fail "Controller failed to become healthy"
  fi
}

start_runner() {
  start_background_service "runner" bash -lc "
    set -euo pipefail
    set -a
    source \"${ENV_FILE}\"
    set +a
    cd \"${ROOT_DIR}\"
    exec uv run uvicorn runner.main:app --host 0.0.0.0 --port ${RUNNER_HTTP_PORT}
  "
  if ! wait_for_http_ok "runner readiness" "http://127.0.0.1:${RUNNER_HTTP_PORT}/health/ready" 120 1; then
    show_recent_logs "${LOG_DIR}/runner.log"
    fail "Runner failed to become ready"
  fi
}

start_ui() {
  if [[ "${START_UI}" -eq 0 ]]; then
    return 0
  fi
  start_background_service "ui" bash -lc "
    set -euo pipefail
    set -a
    source \"${ENV_FILE}\"
    set +a
    cd \"${ROOT_DIR}/controller\"
    exec npm run dev:ui
  "
  if ! wait_for_http_ok "Vite UI" "http://127.0.0.1:${UI_HTTP_PORT}" 90 1; then
    show_recent_logs "${LOG_DIR}/ui.log"
    fail "UI failed to become reachable"
  fi
}

print_summary() {
  cat <<EOF

[recover] Local recovery completed successfully.
[recover] Controller: http://127.0.0.1:${CONTROLLER_HTTP_PORT}
[recover] Runner:     http://127.0.0.1:${RUNNER_HTTP_PORT}
EOF
  if [[ "${START_UI}" -eq 1 ]]; then
    printf '[recover] UI:         http://127.0.0.1:%s\n' "${UI_HTTP_PORT}"
  fi
  cat <<EOF
[recover] Login:      admin / admin
[recover] Logs:       ${LOG_DIR}

[recover] Notes:
[recover] - The script disables optional NVIDIA runner evaluators unless an API key is already present in .env.
[recover] - Controller authoring and Playground model features still require a valid control-plane model API key if you want those endpoints to work.
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --no-ui)
        START_UI=0
        ;;
      --no-sync)
        SYNC_DEPS=0
        ;;
      --dry-run)
        DRY_RUN=1
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        fail "Unknown option: $1"
        ;;
    esac
    shift
  done
}

main() {
  parse_args "$@"
  require_command openssl
  require_command curl
  require_command lsof
  require_command uv
  require_command npm
  require_command node

  ensure_dirs
  normalize_local_env
  ensure_signing_keys
  ensure_postgres
  stop_stale_processes
  sync_dependencies
  start_controller
  start_runner
  start_ui
  print_summary
}

main "$@"
