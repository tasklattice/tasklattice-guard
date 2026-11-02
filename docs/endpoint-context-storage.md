# Bounded Endpoint provenance storage

Migration0062 and `endpoint-telemetry-contexts.ts` bound new provenance allocations in scoped telemetry mode. Defaults do not mint contexts in legacy mode. These are logical metadata budgets, not PostgreSQL disk, heap, connection, CPU or I/O isolation.

| Budget | Default | Environment variable suffix after `CONTROLLER_ENDPOINT_CONTEXT_` |
| --- | --- | --- |
| Retained + active rows per pool |256 |MAX_ROWS_PER_POOL |
| Retained + active rows globally |2048 |MAX_ROWS_GLOBAL |
| Logical payload per context |64KiB |MAX_PAYLOAD_BYTES_PER_CONTEXT |
| Logical payload per pool |16MiB |MAX_PAYLOAD_BYTES_PER_POOL |
| Logical payload globally |64MiB |MAX_PAYLOAD_BYTES_GLOBAL |

Helm accepts a complete `controller.endpointContextStorage` object with the corresponding camelCase names. Policies require positive bounded integers and context <= pool <= global budgets. Counts/bytes are caps, not reserved capacity. Shared global capacity and database infrastructure remain shared. Very large published Router target sets may exceed the context payload budget and require an explicit resource-policy decision before rollout.

A PostgreSQL generated column measures UTF-8 identity/digest bytes, JSONB target text and a fixed metadata allowance. It does not count table/index/TOAST/WAL files, transient query/JSON memory, dead tuples, or external backups. Issuance measures pending rows by the identical SQL expression before retiring/inserting authority. A global transaction advisory lock serializes counting/issuance/cleanup across Controllers. Capacity exhaustion returns503 `endpoint_context_capacity_exhausted`; existing authority and referenced evidence remain intact.

Unchanged active authority is reused across unrelated desired-state generations. The immutable record retains its original issuance generation; it is not itself a serving lease. Verifier, Endpoint snapshot, Router revision/targets, tenant/group/pool or epoch changes create a new incarnation. Reissuing a previously retired configuration creates a fresh256-bit random context ID and never revives old authority. A partial unique index permits at most one active context per(pool,Endpoint). Existing duplicate active rows require operator review during migration. After lowering budgets, existing matching authority can still be reused; new allocation is refused until it fits.

Retired contexts remain for at least31 database days, conservatively covering the30-day event replay window plus10-minute retirement grace. Active or runtime/cost/routing-referenced contexts are never automatically evicted. Referenced history can therefore eventually exhaust the configured budget during legitimate configuration churn: coordinate evidence archive/retention or raise an explicit budget; do not delete grant/provenance history to bypass checks.

Independent periodic maintenance runs once per minute in scoped mode. A persisted sweep cursor visits at most128 retired rows per tick and wraps, so protected old history does not permanently hide later unreferenced candidates. The cursor preserves PostgreSQL timestamp precision. Issuance also attempts one bounded batch; a failed issuance rolls back its inline cleanup, so periodic maintenance is necessary for independent progress. Cleanup has a retired-time/ID index and indexed references. Database clock jumps/failover can change physical retention; uncertain/missing context fails attribution closed. These records are not time-based serving authority.

Context-backed writers hold a shared lifecycle transaction lock through evidence and progress-ACK commit; issuance, retirement and cleanup take the exclusive form. Writers first take sorted Guardrail locks and do not acquire allocation/generation locks afterward. This prevents cleanup from racing uncommitted evidence references while allowing independent readers/ingestion concurrently. Tests exercise real PostgreSQL concurrency, exact Unicode payload measurement, caps, rollback, generation reuse, retirement/reincarnation, reference protection and bounded sweep progress.
