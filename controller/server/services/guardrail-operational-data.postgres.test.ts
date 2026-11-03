// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { guardrails } from "../db/schema.js";
import { clearGuardrailOperationalData } from "./guardrail-operational-data.js";
import { runWithTenantContext } from "./tenant-context.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("shared Guardrail operational history ownership", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => {
    database = await createTestDatabase(url!, "shared_guardrail_history");
  }, 30_000);
  afterAll(async () => { await database?.drop(); });

  it.each(["tenant", "trusted"] as const)("limits %s cleanup to its authority", async authority => {
    const id = `shared-${authority}`;
    await database.pool.query(`INSERT INTO guardrail (id,tenant_id,name,draft_config) VALUES ($1,'tenantA','Shared Guardrail','{}');`, [id]);
    await database.pool.query(`INSERT INTO resource_share (id,owner_tenant_id,recipient_tenant_id,resource_type,resource_id) VALUES ($1,'tenantA','tenantB','guardrail',$1)`, [id]);
    for (const tenantId of ["tenantA", "tenantB"]) {
      const eventId = `${id}-${tenantId}`;
      const endpointId = `endpoint-${eventId}`;
      await database.pool.query("INSERT INTO endpoint (id,tenant_id,name,adapter) VALUES ($1,$2,'Caller Endpoint','litellm-generic-guardrail')", [endpointId, tenantId]);
      await database.pool.query(`INSERT INTO runtime_event (id,tenant_id,occurred_at,request_id,runner_id,guardrail_id,endpoint_id,direction,decision,duration_ms)
        VALUES ($1,$2,now(),$1,'runner',$3,$4,'incoming','allow',1)`, [eventId, tenantId, id, endpointId]);
      await database.pool.query(`INSERT INTO route_assignment (decision_id,tenant_id,call_id,assignment_status,router_id,router_revision,route_id,target_id,guardrail_id,guardrail_version,endpoint_id,occurred_at)
        VALUES ($1,$2,$1,'assigned','router',1,'route','target',$3,'v1',$4,now())`, [eventId, tenantId, id, endpointId]);
      await database.pool.query(`INSERT INTO model_usage_cost (id,tenant_id,event_id,guardrail_id,model,provider,source,occurred_at,reason)
        VALUES ($1,$2,$1,$3,'model','provider','runtime',now(),'unpriced')`, [eventId, tenantId, id]);
    }
    const clear = () => database.db.transaction(async tx => {
      await tx.select().from(guardrails).where(eq(guardrails.id, id)).for("update");
      return clearGuardrailOperationalData(tx, id);
    });
    const cleared = authority === "tenant"
      ? await runWithTenantContext({ tenantId: "tenantA", role: "user" }, clear)
      : await clear();
    expect(cleared).toMatchObject({ runtimeEvents: authority === "tenant" ? 1 : 2, routeAssignments: authority === "tenant" ? 1 : 2 });
    for (const table of ["runtime_event", "route_assignment", "model_usage_cost"]) {
      const retained = (await database.pool.query(`SELECT tenant_id FROM ${table} WHERE guardrail_id=$1`, [id])).rows;
      expect(retained).toEqual(authority === "tenant" ? [{ tenant_id: "tenantB" }] : []);
    }
    // Restoration uses the same helper again; a second reset also retains B's history.
    if (authority === "tenant") {
      await runWithTenantContext({ tenantId: "tenantA", role: "user" }, clear);
      for (const table of ["runtime_event", "route_assignment", "model_usage_cost"]) {
        expect((await database.pool.query(`SELECT tenant_id FROM ${table} WHERE guardrail_id=$1`, [id])).rows).toEqual([{ tenant_id: "tenantB" }]);
      }
    }
  });
});
