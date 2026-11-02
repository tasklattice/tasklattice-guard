#!/usr/bin/env bash
set -Eeuo pipefail

# Run only for the bundled database, before its serving container starts.
# The official entrypoint initializes a new data directory itself.
: "${PGDATA:?PGDATA is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?The database credential is required}"
if [[ ! -s "$PGDATA/PG_VERSION" ]]; then
  echo 'New PostgreSQL data directory; initialization will use the current Secret.'
  exit 0
fi

sync_dir=$(mktemp -d /tmp/tali-pg-sync.XXXXXX)
server_pid=''
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill -INT "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf -- "$sync_dir"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# Trust applies only to a private Unix socket during this init container.
# No TCP listener is opened, and the stored authentication configuration is
# never changed. This also works when the old local connection requires auth.
chmod 700 "$sync_dir"
printf 'local all all trust\n' > "$sync_dir/pg_hba.conf"
postgres -D "$PGDATA" \
  -c listen_addresses='' \
  -c unix_socket_directories="$sync_dir" \
  -c unix_socket_permissions=0700 \
  -c hba_file="$sync_dir/pg_hba.conf" \
  -c logging_collector=off \
  -c log_statement=none \
  -c log_duration=off \
  -c log_min_duration_statement=-1 \
  -c log_min_duration_sample=-1 \
  -c log_min_error_statement=panic \
  > "$sync_dir/server.log" 2>&1 &
server_pid=$!

ready=false
for ((attempt = 0; attempt < 120; attempt++)); do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    break
  fi
  if pg_isready --host "$sync_dir" --username "$POSTGRES_USER" --dbname postgres >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  echo 'Retained PostgreSQL could not start for credential synchronization; check data compatibility and volume access.' >&2
  exit 1
fi

# Read credentials inside psql rather than placing them in process arguments.
# Identifier/literal quoting supports custom role names and passwords containing special characters.
# Neither SQL nor server diagnostics containing credentials enter Pod logs.
if ! psql --no-psqlrc --no-password --quiet --set ON_ERROR_STOP=1 \
  --host "$sync_dir" --username "$POSTGRES_USER" --dbname postgres \
  >/dev/null 2>&1 <<'SQL'
\getenv sync_role POSTGRES_USER
\getenv sync_value POSTGRES_PASSWORD
SELECT format('ALTER ROLE %I PASSWORD %L', :'sync_role', :'sync_value') \gexec
SQL
then
  echo 'PostgreSQL credential synchronization failed; verify the configured role exists and can update its login.' >&2
  exit 1
fi

kill -INT "$server_pid"
if ! wait "$server_pid"; then
  echo 'PostgreSQL did not stop cleanly after credential synchronization.' >&2
  exit 1
fi
server_pid=''
echo 'PostgreSQL credentials synchronized with the current Secret; existing data preserved.'
