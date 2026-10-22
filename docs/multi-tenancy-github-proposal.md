# Proposal: Multi-tenant resource isolation demo

## Summary

Give each organization its own Controller resources: Policies, Guardrails, Traffic Routers, Endpoints, and Model definitions. Model Providers remain supplied and managed by the platform. A tenant manages its own resources and may explicitly share a resource with another tenant for read-only access and supported composition.

The first milestone uses three fixed local identities. A temporary mock SSO chooser lets testers switch between them. The implementation record and remaining verification are in [multi-tenancy.md](multi-tenancy.md), updated for `feat/multi-tenant-v2` on 2026-10-19.

## Why

Separate teams need to manage protection and routing configurations without seeing or changing another team's private resources. The demo should make both the default tenant boundary and intentional sharing visible.

## Demo scope

### Identity and ownership

- Each tenant user has one persisted tenant. The server derives authority from the current account; request parameters and headers cannot override it.
- Preserve the upstream roles: `user` authors tenant resources and `admin` manages platform configuration. Being in `tenantA` does not grant platform administration.
- Apply the boundary to lists, direct-ID reads, writes, nested versions, artifacts, and references. Console and operations CLI resource requests use the same API authorization rules.
- Keep built-in catalogs shared and read-only. Show each resource's owner and distinguish an explicit share from ownership.
- Keep Model Providers, their credentials, and global model bindings under platform control. Tenants can select provider metadata and own Model definitions, but cannot manage providers or view their credentials. Tenant Model definitions do not replace the global Runner configuration.

### Tenant-scoped side panel

- Show the active tenant. Resource links, counts, recent items, and shortcuts reflect only its owned resources and explicit shares.
- Hide actions and navigation the active role cannot use, including platform-only Provider management.
- Refresh identity-scoped queries and clear previous resource data when switching accounts.

### Sharing

- Let a tenant owner grant and revoke read-only access to one Policy, Guardrail, Router, Endpoint, or Model for one recipient tenant. Provider sharing is not supported.
- Recipients can inspect a share but cannot edit, publish, delete, access credentials, or share it onward.
- Support a shared Policy in a recipient's Guardrail and a shared Guardrail in a recipient's Router. An Endpoint remains bound to an owned Router in its own tenant.
- Keep sharing non-transitive. A Router share does not expose private target Guardrails, and a Model share never exposes Provider credentials.
- Audit grants and revocations. Block revocation while supported active dependencies remain, and recheck authorization when publishing a previously validated draft. Describe blockers without revealing another tenant's private resource details.

### Temporary sign-in fixture

The local mock SSO chooser has three fixed options, all with role `user`:

| Tenant | Demo identity | Group label |
| --- | --- | --- |
| `tenantA` | Tenant A Operator | `group_a` |
| `tenantB` | Tenant B Operator | `group_b` |
| `tenantC` | Tenant C Operator | `group_c` |

Selecting an option signs in through Better Auth and switches the available resources. The chooser requires explicit enablement on a loopback, non-production Controller. It is a test fixture; production SSO and tenant onboarding remain follow-up work. Use a separate platform administrator account for platform settings.

## Demo walkthrough

1. Sign in as Tenant A Operator and create a Guardrail and Router. Confirm the active tenant, resources, and counts in the side panel.
2. Switch to Tenant B Operator. Confirm tenantA's unshared resources disappear from both the page and side panel, then create a tenantB Router.
3. Switch back to tenantA and share a published Guardrail with tenantB.
4. In tenantB, confirm it is read-only and selectable as a Router target. Confirm it cannot be edited or shared onward, then complete the normal publication workflow.
5. In tenantC, confirm neither tenantA's private resources nor the A-to-B share are visible.
6. Confirm the active recipient reference blocks revocation. Remove the reference, revoke as tenantA, and confirm tenantB loses access.
7. Repeat supported resource operations through the CLI with tenant personal access tokens. Verify Provider management separately with the platform administrator account.

## Acceptance criteria

Checked items have automated coverage; they do not assert completion of a manual browser or deployed Runner walkthrough.

- [x] Real mock SSO sessions produce separate tenant inventories, and owned or explicitly shared access is enforced for lists and direct-ID requests.
- [x] Console tests show the active tenant, identity-scoped links and counts, and refreshed queries when identity changes.
- [x] Providers remain platform-managed. Tenant users can select metadata but cannot manage providers or view credentials.
- [x] API writes to foreign resources, including read-only shares, are rejected.
- [x] Policy, Guardrail, Router, and Endpoint references follow ownership and sharing rules, with live authorization checks at publication.
- [x] Grant and revoke controls have console coverage, and real PostgreSQL tests verify audit records, recipient visibility, and revocation blockers.
- [x] Mock SSO tests cover the three tenant operator identities, local-only enablement, and session identity switching; console tests cover stale-data prevention.
- [ ] Complete the walkthrough in a local browser against a migrated database and with the operations CLI where resource commands exist.
- [ ] Verify deployed Runner traffic, telemetry attribution, and delivery with the intended adapters.

Production identity-provider trust, tenant user onboarding, and tenant-specific model configuration delivery are outside this demo milestone.
