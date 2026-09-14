# Controller API Contract Conventions

This API change does not preserve old paths. The frontend, token permission table, OpenAPI, invocation index, and tests are updated together. It covers only the Controller's public product API; Runner invocation APIs, internal control channels, and the login service use their own contracts.

## Standard Documentation and Generation Sources

- `/api/docs`: API reference grouped by product domain, explaining operation semantics and retry rules.
- `/api/openapi.json`: standard OpenAPI 3.1 document, currently containing 97 operations.
- `/api/openapi.json?module=routers`: complete document filtered by product Tag.
- `/api/openapi.json?operationId=postRoutersByIdPublish`: a single operation and its recursive Schemas.
- `/api/llms.txt`: model invocation index, including permissions and idempotency categories.

Methods, paths, input Schemas, return types, and status codes are generated from Hono/Zod/TypeScript code; token permissions come from the actual authorization table. Product Tags, business meaning, and idempotency/retry guidance are centralized in `controller/shared/api-contract.ts` and reviewed with code. Business semantics cannot be inferred automatically from TypeScript types alone.

After changing an API, run `npm run openapi:generate --prefix controller`. Build and CI `openapi:check` checks block stale contracts. Tests verify coverage of actually mounted endpoints, permission consistency, Schema validity, and complete reference resolution in filtered documents.

## Product Groups and Permissions

| Product domain | OpenAPI Tags |
| --- | --- |
| Account | account, access-tokens |
| Guardrail Design | guardrails, policies, validation, authoring, playground |
| Integration | routers, endpoints |
| Observability | telemetry, audit |
| Platform Settings | model-providers, models, model-configurations, runners, system |

Tags explain the product; they do not determine authorization. For example, Router traffic statistics belong to telemetry but still require routers:read. Guardrail and Policy validation both belong to validation but require their respective module permissions. Use each operation's `x-token-permission` as the authority.

Tokens are passed through `Authorization: Bearer <token>`. `GET /api/v1/account/identity` returns identity and effective permissions. The current authorization scope is module-level read/write, covering all resources in that module. Writes also require the current account to have an administrator role. Token management accepts only the account owner's browser Session.

## Resource Paths and Functional Boundaries

The paths below omit the common `/api/v1` prefix. Old paths have been removed, with no aliases or automatic redirects.

| Resource / responsibility | Current path and behavior |
| --- | --- |
| Guardrail Test Case | `GET/POST /guardrails/{guardrailId}/test-cases`; `DELETE /guardrails/{guardrailId}/test-cases/{caseId}`. The parent ID is required to locate the case. |
| Executable Guardrail validation | `POST /guardrails/{guardrailId}/validation-runs` creates a job; global `/validation-runs` supports queries across Guardrails. |
| Static Policy checks | `GET /policies/{id}/draft/checks` performs read-only checks without creating a Runner job. |
| Executable Policy validation | `POST /policies/{id}/validation-runs` creates a job and returns 202, Location, and statusUrl. Poll this specific job through `/policies/{id}/validation-runs/{runId}`; latest is only for browsing the most recent record. |
| Router publication preview | `POST /routers/{id}/publication-preview` resolves the reviewed version, snapshot, and Endpoint set. |
| Router rule simulation | `POST /routers/{id}/simulations` computes input matches without publishing or executing a Guardrail. |
| Router historical traffic | `/routers/{id}/traffic-distribution` and its route-specific counterpart. Read Router rolloutStatus/desiredGeneration for configuration distribution status. |
| Router historical publication | `GET /routers/{id}/revisions/{revision}` reads an exact revision. |
| Routing field catalog | `GET /routing/selector-fields`; the old traffic-scope-fields endpoint is removed. |
| Runtime observability | `/telemetry/events`, `/telemetry/metrics`, `/telemetry/endpoint-activity`. |
| Assisted design | `/authoring/capabilities`, `intent-analyses`, `document-analyses`, `plan-previews`. capabilities describes service capabilities, not the progress of an analysis. |
| Playground | `/playground/guardrails/{guardrailId}/interactions`, `draft-interactions`, `draft-previews`. |
| Policy catalog | `/policy-catalog/actions`, `/policy-catalog/protection-presets`. |
| Provider discovery/registration | `/model-provider-discoveries` queries a temporary connection; `/model-providers/{id}/model-discoveries` queries an existing one; `/model-provider-registrations` registers a Provider and selected Models together. |
| Connection/capability tests | `/model-providers/{id}/connection-tests` and `/models/{id}/connection-tests` check connectivity; `/models/{id}/capability-tests` checks capabilities and protocols. |
| Model configuration activation | `POST /model-configuration/revisions/{id}/activate` targets a specific revision; rollback requests must provide an explicit targetRevisionId. |

Lifecycle commands retain explicit `/publish`, `/activate`, and `/rollback` POST actions. Resource URLs reflect actual ownership; cross-resource queries need not be forced into nested paths.

## Idempotency, Concurrency, and Asynchronous Operations

Idempotency means repeated requests do not further change the target state; response bytes and status codes need not be identical. Documentation generates `x-idempotency` and `x-retry-policy` for every operation. Do not decide whether blind retries are safe from the HTTP method alone.

| Operation | Boundaries and caller behavior |
| --- | --- |
| GET | Read-only. Model configuration GET neither creates a draft nor advances activation; traffic queries do not clean up expired records. |
| DELETE | Affects only the resource specified in the path; repeats may return 404. Test Case deletion includes the parent ID and cannot delete a same-named case in another Guardrail. |
| Router Endpoint PUT | Deduplicates and sorts Endpoint IDs. An unchanged set neither increments generation nor redistributes configuration. |
| Router draft PUT | expectedDraftRevision is a concurrency precondition. Replaying an old revision after success may return 409. Reread, compare, and review; do not automatically substitute the new revision to force an overwrite. |
| Router publish/rollback | idempotencyKey and expectedDraftRevision are required. The same key and normalized content reuse the original operation; different content returns 409. Snapshot and Endpoint IDs must be submitted together. |
| Router idempotency key details | publish/rollback share a key namespace within each Router. Keys do not expire; deleting a revision retains an audit tombstone that rejects republication. Comparison uses the SHA-256 of actorId, draft revision, rollback target, reviewed snapshot, and normalized Endpoint set. Transaction locks serialize concurrent duplicates. |
| Router replay response | The top-level Router is current state; publication.revision/generation identify the original operation, replayed marks a replay, and revisionUrl retrieves the original revision. A later publication may already have superseded it; replay creates no new distribution. |
| Policy publication | expectedDraftRevision is required. The same Policy and source draft revision reuse the published immutable version. |
| Guardrail publication | expectedDraftRevision is required, and the current draft is checked. The page submits the revision the user is viewing; conflicts require another review. General request-key replay is not guaranteed. Query compilation results using the returned version. |
| Model assignment PUT | An identical binding is a no-op. Changing to a nonempty binding requires a valid validationId; clear with modelId:null. Whole-draft PUT clears validation only when configuration changes. |
| Ordinary POST | Creation, external probes, executable validation, and interactions generally do not guarantee idempotency. After a timeout, query the result first rather than automatically creating a new request. |
| Activation/rollback | Model revision activation may already have been consumed; a repeat may return 409. Rollback specifies a target and creates a new revision, so blind retries are unsafe. |

Router/Guardrail 202 means accepted, not complete at runtime. For Router, read the current resource and compare generation; for Guardrail, check ready/failed using the returned version. Poll Policy validation using the fixed returned runId, avoiding latest being replaced by another job.

Guardrail Version uses the API-returned `YYYYMMDD-HHmmss.SSSZ`; Router revision is numeric; Model configuration revision ID is a UUID. Do not mix these identifiers.

## Validation Credentials for Model Bindings

1. Call `POST /model-configuration/draft/assignments/{target}/candidate-validations` for a candidate Model, providing modelId.
2. The response returns validationId and expiresAt. The record is persisted in the database, works across Controller instances, lasts 10 minutes, and is bound to the account, target, model, and configuration fingerprint.
3. Use `GET .../candidate-validations/{validationId}` to read your own result.
4. When changing a binding, provide both modelId and validationId to `PUT .../assignments/{target}`. Saving is rejected if the credential expired, validation failed, ownership is wrong, or the Model/Provider changed.
5. Revalidate a saved binding using `POST .../assignments/{target}/validations`; validate the whole draft using `POST /model-configuration/draft/validations`. These operations do not accept a candidate modelId.

## Database and Verification

New migration `0012_api_semantics.sql` stores Router request digests/original generations and model-binding validation records. Run it through the repository's existing migration process before running the new code; the old API is not retained. An isolated PostgreSQL environment has been migrated and verified, without modifying business data for regression testing.

Regression coverage includes routing documentation and permissions, accounts and tokens, Guardrail/Policy, Router, model settings pages, and real PostgreSQL tests for composite-resource deletion, publication replay and conflicts, repeated bindings, read-only model views, and cross-instance validation credentials. Original issue evidence remains in `docs/evidence/api-semantics-20260912/` to explain pre-fix behavior.
