# Persistent Runner telemetry progress rollout

Status: optional and disabled by default. This chart wiring supplies durable
storage for the authenticated telemetry-progress protocol. It does not enable
freshness-based deletion, certify physical fencing, or prove that a 2Gi Docker
cluster has enough memory for all Runner workloads.

The exact session-capability, contiguous cursor, digest-bound replay, ingress
budgets and diagnostic-only semantics are documented in
[authenticated telemetry progress](authenticated-telemetry-progress.md).

## Configuration and storage

After configuring complete per-pool authentication Secret references, enable
the following settings together:

```yaml
security:
  poolAuthentication:
    enabled: true
    scopedTelemetry: true
    telemetryProgress: true
    # Keep the complete controllerSecret/controllerKey/runnerSecrets mapping.
runner:
  telemetryProgress:
    persistence:
      enabled: true
      size: 64Mi
      storageClass: "" # Cluster default, or an existing persistent StorageClass.
```

The chart rejects progress without pool authentication, scoped telemetry and
explicitly enabled persistence. It also rejects enabling this PVC while the
progress feature is off. Default values leave both off and create no progress
claim. Supported size values are positive integral Mi/Gi quantities.

Every Runner StatefulSet receives a `telemetry-progress` volume claim template
using `ReadWriteOnce`. Each replica therefore gets its own claim, associated
with its stable StatefulSet name and ordinal. It mounts at
`/var/lib/tasklattice/telemetry-progress`; the existing artifact cache remains
at `/var/lib/tasklattice/guard-runner` on its existing `emptyDir`.

The chart sets `CONTROLLER_RUNNER_TELEMETRY_PROGRESS=true`,
`GUARD_RUNNER_TELEMETRY_PROGRESS_ENABLED=true` and
`GUARD_RUNNER_TELEMETRY_PROGRESS_PATH=/var/lib/tasklattice/telemetry-progress`.
The Controller keeps acknowledged WAL identity/cursor state in PostgreSQL; the
Runner keeps its WAL identity and unacknowledged records on this claim. A
replacement Pod with the same name and retained claim can recover the same WAL.

The default claim request is 64Mi per replica. The current progress WAL has an
8MiB serialized-state bound and 10,000-record bound; atomic persistence also
needs space for its replacement file and filesystem overhead. A full or
unwritable volume fails closed. The StorageClass must supply durable fsync,
atomic replacement and file-lock behavior. These are deployment requirements,
not properties demonstrated by rendering Helm templates.

Kubernetes normally retains StatefulSet claims when Pods are replaced, scaled
down or the StatefulSet is deleted; this chart does not opt into automatic claim
deletion. Preserve these claims and PostgreSQL state together. See the official
[StatefulSet storage and retention documentation](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/#persistentvolumeclaim-retention).

## Controlled first rollout and recovery

1. Inventory the existing release/namespace, StatefulSet names, pool names and
   Runner ordinals. Preserve these identities and the Controller database.
   Changing a release/fullname/pool name changes the Runner/PVC identity and
   requires an explicit migration.
2. Stop new traffic and drain the existing Runner work and legacy telemetry WAL
   before replacing Pods. Verify that `runtime-events.wal` in the old artifact
   state directory has no outstanding records. Retain recoverable copies of any
   unresolved evidence. The Runner rejects a nonempty legacy WAL when entering
   progress mode; deleting an old ephemeral Pod before draining it can destroy
   that evidence before the check runs.
3. Review the rendered claims, StorageClass, replica count and storage requests.
   Adding `volumeClaimTemplates` changes an immutable StatefulSet field. An
   existing StatefulSet requires a controlled drain and recreation preserving
   its name, Services and retained claims; a normal in-place Helm update cannot
   add this field. Removing the claim template when disabling this mode also
   requires a controlled transition. The chart does not automate deletion,
   force replacement or credential/identity reset.
4. Start each stable ordinal with its own mounted claim and enable both protocol
   flags together. Check authenticated control registration, WAL authorization,
   acknowledged batches and recovery after a Pod restart before restoring
   traffic. Claim existence or a healthy Pod alone does not prove durable storage.
5. For later restarts or rescheduling, keep the same claim and WAL identity. An
   irretrievably lost/replaced claim can produce a different WAL identity for an
   already known Runner; the Controller intentionally refuses that replacement.
   Restore the original claim or use an explicitly reviewed reconciliation
   procedure. Do not clear Controller rows, fabricate ACKs or delete retained
   files merely to make registration succeed. An automated identity-reset
   recovery workflow is not supplied here.

Changing PVC size or StorageClass also needs a StorageClass-specific expansion
or migration plan; changing chart values does not mutate the existing claim
template in place. Retained PVCs can continue consuming disk after scale-down
or uninstall. Their disposal requires a deliberate evidence-retention decision.

## Rendered verification artifact

`tests/contract/fixtures/telemetry-progress-values.yaml` is a render-only fixture
with two default-pool replicas and one isolated-pool replica. It requests three
64Mi progress claims, totaling 192Mi of storage. It uses synthetic Secret
references and an external Redis URL; it is not a ready deployment values file.
The accompanying Helm tests render the real chart and verify opt-in flags,
per-replica claim templates, mount separation, default-off behavior and invalid
configuration rejection. They perform no install, PVC allocation or live traffic
test, and do not certify memory or disk use of a running cluster.
