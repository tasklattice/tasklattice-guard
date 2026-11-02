# Tenant-group runtime Model grants

Every Runner pool belongs to a tenant group. An optional, administrator-managed
Model policy now determines the runtime configuration and Provider credentials
available to **all pools in that group**. A/B can therefore share one Model grant
while C uses another. Membership does not give A access to B's private Policies,
Guardrails or application records. Members still share their group's Runner
processes and any Provider account intentionally granted to them.

This feature is implemented in the working tree and has regression coverage. It
has not been migrated into or deployed to the existing A/B/C demonstration.

## Modes and compatibility

| Mode | Configuration sent to the group's pools | Active credential retrieval |
| --- | --- | --- |
| `legacy` | Current platform data-plane bindings | References used by those platform bindings only |
| `scoped` | Frozen group grant | Provider references contained in that grant only |
| `blocked` | Explicit empty runtime configuration | Denied; never falls back to platform bindings |

Migration `0018_group_model_configurations.sql` does not grant or revoke any
existing group. An absent policy initially means legacy mode. Once saved, a
policy cannot be deleted to regain implicit legacy access: an administrator must
explicitly replace it with `legacy`. Every replacement receives a new grant
identity, exactly the next policy version and a newer desired-state generation.
There is one current policy row per group; secret snapshots do not accumulate in
an unbounded application history table.

Scoped and blocked modes require pool control authentication. Removing it from
Controller configuration while either kind of policy exists prevents startup.
Legacy shared authentication is not a tenant-group credential boundary. A group
configuration also requires a Runner capable of challenged snapshot ACKs; an old
Runner cannot receive that scoped configuration through a compatibility fallback.

## Administrator workflow

1. Configure platform Models and Providers and validate the runtime bindings in
   **Settings → Guardrail Catalog**. Validation must have passed the actual Rail
   checks for each selected binding. A chat-only probe is insufficient.
2. Open **Settings → Tenant groups → Runtime Models** on the intended group.
   Review its current mode, policy version and granted Model IDs.
3. Select **Group grant**, choose a validated current draft or active revision,
   and review the listed runtime bindings and Provider names. Saving a validated
   draft as a group grant does not activate it globally.
4. Apply the policy. The browser sends the reviewed policy version and exact
   validation fingerprint. Stale policy or source changes cause a conflict; the
   editor requires an explicit refresh and review before retrying.
5. Let the group's Runners synchronize. Saving is a desired-policy update, not
   proof that every old workload stopped or every replica acknowledged it.

The editor does not offer old reports without a runtime fingerprint. Backend
validation remains authoritative if the source or Provider changes after the
browser reads it. A catalog-read failure still permits explicitly blocking a
group using its current readable policy. A failed policy refresh disables edits;
cached policy data is insufficient to authorize a new change.

The backend additionally accepts an eligible superseded platform revision when
called directly. The current UI offers current draft/active revisions, rather
than presenting a separate revision-history browser.

## API and persisted authority

Both routes require a platform administrator; access tokens also require the
matching settings permission:

```http
GET /api/v1/tenant-groups/{groupId}/model-configuration
PUT /api/v1/tenant-groups/{groupId}/model-configuration
```

The scoped request contains these fields; the fingerprint must come from the
reviewed revision's validation report, not be invented by the caller:

```ts
{
  mode: "scoped",
  expectedVersion: currentPolicy.version,
  sourceRevisionId: reviewedRevision.id,
  expectedSourceFingerprint: reviewedRevision.validationReport.runtimeFingerprint,
}
```

Revocation and explicit compatibility restoration respectively use:

```ts
{ mode: "blocked", expectedVersion: currentPolicy.version }
{ mode: "legacy", expectedVersion: currentPolicy.version }
```

Under the allocation lock and desired-generation transaction, the service checks
the policy version, locks the source/Model/Provider rows, and verifies that the
source is a validated, active or superseded platform revision with matching
passed Rail evidence. Tenant-owned private Model definitions are excluded. A
fingerprint covers runtime bindings, Model/protocol limits, Provider transport
and encrypted credentials; display labels and Controller chat selection are not
runtime authority.

The new grant captures data-plane assignments, runtime settings and encrypted
Provider credentials together. Its revision ID is `tenant-group-model:` followed
by a fresh grant UUID. Controller chat/control-plane assignment is omitted. A
snapshot digest is checked again on retrieval. The SQL payload bound is 256 KiB
of logical JSONB text per policy, with at most 64 Models; this is not a database
disk quota. Public responses expose IDs, mode, version and source fingerprint,
never ciphertexts or plaintext credentials. Audit records contain nonsecret
policy-change metadata.

## Distribution, retrieval and races

Desired Endpoint/artifact allocation and the group's runtime Model selection
are projected in the same allocation/generation transaction. Credential
resolution uses the persisted current group policy under that lock. A missing
pool or group, blocked policy, invalid snapshot, draining allocation or
unauthorized Provider reference cannot fall back to global credentials.

Group ACKs and NACKs cannot finalize or fail a global Model activation. Global
activation selects an actual legacy pool, pins the exact revision being
distributed, then checks the pool's current mode and revision again inside the
finalization transaction. Switching that pool to scoped/blocked while an apply
is pending cannot turn its acknowledgement into approval of a different global
configuration. Durable current control sessions exclude replaced streams from
distribution readiness. No eligible legacy pool produces a conflict before
starting a global activation.

Deleting or reconfiguring a grant-backed Model, or deleting a grant-backed
Provider, is refused until the group grant is replaced/revoked. Removing or
editing the original source revision does not change the frozen grant.

## Credential and resource limits

- Provider rotation does **not** silently replace a granted encrypted snapshot.
  Revalidate and regrant the affected groups, then coordinate old-key revocation
  with the Provider. Several groups can intentionally share one Provider account;
  grants alone do not allocate separate Provider concurrency, token or spend
  budgets.
- Already delivered credentials cannot be recalled by hiding a reference or
  saving `blocked`. In-flight work, long-lived keys, historical workload storage
  and uncooperative/frozen processes require coordinated rotation and fencing.
- Platform administrator Rail-validation jobs remain an explicit exception:
  their separate short-lived durable candidate leases can authorize the chosen
  compiler pool to test a candidate. Those are not normal active group grants.
- Authorization occurs at a database check. A later allocation change cannot
  retract bytes already authorized for a response. Shared pool tokens identify
  a pool, not an individual workload inside it.
- This implements group runtime grants for platform inventory. Tenant-owned
  Provider connections, private per-tenant runtime grants, Provider request/token/
  spend budgets and full dedicated infrastructure tiers remain separate work.

## Code and verification

- `controller/server/model-config/group-runtime.ts`: policy update, immutable
  snapshot, fingerprint verification, selection and resource-use guards.
- `controller/server/model-config/runtime-fingerprint.ts`: validation identity.
- `controller/server/model-config/service.ts`: pool configuration/credential
  selection and activation guards.
- `controller/server/services/control-plane.ts` and
  `controller/server/control-channel/control-server.ts`: coherent projection,
  challenged distribution and current-session acknowledgements.
- `controller/src/components/group-model-configuration.tsx`: admin review editor;
  entry point in `controller/src/routes/tenant-groups.tsx`.
- `group-runtime.postgres.test.ts`: group separation, frozen credentials,
  revocation, version races, validation staleness, resource-use protection,
  activation/policy locking and admin response redaction.
- `group-model-configuration.test.tsx`: reviewed source/version pinning,
  conflict recovery, explicit legacy restoration and unavailable-data handling.

See the [verified checkpoint](multi-tenancy-validation-2026-11-02.md) for test
counts and the distinction between source tests and actual deployment evidence.
