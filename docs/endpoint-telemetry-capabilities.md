# Endpoint telemetry provenance: implementation and remaining work

Status on 1 November 2026: runtime, model-cost and routing assignment/completion provenance are implemented and tested. Bounded issuance/retention is implemented in0062; routing references in0063; session-authenticated contiguous delivery diagnostics in0064. Authoritative freshness decisions remain disabled. No deployment is implied.

## Implemented path

1. In scoped telemetry mode, `ControlPlaneService.desiredStateForPool` takes the allocation advisory lock and a Controller generation share lock in a READ COMMITTED transaction before projecting runtime state. Legacy mode does not mint these contexts.
2. Migration0061 records an opaque context ID and immutable tenant/group/pool/epoch/generation, Endpoint adapter/verifier/snapshot digests and frozen Router revision/allowed targets. Database triggers reject authority changes, retirement reversal, and deletion of live/recent/referenced rows. A retired configuration receives a fresh context incarnation; retired records are never revived. Source contexts retire transactionally during allocation changes.
3. Generated `EndpointRuntime` carries the context only to the allocated pool. Runner Endpoint authentication captures a private snapshot handle under the ArtifactStore lock, retaining the verifier, Router/artifact references and provenance together across a later state swap.
4. LiteLLM, Scan and WebSocket runtime resolutions carry the context separately through decisions, call pins, Redis serialization and durable telemetry. Public request headers/body cannot select it. Public path headers and runtime-event DTOs omit the internal field.
5. Pool-authenticated runtime/cost ingestion derives ownership from the archived context, exact Endpoint/protocol, frozen Router revision and route/target/Guardrail/version. Unknown, missing, mismatched or unsupported evidence is quarantined. Enrichment also matches immutable context identity; invalid supplied context cannot upgrade historical quarantine.
6. Historical records preserve their original owner after moves. Acceptance bounds include five minutes of issuance clock skew, ten minutes after retirement (pin TTL plus skew), thirty days of occurred-time replay, and no more than five minutes into database time's future. Long streams/last-known-good serving beyond the retirement grace may produce quarantined evidence. Revoking the old pool bearer also prevents its replay; no insecure replay bypass is added.

## Trust and limits

The pool is a shared trust domain. A compromised Runner can fabricate evidence using contexts issued to that pool, including for tenants sharing it; it cannot use another pool's context through scoped ingestion. This is allocation provenance, not proof that a request executed and not a serving lease. A pool bearer does not authenticate a claimed Runner/boot identity.

The current implementation uses a256-bit random context identifier, stored for lookup. It is not a hash-only capability store. The authenticated pool principal remains required independently. Verifier/snapshot digests do not contain plaintext Endpoint credentials, and internal context IDs must stay out of public DTOs, logs and metric labels.

Context rows retain their original issuance generation and referenced history. Unchanged active authorization is reused across unrelated generations. [Storage budgets and bounded cleanup](endpoint-context-storage.md) include per-pool/global rows and logical payload bytes,31-day conservative retention and reference protection. These limits do not isolate physical database infrastructure.

## Remaining work

- Routing assignment/completion now validates frozen route identity and historical pins; unknown/conflicting evidence remains quarantined. Globally unique event/decision IDs still need scoped-key migration to remove cross-pool ID-preemption availability risks.
- [Session-authenticated contiguous telemetry delivery](authenticated-telemetry-progress.md) is implemented, but empty receipts remain diagnostics. A stronger quiescence/completeness protocol is required before freshness-based deletion/rollout guarantees.
- Coordinate referenced-history archive and retention; finite budgets intentionally refuse new contexts rather than deleting evidence.
- Actual-cluster fault/rotation/restart rollout evidence and the refreshed A/B/C demonstration/screenshots remain. Combined backend/Runner/build checks are recorded in the current validation checkpoint.
- Complete lease and permanent infrastructure fencing integration. Static context validation cannot certify safe reassignment, frozen-node termination or non-overlapping old/new serving authority.
