# Runner lease ledger foundation

Migration `0055` adds durable, per-pool epoch and grant tables; `RunnerLeaseLedger` records grants and stops issuing them when a pool is marked draining. It uses the existing `traffic-router-bindings` PostgreSQL advisory transaction lock so cooperating Controllers can serialize these operations. Grants are recorded separately for each pool, Runner, boot and nonce; disconnects and a newer boot do not remove older grants. Duplicate challenges are rejected, rather than reissued from a later request start. A stored conservative expiration includes a caller-supplied uncertainty interval.

An experimental, **disabled-by-default** grant-response handler is available when `CONTROLLER_EXPERIMENTAL_RUNNER_LEASE_GRANTS=true` and pool tokens are configured. It requires a pool-authenticated stream advertising `tasklattice.snapshot-ack=1` and `tasklattice.lease-probe=1`, an exact current snapshot ACK, the same Runner/boot and generation, and a durable grant written before reply. It suppresses a reply if the local stream or snapshot changes during persistence; the grant remains recorded. Nonce replay and draining are rejected. The Runner can separately opt into cooperative lease consumption as described below; the chart does not enable that option.

Live serving integration is experimental work in progress; the ledger does not advance epochs, finish drains, or provide a scheduler for move recovery. Grant duration and uncertainty are experimental constants, not demonstrated time bounds. Do not present the probe as a fencing guarantee or rely on it to approve a move.

Until lease-aware drain and epoch transitions are implemented, non-noop Tenant or pool group reassignment is refused when experimental grants are enabled. Reassignment is also refused for affected source pools with any persisted grant history after the experiment is disabled, including clock-expired history; switching a flag or marking a Runner offline cannot establish that old work stopped. No-op assignment remains idempotent. Do not delete grant evidence to bypass this guard. This is a conservative availability restriction, not a completed move protocol; deployments that have never issued grants still retain the legacy offline-registration move behavior and its documented partition limitation.

Migration `0057` separates a control stream's identity from its Runner boot. A Controller generates a new internal session ID for each registration; `runner_instance.control_session_id` identifies the current stream across all Controllers, while `runner_control_session` retains earlier sessions. Registering the same boot on another Controller supersedes the previous session under the allocation advisory lock. Heartbeats and disconnects must match that session, so a delayed old disconnect cannot take the replacement offline. Session IDs are not returned by the fleet API and are not credentials supplied by Runners.

The session row records the latest dispatched snapshot nonce, generation, model revision, allocation group and epoch. Dispatch and exact ACK/NACK processing occur under the same allocation lock; a newer snapshot resets acknowledgment, and replay cannot turn a NACK into an ACK. Experimental snapshot-bound grants require that current session and its durable accepted ACK inside the issuance transaction. Missing session evidence, legacy NULL session registrations, stale boots/streams, changed epochs/groups or changed generations fail closed. Older grants remain recorded when a stream is replaced or a response cannot be delivered. `issue()` remains a standalone test/foundation API; only `issueSnapshotBound()` checks these session and ACK requirements.

These checks serialize database state, not a network send or an entire workload. A session replacement can still commit after the last database check and before bytes reach a Runner. The future Runner/epoch/move protocol must enforce the response's binding while preserving outstanding grant history. Some non-lease Controller work paths have their own authorization and lifecycle checks and require further review. Stop old Controller writers during rollout: code predating this migration can update registrations without the session predicates. Existing legacy registrations have NULL session evidence and cannot receive snapshot-bound grants until reconnecting to the upgraded Controller. Grant and session retention/removal require coordinated lifecycle work rather than deleting evidence on disconnect.

Private Artifact admission checks, Rail validation and queued validation dispatch
also check durable current-session ownership before sending work. A stale local
connection retained by another Controller is skipped, and queued validation
rechecks after asynchronous bookkeeping so a missed dispatch remains retryable.
Initial registration send or reconciliation failures clean up the committed
session even before the outer stream handler has received its connection object.
These checks narrow stale-dispatch windows; they do not hold database ownership
atomically across network delivery or execution.

The database deadline is a bound only under explicit assumptions about database time, Runner clocks, clock drift, scheduling, network delay, and the selected uncertainty. In particular, a forward jump in the database clock or clock skew during PostgreSQL failover can make `outstanding()` report zero while a Runner still serves. A verified clock bound and a conservative protocol, or independently attested workload/network fencing, are required. A suspended or uncooperative Runner may need external fencing even when a timer has expired. A returned zero is only a snapshot; it has no safety meaning unless grant issuance has already been disabled and all Controllers and moves cooperate under the same durable state and lock.

Future integration must authenticate the pool and Runner boot, activate and acknowledge the exact Controller-dispatched allocation, coordinate durable epoch transitions with all grant issuance and tenant/pool moves, handle replay and failure recovery, and test the actual cluster under partitions and clock/failover faults. Explicit retention and cleanup must preserve every potentially outstanding grant. The pool foreign key currently prevents deleting a pool while its lease state is present, which is intentionally conservative until lifecycle handling is implemented.

The control protocol now includes an optional snapshot challenge for Runners
advertising `tasklattice.snapshot-ack=1`. For those streams, the Controller
records a verified acknowledgment only for the latest dispatched nonce,
generation and model revision on that connection. The Runner echoes the
challenge after its apply attempt; stale, replayed and mismatched results are
ignored. A reconnect gets a fresh challenge. Legacy Runners retain their
existing serving behavior. The latest acknowledgment is also stored with its
durable control session; it is not a serving grant or an epoch transition.
A Runner inside the pool's trust domain can
lie about applying a snapshot; authenticated transport and workload trust are
still required. Registration and heartbeat generation fields remain status
observations and must never be used as proof for a grant. The optional Runner
consumer requires an actual grant after this acknowledgment; an ACK alone does
not authorize serving or a group move.

## Experimental Runner consumer

`GUARD_RUNNER_EXPERIMENTAL_LEASE_ENFORCEMENT=true` separately enables a cooperative Runner consumer. It requires an explicit pool token and Linux `CLOCK_BOOTTIME`; an unsupported clock platform fails startup. The Controller must be upgraded to supply the epoch durably recorded with the exact challenged snapshot and enable the experimental grant handler. There is no fallback to epoch zero or to legacy serving when the challenge or epoch is absent.

The Runner applies the complete snapshot, queues its exact ACK, then requests a unique grant. Each grant is checked against the current challenge, snapshot nonce, generation and Controller-issued epoch. Its local deadline starts before the request enters the transport queue; queueing and network delays cannot extend it. A missing, denied, malformed or expired grant fences new runtime/internal HTTP and WebSocket work, signals cancellation of active work, withholds queued private-work results, and reconnects for a fresh challenged snapshot. A later grant never clears an earlier serving period's loss event. A task and any queued result retain their original period's fence, even after a new grant resumes service. Stream frames and response bytes are rechecked immediately before the cooperative send path.

A rejected lease-mode snapshot also requests reconnection even if no valid snapshot has ever been ready. Before the first snapshot arrives, or while legitimate bootstrap model preparation is running, the Runner stays fenced without imposing a short grant-response deadline on that preparation. A Controller that stays silent before sending any snapshot can therefore leave the connection waiting and unready; this is fail-closed availability behavior, not proof of Controller health.

Control-channel validation, capability-validation and Artifact-admission work also require a live grant in this mode and are cooperatively canceled when authority is lost. Model/materialization work needed to apply a new snapshot remains bootstrap/control work and may run while serving is fenced. Canceling Python work does not terminate a synchronous worker thread, an external Provider operation already sent, an uncooperative task, or a suspended VM. Response checks do not make the final network send atomic with revocation. External workload/network fencing remains necessary for stronger guarantees, and none of these checks provides per-tenant fault isolation inside a shared pool.

Keep the Controller and Runner options off for ordinary deployments until the documented clock, rollout, lifecycle and move requirements are satisfied. They are not automatically enabled by Helm pool authentication. Group reassignment remains restricted as described above; the experiment has no drain/epoch transition or automatic recovery scheduler.
