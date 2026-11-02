# Endpoint runtime telemetry provenance

Status: optional scoped Endpoint **runtime events, model costs and routing
assignments/completions** implemented; unsupported provenance remains
platform-only and scoped watermarks remain disabled. This increment does not make deletion safety or Router distribution
freshness available. Existing records without trusted context remain unknown.

When scoped telemetry is enabled, `desiredStateForPool` persists a random opaque
256-bit context ID for each exact Endpoint snapshot. It freezes tenant, group, pool, epoch,
original issuance generation, adapter, verification digest, Endpoint snapshot digest, Router
revision/digest and enabled target identities. Snapshot construction holds the
allocation lock and Controller generation share lock. The context is projected
only over the internal desired-state protocol; it is never an Endpoint client
header or public assignment field. Ingestion looks up the persisted row, so a
separate signature is unnecessary: the ID is looked up together with the
authenticated pool principal, and cannot supply or change authority fields.
It is not a standalone credential or a serving lease.

The Runner authenticates an Endpoint and captures its verifier, adapter, Router,
artifact references and context in one store snapshot. Concurrent replacement
cannot relabel that request. The immutable context follows its selected plan,
input/output call pin, Redis pin, streaming checks and WAL event. Public headers
or request fields cannot set it. Internal Playground path probes do not obtain
Endpoint provenance merely by naming an Endpoint.

Scoped ingestion matches the authenticated pool, Endpoint, adapter/protocol,
Router revision and exact route/target/Guardrail version against that archive.
Runtime events and costs use the same owner resolver. Routing ingestion also
matches assignment status and every frozen routing identity; unassigned events
cannot claim a target or Guardrail. Unknown, missing,
foreign-pool or conflicting contexts stay platform-only; mixed batches still
receive acknowledgement so invalid evidence does not block genuine WAL replay.
Context IDs are persisted internally and omitted from public event detail/list
and assignment responses.

Assignment and completion retries retain the same decision, context and frozen
identity. A different pool or context cannot enrich that decision; a valid new
event never promotes an old unknown assignment into tenant history. Completion
may arrive before assignment, and legitimate delayed matching completions keep
their original owner. Routing writes can join the telemetry cursor transaction,
so a failed ACK rolls back its evidence. Scoped routing events never advance
legacy watermarks.

Replacement retires the old context; both immediate allocation moves and the
prepared move finalizer retire source contexts in their commit transaction.
Genuine delayed events retain the archived tenant after current ownership or
allocation changes. Event time permits five minutes of clock skew, at most
30 days of delivery delay, and ten minutes after retirement (five-minute call
pin plus five-minute skew). A long request, stream or lagging last-known-good
Runner beyond that retirement grace is quarantined. This deliberately favors
unambiguous attribution over complete monitoring during prolonged lag.

PostgreSQL rejects changes to context authority, issue time, identifiers or
snapshots. Retirement can be set once and cannot be reset. Reissuing a retired
authority creates a new context incarnation and preserves the old retirement.
Deletion is allowed only after 31 days of retirement and when no runtime event,
model cost or routing assignment references the context. Issuance performs
bounded cleanup (at most 128 eligible rows), and the maintenance helper can run
independently. Unchanged active authority is reused across unrelated generation
changes. Default logical budgets are 256 rows per pool, 2,048 globally, 64 KiB
per context, 16 MiB per pool and 64 MiB globally; a full budget rejects new
authority while retaining existing evidence. These are logical payload budgets,
not PostgreSQL disk/heap quotas.

The Runner pool is a trust domain. A compromised Runner can fabricate evidence
for Endpoints legitimately issued to its own pool/group; this mechanism prevents
cross-pool attribution and ordinary clients choosing authority, not attestation
of execution. Event timestamps are trusted within that domain. A pin originating
in another pool is not authority for the receiving pool and is quarantined.
Proving fresh delivery per Runner/boot requires a separate authenticated live
session and WAL completeness protocol before scoped watermarks can be enabled.

Evidence: `endpoint-context-telemetry.postgres.test.ts` covers archived owner,
cost attribution, pool/identity mismatch, retirement, delayed replay, public DTOs
and database immutability. `routing-context-telemetry.postgres.test.ts` covers
complete routing identities, cross-pool/context denial, replay, historical
quarantine and transaction rollback. `test_endpoint_telemetry_context.py` exercises real
NeMo LiteLLM, Scan and WebSocket pipelines, a verifier-replacement race, input/
output pinning, Redis serialization, forged fields and response redaction.
