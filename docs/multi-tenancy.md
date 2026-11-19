# Project multi-tenancy

A **Project** owns business resources and runtime evidence. A **User** can be a
member of several Projects. Runtime groups control Model access, and Runner
pools control where requests execute. The `default` group and pool serve
eligible shared Projects.

## Implemented features

| Area | Current behavior |
| --- | --- |
| Identity and membership | Local accounts and Keycloak OIDC are supported. Administrators manage local membership. Verified Keycloak Group Paths synchronize SSO membership and grant read-only or read/write access. Sessions can switch among current memberships. [Platform access](document/en/admin/03-platform-access.mdx) |
| Management credentials | Business-user personal access tokens (PATs) are bound to the Project selected at issuance. Current account status, membership, expiry and module grants limit each request. Platform administrators have separate governance permissions and can explicitly select a Project for read-only entity inspection. [Access-token authority](account-access-tokens.md) |
| Resource isolation | Policies, Guardrails, Routers, Endpoints and associated versions, tests, reports and packages are checked against Project ownership. Project Defaults are provisioned at initialization. Built-in catalogs and permitted platform Models are available across Projects. [Project context](../controller/server/services/project-context.ts), [ownership tests](../controller/server/services/project-isolation.postgres.test.ts) |
| Runner placement | Eligible Projects use the shared pool. Dedicated capacity has its own pool and runtime group. Allocations determine which Endpoints, routing revisions and Guardrail artifacts reach each pool. An unavailable dedicated pool leaves its Project without runtime capacity. [Allocation and routing](../controller/server/services/runner-allocation.ts), [Helm scaling contract](../charts/tali-guard/README.md#scaling-contract) |
| Model access | The default group can inherit platform Models. Groups can receive a validated, frozen Model grant or operate in blocked mode. Pool-scoped credential resolution checks the active allocation or validation lease. [Group Model configuration](../controller/server/model-config/group-runtime.ts), [Model configuration](model-configuration.md) |
| Runtime credentials and evidence | Endpoints can require their own runtime credential. The Controller uses Endpoint ownership and verified runtime context to attribute evidence. Unknown or conflicting provenance is withheld from Project views. Logs, dashboard activity, findings, audit and usage costs have Project-scoped views. [Runtime integration](gateway-integration.md), [dashboard isolation tests](../controller/server/http/dashboard-tenant-isolation.postgres.test.ts) |
| Admission | Runners can enforce per-process Project concurrency and queue limits. Redis-backed policies can enforce request-start rates across participating replicas. A platform admission monitor presents bounded diagnostics. Serving leases are experimental. [Project admission](../runner/project_admission.py), [group rates](../runner/group_rate_admission.py), [admission monitoring](../controller/server/services/admission-monitor.ts) |

## Code changes from this audit

- Unscoped platform access to the routing selector catalog returns static
  fields. Endpoint-derived fields require an explicit Project context.
  Authenticated management API responses use `Cache-Control: no-store`.
- Published Router Playground probes now keep a separate call pin from live
  Endpoint traffic with the same call ID. Live call IDs and evidence
  attribution retain their existing format.
- Runtime event details hide captured bodies after 30 days, and delayed Runner
  uploads cannot restore expired body content. Event metadata, findings and
  cost evidence remain available.
- The standalone acceptance tool recognizes all three current Model-policy
  modes. It checks that each Project can read its own paired input/output
  evidence and that other Projects cannot list or open those records.

## What still needs work

| Area | Missing capability or deployment dependency |
| --- | --- |
| Project lifecycle | There is no Project suspend, archive, rename, delete or full-Project export workflow. Complete offboarding would need coordinated credential revocation, runtime withdrawal and a policy for retaining or purging evidence. Resource-level deletion and package export exist today. |
| Delegated administration | Platform administrators manage local membership. The API has no Project-level member administrator or cross-Project resource-sharing workflow. [Platform access](document/en/admin/03-platform-access.mdx) |
| Dedicated Runner lifecycle | Operators provision dedicated workloads, Services, network access and credentials separately. Registering a pool only configures the Controller. Existing allocation moves require offline Runners. Live drain and lease-aware handoff remain unavailable. [Helm scaling contract](../charts/tali-guard/README.md#scaling-contract), [allocation checks](../controller/server/services/project-groups.ts) |
| Quotas and capacity | Admission policies are configured on Runners and in Redis. There is no Project quota management API, fleet-wide concurrency reservation or automatic scaling based on Project guarantees. Shared compute, Redis and upstream Models can still contend across Projects. [Runner configuration](../runner/config.py) |
| Storage isolation and retention | PostgreSQL is shared and resource queries enforce ownership in application code. Per-Project databases, PostgreSQL row-level security and configurable Project evidence retention are absent. Expired captures still need a database purge job and a backup retention policy. [Database schema](../controller/server/db/schema.ts), [Runtime logs](document/en/admin/04-concept-logs.mdx) |
| Identity revocation | Keycloak membership changes take effect on the next verified sign-in and SSO authority has a bounded lifetime. The Controller has no push revocation integration. Platform administrators can disable an account for urgent revocation. [SSO synchronization](document/en/admin/03-platform-access.mdx#access-shared-operations) |
| Scoped telemetry operations | Pool-scoped telemetry authenticates the pool. Per-Runner telemetry freshness is unavailable in this mode, and resource deletion checks that require fresh evidence can block. [Telemetry intake](../controller/server/http/app.ts), [deletion checks](../controller/server/services/control-plane.ts) |
| Billing | Model usage and cost estimates support internal accounting. Customer billing, per-Project spend budgets, hard cutoffs and invoices are absent. [Model costs](model-configuration.md#global-prices-and-guardrail-usage-costs) |

## Deployment acceptance

1. Deploy the Controller and Runner images built from the same revision. Verify
   the schema baseline, serving replica counts and synchronized desired state.
2. Create two Projects on the shared pool and one on dedicated capacity. Verify
   local session switching, read-only membership, PAT scope and member removal.
   Exercise real Keycloak login and revocation when using SSO.
3. Run the [standalone acceptance tool](tenant-load-lab.md#verify-existing-projects)
   with the actual gateway, Runner and Project credentials. Check resource and
   telemetry isolation, Model modes, and paired input/output records. Test
   cross-replica call pinning when the pool uses Redis. Use fresh Playground
   call IDs during rollout while pins from the previous Runner version expire.
4. Verify wrong-pool denial, version activation and offline allocation changes.
   When using pool-scoped telemetry, exercise deletion safety with disposable
   resources.
5. Exercise enabled admission, rate and lease modes with representative
   contention and dependency failures. Review actual latency and serving
   capacity before making capacity guarantees.

The [multi-project PostgreSQL test](../controller/server/http/multi-project.postgres.test.ts)
seeds Profiles and the default pool before Controller initialization. Run it
against a disposable local PostgreSQL database using the
[development test guide](development.md).
