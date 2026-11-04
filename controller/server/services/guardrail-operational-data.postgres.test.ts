// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { guardrails } from "../db/schema.js";
import { clearGuardrailOperationalData } from "./guardrail-operational-data.js";
import { runWithProjectContext } from "./project-context.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("shared Guardrail operational history ownership", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => {
    database = await createTestDatabase(url!, "shared_guardrail_history");
  }, 30_000);
  afterAll(async () => { await database?.drop(); });

  it.each(["project", "trusted"] as const)("limits %s cleanup to its authority", async authority => {
    const id = `shared-${authority}`;
    await database.pool.query(`INSERT INTO guardrail (id,project_id,name,draft_config) VALUES ($1,'projectA','Shared Guardrail','{}');`, [id]);
    await database.pool.query(`INSERT INTO resource_share (id,owner_project_id,recipient_project_id,resource_type,resource_id) VALUES ($1,'projectA','projectB','guardrail',$1)`, [id]);
    for (const projectId of ["projectA", "projectB"]) {
      const eventId = `${id}-${projectId}`;
      const endpointId = `endpoint-${eventId}`;
      await database.pool.query("INSERT INTO endpoint (id,project_id,name,adapter) VALUES ($1,$2,'Caller Endpoint','litellm-generic-guardrail')", [endpointId, projectId]);
      await database.pool.query(`INSERT INTO runtime_event (id,project_id,occurred_at,request_id,runner_id,guardrail_id,endpoint_id,direction,decision,duration_ms)
        VALUES ($1,$2,now(),$1,'runner',$3,$4,'incoming','allow',1)`, [eventId, projectId, id, endpointId]);
      await database.pool.query(`INSERT INTO route_assignment (decision_id,project_id,call_id,assignment_status,router_id,router_revision,route_id,target_id,guardrail_id,guardrail_version,endpoint_id,occurred_at)
        VALUES ($1,$2,$1,'assigned','router',1,'route','target',$3,'v1',$4,now())`, [eventId, projectId, id, endpointId]);
      await database.pool.query(`INSERT INTO model_usage_cost (id,project_id,event_id,guardrail_id,model,provider,source,occurred_at,reason)
        VALUES ($1,$2,$1,$3,'model','provider','runtime',now(),'unpriced')`, [eventId, projectId, id]);
    }
    const clear = () => database.db.transaction(async tx => {
      await tx.select().from(guardrails).where(eq(guardrails.id, id)).for("update");
      return clearGuardrailOperationalData(tx, id);
    });
    const cleared = authority === "project"
      ? await runWithProjectContext({ projectId: "projectA", role: "user" }, clear)
      : await clear();
    expect(cleared).toMatchObject({ runtimeEvents: authority === "project" ? 1 : 2, routeAssignments: authority === "project" ? 1 : 2 });
    for (const table of ["runtime_event", "route_assignment", "model_usage_cost"]) {
      const retained = (await database.pool.query(`SELECT project_id FROM ${table} WHERE guardrail_id=$1`, [id])).rows;
      expect(retained).toEqual(authority === "project" ? [{ project_id: "projectB" }] : []);
    }
    // Restoration uses the same helper again; a second reset also retains B's history.
    if (authority === "project") {
      await runWithProjectContext({ projectId: "projectA", role: "user" }, clear);
      for (const table of ["runtime_event", "route_assignment", "model_usage_cost"]) {
        expect((await database.pool.query(`SELECT project_id FROM ${table} WHERE guardrail_id=$1`, [id])).rows).toEqual([{ project_id: "projectB" }]);
      }
    }
  });
});
