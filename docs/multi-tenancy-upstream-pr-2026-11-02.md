# Multi-tenancy upstream integration — 2–3 November 2026

The pending tenant-group work was saved in `3df66a07` before integrating
`upstream/main` at `c2fdbe02`. This record distinguishes the integrated source
from the earlier [working-tree checkpoint](multi-tenancy-validation-2026-11-02.md).

## Compatibility changes

- Keep upstream username login and authoritative bootstrap synchronization;
  Stage-1 mock SSO provisions fixed usernames and uses the same Better Auth path.
- Preserve upstream report streaming, runtime failure semantics, optional Endpoint
  credentials, database budgets and UI changes alongside tenant ownership,
  sharing, group allocation, admission and Model grants.
- Append tenant migrations to upstream's fresh V1 baseline. The former feature
  migrations `0049`–`0065` are now `0002`–`0018`, in the same order. Their journal
  timestamps follow upstream `0001_endpoint_credential_required`. This follows
  upstream's fresh-database rule; it does not upgrade the older local demo schema.
- Regenerate protobuf clients after assigning feature fields unused wire numbers.
  Controller and Runner versions implementing these opt-in modes must be deployed
  together; earlier experimental feature images are not wire compatible.
- Follow upstream's build-time OpenAPI generation and Helm template validation.

## Validation

Before upstream integration, the four focused administrator UI suites passed
36 tests, protocol freshness and whitespace checks passed, and UI/server/CLI
typechecking and build passed. A separate local database also accepted the new
combined migration sequence. The retained demo database was not migrated.

Final combined-source checks completed on 3 November 2026:

| Check | Result |
| --- | --- |
| Controller server sweep | 1,373 passed, 428 gated/intentional skips; seven Endpoint fixture failures were corrected and the final 26-case Endpoint suite passed |
| PostgreSQL sweep | 57 files exercised: 458 cases passed initially; all six failures and the two cases blocked by an obsolete fixture were resolved; final affected-file rerun passed 46 cases across five files |
| Authentication, migrations, Models and API contract | 162 tests passed across 11 focused files |
| Frontend authentication, tenant navigation, Policy and group controls | 216 tests passed across 19 files |
| Focused control-channel/gRPC, report routes and product authorization | 61, 39 and 210 tests passed in their respective runs |
| Helm, Artifact and provenance checks | 137 tests passed |
| Runner transport, synchronization, Scan and streaming | 154 tests passed |
| Lease/admission checks | 92 passed initially; the separate real-Redis group/distributed admission run passed 96 tests with no skips |
| Developer commands | 21 passed in the initial CLI run; the two WebSocket cases denied sandbox sockets passed with loopback permission |
| TypeScript and production build | UI, server and CLI passed |
| Generated contracts | Protobuf freshness passed; OpenAPI generation produced 158 operations and 471 schemas |
| Whitespace | `git diff --check` passed |

Counts overlap and must not be added. The PostgreSQL sweep and final affected-file
rerun together exercised all 466 cases in that sweep. Fixture updates preserve
tenant checks, require explicit frozen Policy provenance and registered Runner
pools, and await background report pruning before single-connection assertions.
No failing check remains from the runs above.

An earlier run against the local demo cluster was interrupted by PostgreSQL
`OOMKilled` (exit 137), so it is not counted as successful validation. The final
database sweep used a separate resource-bounded PostgreSQL container. Redis
fixtures used unique keys and cleaned only those keys. Neither run upgraded the
retained demo workload.

The [current status](multi-tenancy-status.md) documents opt-in modes and remaining
implementation and deployment limits. These local checks do not establish
production readiness or cluster failover behavior.
