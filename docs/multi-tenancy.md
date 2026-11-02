# Multi-tenancy design and progress

This page preserves the October implementation history. For current behavior and remaining work, use the [current status](multi-tenancy-status.md), [implementation progress](multi-tenancy-implementation-progress.md), and [2 November validation checkpoint](multi-tenancy-validation-2026-11-02.md). Later tenant-group controls supersede the early deployment-wide Runner permissions and single runtime Model configuration described below.

Updated: 2026-10-22. This is the implementation record for `feat/multi-tenant-v2`, rebased onto upstream main at `9e16c86`. The tenant work follows the current upstream resource and authorization models. The stakeholder proposal is [multi-tenancy-github-proposal.md](multi-tenancy-github-proposal.md).

See the [storage and isolation diagram](multi-tenancy-storage-isolation.md) for the shared PostgreSQL row model, tenant read and write boundaries, resource grants, and platform-managed Provider data.

## Identity and authority

The upstream roles remain `admin` and `user`. An `admin` manages platform configuration, Model Providers, global model bindings, and account administration. Platform administrators can inspect business metadata where their role permits it; this does not grant the tenant authoring role. A `user` authors resources within one persisted tenant and can read resources explicitly shared with that tenant. Upstream also grants both roles Runner management access; that operational surface is deployment-wide. There is no special authority attached to the name `tenantA`.

The Controller derives authority from the authenticated account. Sessions and personal access tokens require a current, valid role; tenant users also require a persisted, nonblank tenant ID. Token module permissions constrain access further, and token authority follows the current account role and tenant. Request headers and resource bodies cannot select another tenant. Missing or malformed tenant identity fails closed. Trusted startup, migration, and Runner work uses a separate internal execution context.

Public email signup is disabled. Better Auth account administration routes require a browser session whose account currently has the platform administrator role. They are not tenant invitation routes. Tenant user onboarding and a production identity provider remain follow-up work.

### Local mock SSO

`CONTROLLER_MOCK_SSO_ENABLED=true` enables a fixed local identity chooser only on a loopback, non-production Controller. All three identities have role `user`:

| Tenant | Display name | Demo group |
| --- | --- | --- |
| `tenantA` | Tenant A Operator | `group_a` |
| `tenantB` | Tenant B Operator | `group_b` |
| `tenantC` | Tenant C Operator | `group_c` |

Groups are display labels, not platform roles. Startup provisions the accounts and one disabled Endpoint per tenant, with IDs `mock-sso-endpoint-tenantA`, `mock-sso-endpoint-tenantB`, and `mock-sso-endpoint-tenantC`. Provisioning is idempotent and rejects conflicting existing identities or Endpoint ownership. The selector signs in through Better Auth rather than accepting an arbitrary tenant claim.

Demo passwords are derived on the server from `BETTER_AUTH_SECRET`. Rotating that secret after provisioning requires resetting the disposable demo accounts or database before using the chooser again. Use a separate platform administrator account to demonstrate platform settings.

## Resource boundaries

The root record's `tenantId` controls authorization. Child versions, drafts, artifacts, tests, and validation results inherit authority through that root. Attribution fields such as `createdBy` and Policy `owner` are not authorization keys.

| Resource | Boundary |
| --- | --- |
| Policy | Tenant-owned declarative, legacy, and imported definitions; versions and validation inherit the Policy boundary |
| Guardrail | Tenant-owned root, versions, packages, artifacts, tests, and validation results |
| Traffic Router | Tenant-owned root, draft routes and targets, published snapshots, and history |
| Endpoint | Tenant-owned configuration and credential operations; binding requires an owned Router in the same tenant |
| Model definition | Concrete `tenantId` means tenant-owned; `tenantId = NULL` means platform-managed |
| Model Provider | Globally platform-managed; tenant users can select metadata but cannot manage providers, perform credential-backed discovery, or view credentials |
| Model configuration and pricing | Platform administrator authority; global bindings use only platform Models |
| Runtime events, security findings, activity, metrics, and cost | Stored and queried for the invoking Endpoint's tenant, then Router's tenant, with Guardrail ownership as a fallback |
| Audit evidence | Tenant attribution is stored at write time; tenant filtering precedes pagination and aggregation where exposed |
| Runner pools and instances | Deployment-wide infrastructure; both `admin` and `user` can read and manage it under upstream RBAC, without tenant isolation |
| Built-in catalogs and system status | Shared catalogs and deployment-wide health/version views retain their upstream scope |

Tenant Models can independently describe the same provider/model/profile without taking over a platform Model or another tenant's definition. They appear in `/models` and can be shared for inspection. They do not activate a tenant-specific Runner configuration: the current Runner protocol receives one global platform configuration. Readiness can report available detector capabilities without exposing private Model IDs or names. Provider credentials remain platform-only even when a Model is shared.

The console shows the active tenant, scopes resource queries and side-panel counts to the current identity, and clears cached resource data when identity changes. Shared resources show their source tenant and read-only state. Owner-only controls are hidden, while the server enforces the boundary independently.

Deleting or restoring a shared Guardrail clears only the owner's invocation evidence. The recipient's runtime events, route assignments, and model costs remain its own history.

## Sharing and composition

The five share kinds are `policy`, `guardrail`, `router`, `endpoint`, and `model`. There is no Provider share. A grant names one current owner, one root resource, and one recipient tenant. Owners manage grants through `/sharing`; the account sharing API requires a tenant user's browser session. Personal access tokens use the same resource authorization rules for supported resource commands, but cannot administer these browser-session-only sharing routes.

Sharing grants read access and supported composition, not edit, publish, delete, credential access, ownership transfer, or onward sharing. A recipient can bind a shared Policy into its Guardrail or target a shared Guardrail from its Router. Endpoint binding remains same-tenant. A Router share does not transitively expose its target Guardrails, and a Guardrail share does not expose the owner's runtime logs or unrelated Policies.

Tenant-facing Router views omit Endpoint and Guardrail references that the viewer cannot independently read, including target entries and publication-context names. Known private Endpoint IDs in `endpoint.id` and `auth.principal` selectors are replaced with `[restricted]`, and Runner rollout error details are generalized. These views can therefore be incomplete; platform administrators retain the full view. A Router share still exposes text deliberately authored into the Router itself, such as route names, arbitrary selector values, tickets, and reasons. The system cannot reliably identify private information embedded in that free text, so owners should review shared Router content before granting access.

The server checks references during save, preview, validation, publication, rollback, and binding as applicable, including references in snapshots. Publication rechecks live grants even if a draft previously passed validation. Imported package reads, exports, explicit environment checks, and automatic routing checks also enforce their respective owner or read boundaries.

Revocation and publication coordinate through the same binding lock. Revocation returns `share_in_use` while a recipient's active Router uses a shared Guardrail, a pending or ready Guardrail version uses a shared Policy, or a validated, activating, or active model configuration uses a shared Model. Once those dependencies are removed, revocation prevents subsequent reads and references. Grant and revoke actions are audited.

Hidden direct-ID resources and writes to a shared resource return not-found responses. Dependency checks retain global safety blockers while hiding private foreign Router names, IDs, revision details, tickets, and history. A dependency can therefore block deletion without disclosing the recipient's private configuration.

## Migration

The new branch preserves upstream migration history through `0048_remove_runtime_baseline` and appends [0002_multi_tenant_resources.sql](../controller/server/db/migrations/0002_multi_tenant_resources.sql). Upstream `0014_current_model_configuration.sql` and existing journal timestamps remain unchanged.

`0049` creates fixed tenant rows and indexed grants, adds ownership to resource roots and package/import records, and adds tenant attribution to runtime events, model costs, and audit evidence. Existing upstream tenant-owned resources and users are backfilled to `tenantA`. Existing Model definitions receive a nullable tenant column and remain platform Models with `NULL` ownership; Providers receive no tenant column. Platform Model uniqueness and per-tenant Model uniqueness are enforced separately.

Automated PostgreSQL tests cover a fresh migration sequence and `0049` applied to populated upstream tables, including replay without changing existing ownership. This is the validated upgrade path for this branch. A database already modified by the earlier fork's tenant-owned Provider design needs a separate migration assessment; this document does not claim that historical fork schema has been upgraded in place. Apply migrations through normal Controller startup or `npm run db:migrate --prefix controller` after the usual database backup.

## Local walkthrough

This is the manual demonstration procedure; browser completion has not yet been recorded.

1. Use a disposable migrated Controller database. Set `CONTROLLER_HTTP_HOST=127.0.0.1` and `CONTROLLER_MOCK_SSO_ENABLED=true`, then start the Controller and console with the normal local configuration.
2. Open **Mock SSO** on the login page, or `/mock-sso`, and select **Tenant A Operator**. Confirm the active tenant and its disabled demo Endpoint. Create a Guardrail and Router so their names and counts appear in tenantA's pages and side panel.
3. Switch to **Tenant B Operator**. Confirm tenantA's private resources disappear, tenantB's demo Endpoint appears, and the side panel refreshes. Create a tenantB Router.
4. Return to tenantA and use **Sharing** to share a published Guardrail with tenantB. In tenantB, confirm it is read-only and selectable as a Router target. Publish through the normal validation and approval workflow.
5. Select **Tenant C Operator** and confirm it sees neither tenantA's private resources nor the A-to-B share. Try a hidden direct-ID URL and a foreign write as well as the list view.
6. As tenantA, confirm the active tenantB Router blocks revocation without disclosing private Router details. Remove the recipient reference, revoke, and confirm tenantB loses read and composition access.
7. Repeat supported resource reads and writes with a tenant user's personal access token and the operations CLI. Use the separate platform administrator account to verify Provider credentials and global model bindings remain platform-only.

Seeded Endpoints are disabled inventory examples. They do not establish deployed Runner traffic or replace an integration test of the intended adapter.

## Verification and remaining work

Automated coverage includes real PostgreSQL mock SSO sessions and persisted token identity, cross-tenant inventory and direct-ID access, read-only sharing and revocation, Policy/Guardrail/Router composition, Model and Provider boundaries, package access, runtime and cost attribution, security-event pagination, audit attribution, and migration/backfill behavior. UI tests cover identity changes, scoped navigation and counts, sharing, and owner-only controls. The rebased OpenAPI generator emits 141 operations and 426 schemas.

Relevant regression suites include [multi-tenant.postgres.test.ts](../controller/server/http/multi-tenant.postgres.test.ts), [tenant-isolation.postgres.test.ts](../controller/server/services/tenant-isolation.postgres.test.ts), [multi-tenant-migration.postgres.test.ts](../controller/server/db/multi-tenant-migration.postgres.test.ts), [guardrail-operational-data.postgres.test.ts](../controller/server/services/guardrail-operational-data.postgres.test.ts), and the model, routing, package, authentication, and console suites. Database suites use `GUARD_TEST_POSTGRES_URL`, `TEST_DATABASE_URL`, and `GUARD_BOOTSTRAP_TEST_DATABASE_URL`, according to the suite. Local HTTP/TLS tests require loopback socket access.

Validation recorded on 2026-10-19, before the rebase:

| Check | Result |
| --- | --- |
| Full Controller suite, `--maxWorkers=3 --testTimeout=15000`, with all three PostgreSQL variables pointing to a disposable loopback database | 2,303 tests passed across 242 files; none skipped |
| `npm run test:cli` | 23 tests passed |
| `npm run typecheck` | Passed for UI, server, and CLI |
| `npm run build` | Production UI, server, and CLI builds passed |
| OpenAPI generation and check | Passed; 143 operations and 421 schemas |
| `git diff --check` | Passed |

Rebase checks recorded on 2026-10-22:

| Check | Result |
| --- | --- |
| Controller typecheck (UI, server, CLI) | Passed |
| Focused tenant migration, isolation, Model, and Endpoint PostgreSQL suites | 39 tests passed across 5 files |
| Targeted authorization, Runner management, and sidebar suites | 220 tests passed across 3 files |
| Full Controller suite, `--maxWorkers=3 --testTimeout=15000`, with all three PostgreSQL variables pointing to a disposable loopback database | 2,470 tests passed across 259 files |
| Production UI, server, and CLI build | Passed |
| OpenAPI generation and check | Passed; 141 operations and 426 schemas |
| `git diff --check` | Passed |

This remains a management-plane implementation with automated isolation coverage. The local browser and CLI walkthrough, a production identity provider and tenant onboarding, and deployed Runner validation are not yet verified. Runners consume one global platform model configuration; tenant Model activation needs a protocol and delivery design. Runner management and system status remain deployment-wide for both roles. These limits must remain visible when demonstrating the feature or assessing production readiness.

## Local visual experiment — 2026-10-26

The deployed administrator [Tenant Load Lab](tenant-load-lab.md) now drives real three-tenant Input/Output checks through one shared Runner, with a fixed-delay local HTTP model between the checks. It plots measured occupancy, latency, throughput, queueing, and shared Runner CPU/memory, with temporary tenant peaks and a clearly labeled client quota simulation. The guide includes setup, measurement definitions, the final live comparison, and observed local resource limits. The current API contract has 143 operations and 436 schemas.

See the [deployment record](multi-tenancy-deployment-2026-10-26.md) for earlier real runtime checks and the [resource-isolation audit](multi-tenancy-isolation-audit-2026-10-24.md) for the remaining Runner isolation gaps. These later local checks supersede the unverified local-runtime status in the earlier scope notes above; they do not establish production CPU quotas or failure isolation.

## Tenant Group allocation — 2026-10-27

[**Tenant Groups**](tenant-groups.md) now assign tenants and Runner pools to a shared compute group. Runner desired-state delivery, Endpoint credentials, published routing, validation dispatch and Playground transport follow the group allocation. Existing tenants and pools migrate to a default group; sharing a group does not grant access to other tenants' resources. The local verification runs two group pools and checks that each Runner rejects the other group's Endpoint.

The earlier isolation audit and shared-Runner lab describe their respective pre-group and shared-pool scenarios. Group allocation does not make the shared Controller, database, Redis, provider configuration or physical node independent failure domains.

## Guardrail Policy content visibility — 2026-10-30

A Guardrail share permits reading its shared configuration, but does not transitively share private Policy source or tests. A tenant can inspect a retained version's compiled and Policy-derived details only when its frozen Policy definitions match currently readable Policy versions, or the exact shipped public catalog definition. Version responses report `policyContentAccessible=false` and withhold plans, Policy nodes, compiled Artifact content, inspection and test evidence when that proof is missing. The console shows an access notice instead of compiled and Policy tabs. Frozen suites, generated Policy cases and validation-result detail fail closed on missing access or provenance. Explicit Policy read shares can enable these reads and revocation is rechecked on subsequent reads.

Legacy versions without recorded Policy nodes, deleted or reused Policy identities, and contradictory plan projections cannot be assumed safe to disclose. This can hide content from the Guardrail owner when original Policy provenance cannot be established. Platform administrators retain operational access. Package export has a stronger onward-redistribution rule: a read-only Policy share does not grant permission to embed its source in an exported package. Compiled file integrity continues to rely on the stored publication/import contract; these visibility checks do not recompile an Artifact. The permission checks do not serialize an entire multi-statement request against concurrent share changes.
