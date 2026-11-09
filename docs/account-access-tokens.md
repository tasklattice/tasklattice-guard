# Account and Personal Access Tokens

Personal access tokens let scripts and integrations call the Controller with explicit resource permissions. Create and revoke them at **Account → Access Tokens** (`/account/access-tokens`), using a signed-in browser session.

## Permission model

`Effective authority = selected resource grants ∩ creator's current role ∩ resource scope`

Each resource offers **No access**, **Read only**, or **Read and write**, capped by the creator's role. Write includes read. Unselected resources and unclassified API routes are denied. Grants cover the selected resource type, including future resources; they cannot be restricted to individual Guardrail or Router IDs.

| Permission key | Resource | Administrator | Project user | Operations |
| --- | --- | --- | --- | --- |
| `projects` | Projects | Read/write | None | List/create projects; list members and candidates; add/remove local members; read/configure a project's Runner; assign a project to a group; list a group's projects |
| `projectGroups` | Project groups | Read/write | None | List/read/create/update/delete groups; list/create allocated Runner pools; read admission monitoring |
| `providers` | Providers | Read/write | Read | Provider metadata; administrators can manage connections and credentials, discover/test connections, and register a Provider with its Models |
| `models` | Models | Read/write for platform Models; project Models read only | Read/write for owned Models | Model inventory, definitions, connection/capability tests, runtime settings, protocol and deletion |
| `modelConfiguration` | Model configuration | Read/write | Read of project-visible configuration | Platform assignments, candidate validation, draft validation and activation; project-group model assignments |
| `modelPricing` | Model pricing | Read/write | None | Pricing and pricing catalog reads; update model pricing rules |
| `runners` | Runners | Read/write | Read | Pool/instance status, health/version, capacity, connectivity and instance removal |
| `guardrails` | Guardrails | Read only, explicit project required | Read/write | Configuration, versions, packages, test cases/results, logging and costs; user writes include creation, changes, testing, publication and deletion |
| `routers` | Routers | Read only, explicit project required | Read/write | Routes, revisions, change requests, distribution and simulation; user writes include draft changes, change-request workflow and Endpoint bindings |
| `endpoints` | Endpoints | Read only, explicit project required | Read/write | Integration configuration; user writes include lifecycle and integration credentials |
| `policies` | Policy Library | Read only, explicit project required | Read/write | Project policies, definitions and test results; user writes include changes, testing and publication |
| `playground` | Playground | Read only, explicit project required | Read/write | Read available models; user writes run previews and interactions |
| `runtime` | Runtime logs | None | Read only | Project events, traffic metrics and captured content |
| `audit` | Audit log | Read only | None | Platform activity records |

Global catalogs (`guardrail-capabilities`, `authoring/capabilities`, `policy-catalog/actions`, `policy-catalog/detectors`, `routing/selector-fields`) have no project owner and do not require a Project ID. Their existing module read grants still apply. Group model configuration and candidate-validation operations retain platform authority checks.

A Router's Endpoint bindings are Router lifecycle operations and do not require separate Endpoint write access. Combined Provider registration belongs to `providers:write`. A project's Runner allocation belongs to `projects`; pool connectivity and capacity belong to `runners`. Cross-resource references do not grant independent API access to another resource type.

Administrators cannot create, change, publish, delete or test project business resources, even if an old token contains a write grant. A Router simulation is a read operation despite using POST. Runtime content remains unavailable to administrators. Token issuance checks the current account role and project membership; project members with read-only access cannot issue write tokens.

## Selecting a project

### Administrator requests

Every administrator read of project business resources requires:

```http
Authorization: Bearer <personal-access-token>
X-Project-ID: <project-id>
```

This includes lists, details, nested versions/test results, package previews/downloads and Router simulations. Browser administrators obey the same project-read boundary. The administrator token itself remains a platform credential; the header selects the project for that request without changing the token or acquiring project-user write authority.

- Missing header: `400 project_required`.
- Invalid ID (only letters, digits, `_` and `-`, 1–128 characters): `400 invalid_project_id`.
- Unknown project: `404 not_found`.
- Resource owned by another project: `404 not_found`, including resources shared into the selected project. Administrator inspection returns resources owned by the selected project only.
- `?projectId=...` is not a project selector and returns `400 invalid_project_selector` on these reads. Use the header.
- An ungranted operation returns `403 insufficient_token_permission` before inspecting the project.

`GET /api/v1/models` and `GET /api/v1/model-configuration` read the **platform** inventory without the header. Send `X-Project-ID` to inspect a project's inventory read-only. Platform model mutations carrying this header return `403 project_read_only`; it cannot be used to modify project Models.

Project administration uses the Project ID in the URL where applicable, e.g. `/api/v1/projects/<id>/members`. It does not require `X-Project-ID`. Platform entities such as Providers, groups and pricing also do not require a project header.

### Project-user tokens

Project-user tokens are permanently bound to the active project at creation. Requests need no Project ID. Switching the browser's project, sending a project header or supplying a query parameter cannot change the token's project. Reads include owned resources and resources explicitly shared to that project; writes require ownership. Membership removal, loss of required write access, account disablement/deletion, or a change between user and administrator invalidates the token. SSO credentials additionally require a sufficiently recent SSO login under the existing membership-refresh policy.

## Projects management

| API | Required grant |
| --- | --- |
| `GET /api/v1/projects` | `projects:read` |
| `POST /api/v1/projects` | `projects:write` |
| `GET /api/v1/projects/:projectId/members` | `projects:read` |
| `GET /api/v1/projects/:projectId/member-candidates` | `projects:read` |
| `PUT /api/v1/projects/:projectId/members/:userId` | `projects:write` |
| `DELETE /api/v1/projects/:projectId/members/:userId` | `projects:write` |
| `GET /api/v1/projects/:id/runner` | `projects:read` |
| `PUT /api/v1/projects/:id/runner` | `projects:write` |
| `PUT /api/v1/projects/:id/group` | `projects:write` |
| `GET /api/v1/project-groups/:id/projects` | `projects:read` |

All require the administrator role. Existing validation, stale-allocation checks and SSO-managed-membership restrictions remain enforced. Token-authenticated writes record the token ID, actor, route and status. Browser management retains trusted-Origin checks.

User-account management, other token management and resource-sharing management still require a browser session. Runner internal credentials, Endpoint data-plane credentials and personal control-plane tokens are separate.

## Migration from `settings`

`settings` is retired. New token requests containing it are rejected. Existing stored `settings` grants are ignored, omitted from returned supported permissions, and **never expanded into the new entity grants**. Other supported grants remain valid. Reissue integration tokens with explicit `projects`, `projectGroups`, `providers`, `modelConfiguration`, `modelPricing` or `runners` grants as needed. A token with no remaining effective grants is identified in the UI and can still be revoked.

Provider reads now require `providers:read`, and configuration reads require `modelConfiguration:read`; `models` no longer authorizes those endpoints. Existing administrator business-resource callers must add `X-Project-ID`. The generated OpenAPI document records each entity grant and `x-admin-project-scope`, plus the header's conditional `x-required-for-roles` requirement.

## Token lifecycle and API examples

- Required name, at most 100 characters; expiry is 7, 30, 90 or 365 days (default UI selection: 30). At most 50 active tokens per user.
- Tokens have prefix `tlg_pat_` and 32 cryptographically random bytes. Only a SHA-256 digest and non-authenticating display prefix are stored.
- The full secret is returned only at creation, held temporarily in the UI and cleared on close/navigation. It is never cached in React Query or browser storage.
- Explicit Authorization never falls back to cookies. Invalid, expired or revoked tokens return 401; unavailable grants return 403. Credential and token-authenticated responses use `Cache-Control: no-store`.
- Creation/revocation and authorized mutations are audited without storing request bodies, headers or token plaintext. Revocation is idempotent; already-authenticated in-flight requests may finish.

Session-only management APIs:

- `GET /api/v1/account/access-tokens`
- `POST /api/v1/account/access-tokens`
- `DELETE /api/v1/account/access-tokens/:id`

Example administrator creation body:

```json
{
  "name": "Project inventory",
  "expiresInDays": 30,
  "permissions": { "projects": "read", "guardrails": "read" }
}
```

Use the one-time returned secret as `GUARD_ACCESS_TOKEN`:

```sh
curl "$GUARD_URL/api/v1/projects" \
  -H "Authorization: Bearer $GUARD_ACCESS_TOKEN"

curl "$GUARD_URL/api/v1/guardrails" \
  -H "Authorization: Bearer $GUARD_ACCESS_TOKEN" \
  -H "X-Project-ID: $GUARD_PROJECT_ID"

curl "$GUARD_URL/api/v1/account/identity" \
  -H "Authorization: Bearer $GUARD_ACCESS_TOKEN"
```

Identity returns the user, current role, authentication method, token ID, supported granted permissions and role-constrained effective permissions. Administrator identity has `projectId: null`; project selection is request-local.

## Verification

Permission tests cover the route inventory, entity-grant isolation, retired grants, administrator write rejection, required/invalid/unknown project selection, browser Origin checks, project management and audit attribution. PostgreSQL HTTP integration tests exercise real token issuance, cross-project list/detail isolation, sharing boundaries and project membership changes. UI tests cover administrator entity selectors, business read-only choices, project-bound users, retired-grant display and one-time secret handling. OpenAPI tests verify the same grants and conditional Project header. UI acceptance is desktop-only.
