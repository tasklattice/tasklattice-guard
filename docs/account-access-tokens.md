# Account and Personal Access Tokens

Goal: let users create personal tokens with explicit permission boundaries for scripts, CI, and system integrations. Reuse the existing Account page, Tabs, EntitySheet, and semantic buttons, emphasizing module scope, permissions, and lifecycle status.

## Permission Model

`Token → Creator + Module permissions + Expiration time + Revocation status`

Each module offers “No access,” “Read-only,” or “Read/write.” Read/write includes read access as well as creation, modification, publication, rollback, validation, and deletion within the module. Unauthorized modules and new endpoints not listed in the endpoint permission table are denied by default.

This release grants access to **all resources within a module**, including future resources. Scoping access to a specific GuardRail or Router ID is not supported. Both the creation form and token list explicitly display this scope.

| Module | Read-only | Additional read/write capabilities |
| --- | --- | --- |
| GuardRails | Configuration, versions, logging configuration, test and validation results | Create, modify, duplicate, publish, roll back, delete, validate, analyze designs |
| Routers | Routes, revisions, distribution, Selector fields and previews | Drafts, publication, rollback, deletion, Endpoint binding |
| Endpoints | Integration configuration | Create, update, delete, manage integration credentials |
| Policy Library | Policies, presets, action catalog, validation results | Create, modify, validate, publish, delete |
| Playground | Available models | Draft previews, interactive runs (may invoke models) |
| Model configuration | Configuration, models, providers | Provider credentials, discovery, connection validation, configuration changes, activation and rollback |
| Runners | Status and capacity | Adjust capacity, remove instances |
| Runtime logs | Runtime events, traffic metrics, captured content visible under account permissions | No write access |
| Audit log | System audit records | No write access |

A Router's Endpoint bindings are Router lifecycle operations and do not require separate write access to Endpoint configuration. Cross-module resource references do not grant independent API access to the referenced module.

Effective permissions = Token grants ∩ User's current account permissions. Administrators can grant read/write access; regular users can create read-only tokens. Each authentication check reloads the creator's role and disabled status: demotion immediately denies writes, and disabling or deleting the account denies all token requests. Existing administrator restrictions still apply (for example, deletion-impact queries).

Personal tokens cannot manage other tokens, accounts, users, or Better Auth administrative endpoints; these operations continue to require a browser session. Runner internal keys, Endpoint data-plane credentials, and personal control-plane tokens are managed separately.

## Lifecycle and Storage

- A name is required, up to 100 characters. Expiration options are 7 / 30 / 90 / 365 days, defaulting to 30 days. Each user may have at most 50 unexpired, unrevoked tokens.
- Tokens start with `tlg_pat_` and use 32 cryptographically random bytes. The database stores only a SHA-256 digest and a display prefix that cannot authenticate requests.
- The complete token is returned only once, in the creation response. The frontend holds it only in temporary component state, destroys it on close or navigation, and never places it in the React Query cache or persistent browser storage.
- The list returns the name, prefix, permissions, and creation/expiration/last-used/revocation timestamps, never the digest or plaintext.
- The creator revokes the token; revocation is idempotent. New requests after expiration or revocation return 401. In-flight requests that have already authenticated may finish.
- Creation and revocation are audited. Authorized non-GET/HEAD requests also record the token ID, owner, endpoint template, and response status, without saving request bodies, Authorization headers, or complete tokens in the audit log.
- When Authorization is explicitly provided, authentication uses only that credential, with no fallback to a cookie session.
- Token management requires a signed-in session and trusted Origin; creation requires JSON. Management responses and token-authenticated responses use `Cache-Control: no-store`.

Database migration: `controller/server/db/migrations/0011_personal_access_tokens.sql`. The Controller applies migrations automatically on startup; existing account data requires no conversion.

## Account URLs

| URL | Page |
| --- | --- |
| `/account` | General (the default Account entry point) |
| `/account/general` | Redirects to `/account` |
| `/account/security` | Security |
| `/account/access-tokens` | Access Tokens |

Account uses a persistently mounted parent page with URL-driven selection. Refresh, forward, and back restore the current page; switching tabs preserves unsaved General form state. The Account breadcrumb returns to the default page.

## API

Available only to signed-in sessions:

- `GET /api/v1/account/access-tokens`: list the current user's tokens.
- `POST /api/v1/account/access-tokens`: create a token; example body:

```json
{
  "name": "CI deployment",
  "expiresInDays": 30,
  "permissions": { "guardrails": "write", "routers": "read" }
}
```

- `DELETE /api/v1/account/access-tokens/:id`: revoke a token; returns 204 on success.

Example token requests (set the value returned at creation in the environment variable):

```sh
curl "$GUARD_URL/api/v1/account/identity" \
  -H "Authorization: Bearer $GUARD_ACCESS_TOKEN"

curl "$GUARD_URL/api/v1/routers" \
  -H "Authorization: Bearer $GUARD_ACCESS_TOKEN"
```

`account/identity` returns `userId`, the current `role`, authentication method, `tokenId`, the original granted `permissions`, and role-constrained `effectivePermissions`. Invalid, expired, or revoked tokens return 401; insufficient permissions return 403. Public health and system-status endpoints retain their existing public-access rules.

## Verification

- PostgreSQL integration tests apply every migration to an empty schema and cover digest storage, key uniqueness, expiration, revocation, owner isolation, disabled/deleted/demoted users, read-only users, and invalid permission input.
- HTTP tests cover the permission inventory, no cookie fallback, cross-module denial, write denial for read-only tokens, token operation ownership, session-only management, trusted Origin, and no-store.
- UI tests cover permission selection, one-time plaintext destruction, retries after creation failure, recovery from list-loading and revocation failures, and account navigation.
- An isolated real Controller + PostgreSQL (`localhost:38186`) completed end-to-end verification of login, creation, Bearer identity, read-only access, authorization denial, and 401 after revocation.
- Browser checks covered Account tab selection and URLs, Security refresh/back navigation, the creation form, and revocation state. The user's running instance on `38081` was not modified.

All 306 relevant tests, frontend/backend production builds, and type checks passed. The 390px layout, tab focus, and preservation of General inputs were verified in the browser. See the [verification record](evidence/account-access-tokens-20260912/review.md) for detailed evidence.
