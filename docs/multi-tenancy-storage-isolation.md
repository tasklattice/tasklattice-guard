# Multi-tenant storage and isolation

Drawn from the `feat/multi-tenant-v2` implementation at `6044b72` (2026-10-22).

The Controller stores all tenants in **one PostgreSQL database**. Tenant boundaries are row-level ownership and server-side authorization rules; the boxes for tenantA, tenantB, and tenantC below are logical row groups within the same tables, not separate schemas or databases.

```mermaid
flowchart TB
  request["Browser session or personal access token"] --> actor["Controller loads current auth_user<br/>role and tenant_id"]
  actor -- "role = user" --> read["Tenant read rule<br/>own row OR matching resource_share"]
  actor -- "role = user" --> write["Tenant write rule<br/>own row only"]
  actor -- "role = admin" --> admin["Platform management routes<br/>separate role checks"]
  actor -- "both roles" --> operations["Runner management and system status<br/>deployment-wide upstream scope"]

  subgraph database["One PostgreSQL database · shared physical tables"]
    tenants["tenant<br/>tenantA · tenantB · tenantC"]
    users["auth_user<br/>id · role · tenant_id"]
    roots["Resource root tables<br/>policy_record / policy_resource · guardrail<br/>traffic_router · endpoint · model_definition"]
    rowA["Rows owned by tenantA<br/>tenant_id = tenantA"]
    rowB["Rows owned by tenantB<br/>tenant_id = tenantB"]
    rowC["Rows owned by tenantC<br/>tenant_id = tenantC"]
    platformModels["Platform Model rows<br/>model_definition.tenant_id = NULL"]
    children["Child versions, routes, targets, tests, artifacts<br/>parent ID resolves the root owner"]
    grants["resource_share<br/>owner_tenant_id · recipient_tenant_id<br/>resource_type · resource_id"]
    evidence["Runtime and audit evidence<br/>runtime_event · route_assignment<br/>model_usage_cost · audit_event<br/>tenant_id captured at write time"]
    provider["model_provider<br/>platform-managed; no tenant_id"]
  end

  tenants --> users
  users --> actor
  roots --> rowA
  roots --> rowB
  roots --> rowC
  roots --> platformModels
  roots --> children
  read -- "filters lists and direct-ID reads" --> roots
  grants -- "adds one recipient's read access" --> read
  write -- "filters mutations" --> roots
  admin --> provider
  admin --> platformModels
  rowA -. "example: owner A grants B access to one Guardrail" .-> grants
```

For a tenant user, a resource read succeeds when its root `tenant_id` matches the authenticated user's tenant, or when `resource_share` contains a grant matching the **current owner**, recipient tenant, resource type, and resource ID. For example, when tenantA shares a Guardrail with tenantB, the Guardrail remains a tenantA row; the grant lets tenantB read and use it without copying it into tenantB's rows. A grant does not permit edits, publication, deletion, credential access, or onward sharing. Writes require ownership. Child records inherit the boundary through their parent root even when they have no `tenant_id` column of their own.

The root tables group tenant rows by `tenant_id`: Policies, Guardrails, Routers, and Endpoints have a non-null owner; `model_definition.tenant_id` is nullable, with `NULL` denoting a platform Model. `model_provider` has no tenant owner and is managed by the internal platform. Tenant users may select available Provider metadata but cannot manage Providers or view their credentials. Platform administrators use separate role-checked routes; their `auth_user.tenant_id` value does not make them a tenant author.

Runtime events, route assignments, model usage costs, and audit events keep tenant attribution on their own rows so later resource changes do not reassign historical evidence. Queries apply the tenant boundary before returning lists and aggregates where those APIs expose tenant evidence. Runner management and system status retain upstream's deployment-wide scope for both account roles. The [migration](../controller/server/db/migrations/0049_multi_tenant_resources.sql), [schema](../controller/server/db/schema.ts), and [tenant context rules](../controller/server/services/tenant-context.ts) are the source of truth for the exact columns and predicates.
