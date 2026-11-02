# Authenticated contiguous telemetry delivery

Status: optional, default off. This stage implements current-control-session HTTP
upload authorization and durable contiguous WAL acknowledgements. It does **not**
enable scoped freshness, deletion safety or rollout-completion decisions. It was
verified with protocol/exporter unit tests and isolated real PostgreSQL HTTP
tests; no live deployment, infrastructure attestation or A/B/C upgrade is implied.

See [persistent rollout](runner-telemetry-progress-rollout.md) for the chart,
per-replica PVC, immutable StatefulSet update and controlled recovery requirements.

## Identity and authorization

Controller `CONTROLLER_RUNNER_TELEMETRY_PROGRESS=true` requires scoped telemetry
and pool credentials. Runner `GUARD_RUNNER_TELEMETRY_PROGRESS_ENABLED=true`
requires scoped telemetry and its pool control token. Both are explicit and
default false. Mixed settings fail closed when a progress-capable registration
cannot obtain authorization; they are not an automatic rolling-upgrade protocol.

1. The Runner keeps a stable random WAL ID on its persistent progress volume and
   includes it in typed gRPC registration.
2. After durable registration, Controller issues a random 256-bit HTTP upload
   capability to that exact pool-authenticated control stream. PostgreSQL stores
   only its SHA-256 hash, bound to the control session and retained WAL identity.
3. Typed `RegistrationAccepted` carries the secret plus Controller's durable
   acknowledged/produced cursors and last accepted batch ID/body digest. These
   fields are internal and excluded from public fleet/event APIs and metrics.
4. HTTP uploads require **both** the pool bearer and
   `X-TaskLattice-Telemetry-Capability`. Controller matches pool, Runner, boot,
   current durable session and WAL; every event's Runner ID must match. A body
   Runner ID, guessed WAL ID or another pool's bearer cannot select authority.
5. Disconnect, offline transition or session replacement invalidates the old
   capability through durable registration predicates. Runner also clears its
   in-memory upload capability on control loss.

The pool remains a shared trust domain. The pool bearer does not attest an
individual physical workload. A compromised member can attempt another
same-pool logical registration under existing registration rules; this protocol
does not establish hardware identity or defend against a compromised Controller,
database or trusted local volume. Use appropriate transport/network protection;
a capability sent over plaintext transport is not protected from network capture.

## Persistent Runner WAL

`runner/telemetry_progress.py` stores one atomic JSON snapshot with WAL ID,
acknowledged/produced cursors, contiguous records and at most one pending batch.
Each successful append receives the next safe-integer cursor. A separate
`GUARD_RUNNER_TELEMETRY_PROGRESS_PATH` can select persistent storage; its default
is the existing artifact state directory for non-chart compatibility. Helm uses
the separate PVC path and leaves the artifact cache unchanged.

The state is bounded to 8MiB and 10,000 records. Appends reserve 1KiB for pending
batch/checkpoint metadata, so filling the append budget cannot prevent batching
and draining existing evidence. Atomic replacement temporarily also needs a
replacement file and filesystem overhead. These are logical file bounds, not a
whole-process or filesystem quota. The chart's 64Mi claim is an allocation request,
not proof of durable fsync/rename/locking behavior.

Writes fsync the replacement file, atomically replace the snapshot and fsync its
directory. An exclusive file lock rejects a second writer for the same path.
Canceled callers cannot release the asynchronous writer lock while a background
disk write is still running. An uncertain I/O failure prevents further mutations
until restart/reconciliation, so old in-memory state cannot overwrite a write
that may already have committed. Capacity refusal preserves the prior state and
still permits its drain.

First opt-in refuses a nonempty legacy `runtime-events.wal`, checking the original
artifact state directory even with a separate progress volume. Drain it before
switching. The protocol does not silently import, delete or reset old evidence.

## Batches, lost replies and reconnects

The Runner selects a contiguous prefix, respecting configured batch size
(1–1,000), 8MiB HTTP body, depth 64, 100,000 structural-character and model-call
budgets. Each event may contain at most 64 metered model calls; a batch at most 256.
For example, six records with 48 calls each are sent as five records followed by one. Prefix
selection occurs **before** freezing the pending batch. The pending batch ID,
cursor range and produced-tail cursor are persisted, and the exact JSON body is
reconstructed consistently while new records append behind it.

An individually unsendable event cannot be split by this protocol. It remains
retained and blocks advancement with an explicit error; later records are not
silently skipped. Operators must reconcile it. Already pending batches and
compiled client/server budgets require coordinated versions. Legacy senders also
face the server's resource budgets and can require reconciliation of oversized
batches; compatibility does not mean unlimited request size or work.

Controller accepts a new batch only when `firstCursor == acknowledged + 1` and
its contiguous range matches its record count. Reported produced tail cannot
regress or precede the batch. Under one transaction it authenticates the current
session, performs every runtime/cost/routing event disposition, and advances the
WAL checkpoint. Intentional retention/reset filters and quarantine are terminal
dispositions too; an ACK does not claim every record is tenant-visible or stored
indefinitely. A parser/schema error or transaction failure advances no cursor.

A lost reply causes the same pending batch to replay. Matching last batch ID,
raw UTF-8 body SHA-256 and range return the previous ACK without repeating writes.
A different payload at the same cursor, overlap, gap or unknown replay fails.
Registration returns that same last-batch proof after reconnect. The Runner
compacts only when its retained pending ID **and exact body digest** match, rather
than trusting a cursor alone. A structurally valid restored WAL with different
payload at the same cursor therefore cannot silently disappear as acknowledged.

Controller refuses a changed WAL ID for an already known logical Runner/pool.
The Runner refuses Controller rollback behind locally compacted history, a
Controller-produced tail beyond its local history, partial-batch ACKs and other
uncertain checkpoints. Preserve PostgreSQL and the corresponding PVC together;
there is no automatic identity reset or dead-letter/skip workflow.

## Transactions and bounded ingress

Ingest locks the current `runner_instance` row `FOR SHARE`, then its WAL row
`FOR UPDATE`. Cooperating registration/disconnection writers atomically update
that Runner row, so a takeover cannot commit during upload. It deliberately does
not lock both Runner and session rows: existing writers acquire those in
different orders. Separate Runner uploads can proceed concurrently.

Before context access, mixed batches acquire the combined sorted Guardrail share
locks, then Endpoint context lifecycle shared locks. Context issuance/retirement
and retention use the corresponding exclusive lifecycle lock. Runtime, cost,
routing and checkpoint writes commit/roll back together. No allocation or
generation lock is acquired after a context-reader lock.

There is no global allocation lock around the whole upload. Nevertheless a
concurrent same-Runner registrar can hold that lock while awaiting its Runner
row, indirectly delaying unrelated Controller work. PostgreSQL/storage and
Controller processes remain shared. This is not absolute latency isolation or a
total transaction-duration guarantee.

All telemetry modes authenticate **before reading**. Per HTTP-app admission
allows at most 4 concurrent uploads, at most 2 per pool, with no queue. The permit
covers bounded reading, parsing and persistence and is released on every exit.
The reader always counts actual stream bytes even with a lying Content-Length,
limits reads to 10 seconds, rejects invalid UTF-8, depth beyond 64 and more than
100,000 structural characters outside strings before JSON parsing, and cancels
rejected readers. Metered-call work is bounded before starting transactions.
Resource exhaustion/timeout returns the corresponding error and a retry hint;
the Runner retains evidence. These bounds limit one input path, not total
Controller heap, CPU, database disk, connection usage or external work.

## What diagnostics mean

An empty progress report is accepted only at the durable acknowledged cursor,
with no previously reported unacknowledged tail. It records `caught_up_at` as a
delivery diagnostic. New session authorization clears that diagnostic. Empty
reports are currently replayable under a still-current capability; they are not
a replay-resistant liveness challenge, wall-clock freshness proof or proof that
all active pipelines already emitted their future evidence.

This path never writes legacy `telemetry_watermark`. Existing scoped Router
distribution/deletion/rollout freshness remains hard-disabled. Before using
progress as authority, implement a separate replay-resistant observation and
coverage policy for active work, all expected Runner boots, loss/retention,
failover/rollback and offline members. Authentication and contiguous accepted
prefixes alone do not prove a lossless complete history of executed requests.

Disabling progress requires a controlled drain and checkpoint reconciliation.
When the progress path is visible, the exporter refuses legacy mode for pending,
malformed, unknown or actively locked progress state; a validated drained WAL
can remain. Python cannot inspect an unmounted/lost PVC, so this check does not
certify a safe chart downgrade. Preserve claims/database records and follow the
rollout document; never delete evidence merely to make startup succeed.

## Verification

- `test_telemetry_progress.py`: exact pending replay, digest-bound reconnect,
  cancellation/fsync uncertainty, file lock, capacity/headroom, adaptive heavy
  traces, individual-budget failures, separate mount/legacy gate, downgrade,
  typed control authorization and absence of upload secrets from WAL state.
- `telemetry-progress.postgres.test.ts`: pool/session authentication, Runner
  spoofing, durable hash-only secret, mixed runtime/cost/routing ACK rollback,
  duplicate/different/gapped batches, boot/session replacement, refused identity
  reset, independent-Runner concurrency and a takeover blocked until commit.
- HTTP reader/budget/wiring tests: unauthorized unread bodies, lying lengths,
  chunked overflow, malformed UTF-8, structural/work budgets, capacity/release and
  retained legacy response shapes. Protocol generation and TypeScript are checked
  by project scripts. These tests do not certify a live PVC/CNI/fencer deployment.
