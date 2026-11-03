# Durable tenant-group move protocol

Status: disabled service implementation plus production rollout design. `0058`
implements preparation and fresh waits; `0060` adds an atomic finalizer requiring
a live completed wait handle and an injected authoritative permanent external
fencer. No production fencer, Controller startup wiring, admin API or UI enables
these operations. The current direct reassignment guards remain. A stored grant
deadline or an offline registration is insufficient evidence that an old Runner
has stopped.

## Guarantee and trust boundary

A completed Tenant move must not allow its old source pools to serve it while
the destination begins serving it. A pool move must not allow that pool to serve
its previous group while serving its new group. Keep tenant groups as the shared
Runner trust domain: a Tenant move drains every pool in its old group because
the current serving lease covers a complete pool snapshot, not an individual
tenant. Other tenants sharing that source group temporarily lose service during
the drain. A separate destination group can continue serving its existing
tenants during the source wait, with a new snapshot applied after commit.

The cooperative guarantee assumes trusted Controller/Runner code, authenticated
pool identities, lease enforcement on every serving path, and bounded clock
rates. It does not make a previously shared process forget source content or
credentials. A malicious, frozen, or uncooperative workload, a provider operation
that cannot be cancelled, or a requirement for process-memory confidentiality
requires verified workload/network fencing and potentially secret rotation.
Readiness, stream disappearance and capability labels do not prove that fence.

## Additive durable state

Keep the existing grant and control-session history. Add these concepts in
successive migrations; no new table should replace or delete that evidence:

| Record | Required fields and constraints |
| --- | --- |
| `tenant_group_move` | Random ID, idempotency key, kind (`tenant`/`pool`), subject ID, expected source group, destination group, actor, state, revision, barrier ID, committed generation, audit timestamps. One active transition per subject; conflicting requests return 409. |
| `tenant_group_move_pool` | Move ID, source pool ID, captured group, old epoch, next epoch, frozen lease policy version and maximum duration, wait budget, fence mode/evidence reference. Unique move/pool; a source pool cannot belong to two active transitions. |
| Group/pool transition claim | A durable reference to the active move on both affected groups and every source pool. All allocation/create/connectivity operations must respect it under the existing allocation advisory lock. This freezes the captured source set while the wait occurs outside a transaction. |
| Lease enforcement policy | Per-pool durable mode (`legacy`, `lease_required`, `externally_fenced`), maximum authorized duration, timing policy/version and legacy-fence requirement. Existing pools start legacy/unknown. Increasing a duration cannot change an already prepared barrier's assumptions. |
| `allocation_fence_evidence` | Trusted provisioner evidence, affected workload identities/UIDs and old credentials/network authority, verifier identity, verification result and barrier binding. A caller-supplied boolean or arbitrary text is not evidence. |
| Wait proof | Barrier ID, timing policy/version, Controller process/attempt identity, monotonic elapsed duration and successful completion. Wall-clock timestamps are audit data only. A proof belongs to one immutable barrier and cannot be reused after drain reset or pool changes. |

Add database constraints for the maximum permitted grant duration and uncertainty
as well as application validation. Unknown historical grant bounds block timed
completion and require verified external fencing. Keep a durable dirty/legacy
marker until rollout fencing establishes a trustworthy baseline; the absence of
new session rows cannot account for pre-migration Runners.

## State machine

Use an additive admin API, for example `POST /api/v1/tenant-group-moves`, returning
202 plus a status URL. Keep current direct `PUT` assignment guards. The request
contains kind, subject, destination, expected source group and an idempotency
key; it cannot supply authoritative timing or fence evidence. Status and retry
operations require explicit platform authorization and the relevant token scope.

1. **Requested to prepared/draining.** Under `traffic-router-bindings`, lock
   affected group rows in sorted ID order, then source pool epoch rows in sorted
   order, then the subject/transition. Validate expected membership, destination
   existence, default-pool rules and no conflicting transition. A Tenant move
   captures all pools currently in its source group, including offline/zero-
   replica pools. A pool move captures that pool alone. Claim the groups/pools,
   create one unpredictable immutable barrier, set every source pool draining,
   freeze bounds/evidence requirements, and commit. Do not change membership or
   advance epochs yet. Grant issuance already takes this advisory lock and must
   reject draining pools. Private validation/admission dispatch must also honor
   draining state. New registration may obtain control information but cannot
   gain serving rights during drain.
2. **Draining to quiescent.** Outside all DB locks, obtain either the cooperative
   fresh monotonic wait described below or verified external fence evidence for
   every source pool/old workload. Controller disconnects and ACKs can improve
   responsiveness/observability but cannot shorten the bound. Preserve every old
   boot/session grant, even if a reply was suppressed. Unknown legacy authority
   prevents the cooperative path. Recheck the immutable barrier and claims
   before storing a completed proof. Any uncertainty leaves the move draining.
3. **Quiescent to committed.** Reacquire the same locks in the same order. Verify
   subject/group expectations, exact source pool set and epochs, unchanged
   claims/barrier/timing policy, draining state, no legacy authority and one valid
   proof per source pool. Update the Tenant or pool group, advance all source
   pool epochs, invalidate their snapshot ACK authority, increment desired
   generation and write outbox/audit records atomically. Clear source draining
   only for the new epoch and remaining membership. Destination pools receive
   the new generation after commit; their old snapshots lack the moved Tenant.
   An additive destination membership change need not drain that entire group:
   applying any changed snapshot must revoke the Runner's previous serving
   period and require a fresh exact ACK and grant. Source epoch changes protect
   removal/reallocation; the destination generation binds the added resources.
4. **Committed to converged.** Track exact new-epoch/new-generation ACKs and
   grants for source and destination pools. A committed move cannot be rolled
   back by restoring a DB group field; reversal is another complete move.
   Failure to converge is visible and retryable without widening authorization.

For a source group with no current pool, only a verified enforced baseline and
the invariant that every prior pool removal was fenced make an empty source set
safe. A historical/legacy installation cannot infer that from today's tables.

## Fresh monotonic wait instead of database-clock expiry

Do not authorize a move using `conservative_expires_at <= now()` or
`outstanding() == 0`. A forward database clock jump or failover skew can make
that true before a Runner's local lease expires.

After observing a committed drain barrier, a trusted coordinator starts a fresh
monotonic timer. No grant can be recorded after that barrier because all issuers
share the same persistent drain state and allocation lock. Every grant that
could still be delivered was recorded before the barrier; its Runner deadline
is measured from the request's start, which was before issuance. Delayed replies
therefore cannot extend the horizon. Wait a full worst-case lease duration from
this new observation, using the frozen timing policy. Do not subtract elapsed
wall time or trust a stored start timestamp.

Let `L` be the maximum grant duration in Runner-clock units, `r_min` the verified
minimum Runner-clock rate relative to real time, and `c_max` the verified maximum
coordinator-clock rate. A conservative coordinator-clock wait is at least
`c_max * (L / r_min + F)`, with an explicit margin for the bounded cooperative
fence `F` and measurement granularity. If these bounds cannot be justified, use
external fencing. A Runner clock must count ordinary host suspend (the current
Linux implementation uses `CLOCK_BOOTTIME`); a frozen VM clock or unbounded
event-loop/synchronous-worker stall violates the cooperative assumptions.
Per-send checks prevent delayed responses after resumption but do not retract
external side effects already running.

The prepared barrier freezes `L` at least as large as every historical grant
that might still authorize work, including response-suppressed grants. Reject
new grant-duration policy changes for a claimed source pool, or require a new
barrier and full restarted wait. A larger unknown prior duration or prior
non-lease Runner cannot be covered by choosing today's smaller setting.

On process restart, takeover or a lost/uncertain monotonic timer, restart the
full wait after rereading the same durable barrier. This increases downtime and
is safe. Multiple coordinators can independently wait the full horizon and
race the final transaction; revision/claim checks make the finalizer idempotent.
A completed wait proof can be durable only because draining remains unchanged
and no new grants are possible. Resetting or cancelling drain invalidates that
proof permanently.

## Legacy rollout and recovery

Before allowing timed moves, upgrade every Controller writer, provision scoped
pool credentials, and establish a durable `lease_required` policy. The Controller
must refuse private snapshots/work/grants to incompatible Runners; cooperating
Runners must fail startup or stay fenced if required lease fields are missing.
Self-reported capability labels are negotiation, not proof of enforcement.

Stop/fence every old workload and remove its route/network/credential authority,
using provisioner evidence tied to actual workload identities. Do not clear the
legacy marker from offline status, a missing registration, a restarted pod name,
or a successful new Runner. Old Controllers must not return and write legacy
registrations or issue authority outside the new policy. External bootstrap
fencing may be needed to establish the initial invariant because historical
authority was never durably captured.

Crash before prepare commit leaves no drain; crash after commit leaves a durable
drain. Recovery starts another full wait. Crash after membership/epoch commit
replays the outbox and convergence checks. Never reopen old grants just to make
a failed transition look healthy. Initially support cancellation only before
prepare; a later cancel/reactivation operation needs a fresh epoch/snapshot and
its own reviewed state machine. A stuck drain remains unavailable with an
actionable status, rather than silently reverting membership.

Lock order is allocation advisory lock, sorted group rows, sorted pool/epoch
rows, transition/subject rows, then Controller generation row. Existing writers
that acquire these resources must follow this order. Row-only generation writers
may block issuance, but must not subsequently request the allocation lock in the
same transaction. Network calls, timers and external verification never run
while holding those locks.

## Acceptance tests

- PostgreSQL: concurrent requests/idempotency, source pool capture and claim
  conflicts, all source pools draining before any membership update, no grant
  after barrier, old boot/session and response-suppressed grants retained,
  expected-group conflicts, default-pool protection and no-op behavior.
- Injected clocks: DB forward/backward jumps and failover skew do not shorten
  the fresh wait; coordinator restart restarts it; slow Runner/fast coordinator
  bounds, delayed/reordered grants, changed duration policy, invalid/missing
  proofs, drain reset and unknown legacy authority all fail closed.
- Transaction races: issuance versus prepare, membership mutation versus
  captured-pool validation, concurrent finalizers and generation updates;
  crashes before/after every commit and outbox replay preserve one transition.
- Real Runners: a one-way control partition during A's move cannot overlap old
  source service with destination service; A/B's shared source pools both drain,
  while unrelated group C continues serving during the wait. Cover HTTP,
  streaming/WebSocket output, private compile/admission jobs, queued result
  revoke/regain races, provider timeouts and process restart.
- Rollout: legacy/non-lease Runners, old Controller writers, incomplete pool
  credentials and unverifiable workload termination prevent the timed path.
  External-fence tests use the real provisioner/CNI rather than mock evidence.
- Infrastructure: host suspend, VM freeze, CPU/event-loop stall, DB outage and
  failover, node loss, uncooperative worker and external provider side effects
  are tested against the stated tier. Local one-node tests cannot certify HA or
  physical isolation.

## Safe implementation slices

Migration `0058` and `TenantGroupMovePreparationService` implement a standalone,
disabled-by-default preparation slice. It captures and claims the affected
groups/source pools and stops grants under the existing allocation lock. It is
not wired to an HTTP API, Controller startup or UI. The current direct-move
guards remain authoritative; claimed groups/pools additionally reject
allocation and connectivity changes, while idempotent assignment no-ops remain
available. `TenantGroupMovePreparationService` remains an import alias for
`TenantGroupMoveService`. There is no public move or cancellation API.

The service also records an elapsed observation using a process-local opaque
wait handle, a fresh full monotonic horizon and a durable attempt/barrier ID.
Process restart/takeover, serialized handles, timing-policy changes, broken
drain/topology or changed grant history cannot reuse the old observation. A
successful observation deliberately leaves the transition `prepared` and
`requires_external_fence=true`; existing installations do not yet have verified
lease-only rollout evidence or verified timing bounds. Database constraints
prevent these records from claiming that external fencing is no longer needed.
Wall-clock timestamps and expired historical grants never shorten the wait.

The implemented pool capture includes the database-maintained barrier revision
and a SHA256 digest of every captured grant's full identity, authority and exact
timestamps. The revision increases on every epoch or drain-state change, even
when a drain is reset and restored between observations. Its trigger rejects
direct revision resets and deletion of a claimed epoch row. Redundant requests
to keep an already draining pool drained do not change the revision. The grant
digest detects replacement or modification even if grant count and maximum
duration remain unchanged. History serialization uses PostgreSQL numeric values
and epoch timestamps, preserving microseconds and avoiding session time zones.
This manual preparation path reads the full retained per-pool grant history;
large ledgers will need an immutable incremental history accumulator before
high-volume production moves.

The database owner can disable triggers or rewrite both captures and source
records. That is outside this service's trust boundary. Supported allocation
writers hold the common allocation lock and honor the durable claims; an old
writer that ignores this protocol remains an unverified rollout prerequisite.
The revision and digest add detection and do not certify external fencing.

### Permanent external-fence completion implemented in 0060

`finalize(moveId, handle, actorId)` requires the same live opaque handle that
completed the full monotonic observation in the current service instance. Bare
persisted elapsed metadata or a serialized handle cannot complete a move. After
restart or wait takeover, a fresh `beginWait` and complete horizon are required.
The attempt/process/elapsed data are checked before verification and again in
the commit transaction. Clock regression or verification/transaction uncertainty
invalidates the local capability and requires another complete wait.

The caller must inject an `AuthoritativeExternalFenceVerifier`; there is no
default verifier or caller-supplied HTTP attestation. Its
`verifyPermanentFence` result must certify a permanent external fence capability
covering all old source workloads and their retained route, network and
credential authority, including throughout the allocation commit. A momentary
offline observation, an expiring permit, a Runner self-report or a boolean from
an untrusted caller is insufficient. The authoritative implementation must also
account for historical/removed workloads and an initially empty source pool set;
the current table contents alone cannot establish that baseline. Evidence and
verifier identifiers must be non-secret infrastructure references.

The fence must also prevent old-allocation authority for workloads launched or
registered after the verifier's initial inventory and before commit. Certifying
only a finite snapshot of stopped workload IDs is insufficient: new legacy
registrations can otherwise receive an old-allocation snapshot during that gap.

The immutable verifier request binds the move and barrier IDs, source and
destination groups, subject, exact source pool epochs/revisions/grant digests,
timing policy and live observation attempt in one SHA256 digest. The result must
echo that digest, move/barrier IDs and exact source pool set, with an explicit
`permanent_external_fence` capability. Verification runs outside DB locks. The
commit transaction reacquires the allocation lock and rechecks the complete
barrier, grant history, live observation and request digest; a topology, drain,
history or attempt change during verification is rejected.

Only then does one transaction change the Tenant or pool membership, increment
each captured source epoch, reopen that new epoch, revoke source snapshot ACKs,
retire source Endpoint telemetry contexts, advance the Controller generation,
write the desired-state outbox event and audit record, and store completion
metadata. Old grants and immutable pool captures remain. Group claims are
released and pool captures receive `released_at`, allowing later independent
moves while retaining history. `requires_external_fence` stays true: the stored
evidence records how that requirement was fulfilled, rather than clearing it.

A completed retry returns the stored result without invoking the verifier or
changing membership, generation, epochs or outbox. This covers a crash or lost
response after commit. An outbox failure rolls back membership, epochs, ACK
revocation, context retirement, completion and claim release together. There is
no cancel/reactivation bypass. Database state `completed` means the allocation
transaction committed; it does not claim that new Runners have converged.

Preparation reserves two safe barrier-revision increments: one for entering the
drain and one for completion's epoch/drain update. A revision with fewer than two
increments remaining is rejected before creating claims, rather than leaving an
uncancelable transition that cannot commit.

Completed move/capture history retains its source and destination group IDs.
Even after all Tenants and pools move away, deleting one of those groups returns
an explicit `409 tenant_group_history_retained`. Unused groups without retained
history remain deletable. There is no history-retention/archival cleanup workflow
yet; preserve group identities and pool/grant/capture history rather than
deleting evidence to bypass foreign keys or safety checks.

PostgreSQL tests use an explicitly named test-only verifier. They prove the
application's gating and atomicity, including false/stale/mismatched evidence,
missing or restarted local waits, takeover during verification, post-verification
topology/history/drain changes, context retirement, rollback, completion retries
and repeated moves. They do not prove real workload or network fencing.

Remaining production work supplies the authoritative provisioner/CNI/credential
fencer and verifies its permanent-fence contract, then tests real partitions,
mixed versions and exact new-snapshot convergence. A cooperative lease-only
completion path also needs verified rollout and clock-rate policy. Expose the
admin move API/UI only after those prerequisites and recovery tests are in place,
with shared-source-group downtime clearly shown.
