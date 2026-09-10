# Integration: Traffic Routers and Endpoints

Integration is the navigation group. Its two resources are:

- **Endpoint**: an authenticated application, agent, or gateway connection, with an adapter and credentials.
- **Traffic Router** (`Router` in code): an ordered Traffic Scope binding from one Endpoint to an immutable Guardrail Version. The system fallback Router has no Endpoint binding.

## Current contracts

| Layer | Traffic Router | Endpoint |
| --- | --- | --- |
| UI | `/integration/routers`, `/integration/routers/$routerId` | `/integration/endpoint` |
| Management API | `/api/v1/routers`, `/api/v1/router-bindings` | `/api/v1/endpoints` |
| Database | `guardrail_router`, `router_id` | `endpoint`, `endpoint_id` |
| Controller DTO | `Router`, `routerId` | `Endpoint`, `endpointId` |
| Desired state | `routers`, `RouterRoute` | `endpoints`, `EndpointRuntime` |
| Metrics | `router_id` | `endpoint_id` |

Runner clients use `/runtime/v1/endpoints/{endpoint_id}/...`, including `verify`, `beta/litellm_basic_guardrail_api`, `guardrails/evaluate`, and `guardrails/output-stream`. Endpoint setup generates these URLs. Registered traffic identity is `endpoint.id`.

## Applying the rename

Migration `0008_router_endpoint.sql` renames existing tables, columns, indexes, and constraints. It preserves Endpoint IDs, credentials, custom Router IDs, route order, and bindings. The system fallback becomes `router-default`; its runtime-event references are updated. Stored Traffic Scope field selectors are renamed recursively, without changing literal condition values.

This is a breaking contract change with no legacy API aliases. Update Controller, Runner, runtime clients, Prometheus rules, and Grafana dashboards together. Refresh the base URL configured in gateway adapters from Endpoint setup. In-flight stream and call-context state should be drained before switching versions because persisted runtime JSON uses the new field names.

Historical SQL migrations, recorded acceptance reports, and captured model responses preserve their original evidence. Kubernetes Deployment resources and installation/deployment terminology are unrelated to the product Router entity.
