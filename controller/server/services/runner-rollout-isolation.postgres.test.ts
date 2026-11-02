// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { TrafficRoutingService } from "./traffic-routing.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("pool-scoped snapshot rejection diagnostics", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: TrafficRoutingService;
  const principal = { poolId: "rollout-ab", bootId: "rollout-boot", controlSessionId: "rollout-session" };
  beforeAll(async () => {
    database = await createTestDatabase(url!, "rollout_isolation");
    service = new TrafficRoutingService(database.db);
    await database.pool.query(`INSERT INTO tenant_group(id,name) VALUES ('rollout-ab','AB'),('rollout-c','C');
      UPDATE tenant SET group_id=CASE WHEN id='tenantC' THEN 'rollout-c' ELSE 'rollout-ab' END;
      INSERT INTO runner_pool(id,name,group_id) VALUES ('rollout-ab','AB','rollout-ab'),('rollout-c','C','rollout-c');
      INSERT INTO runner_control_session(id,runner_id,boot_id,pool_id) VALUES ('rollout-session','rollout-runner','rollout-boot','rollout-ab');
      INSERT INTO runner_instance(runner_id,boot_id,pool_id,status,runner_version,nemo_version,max_concurrency,control_session_id)
        VALUES ('rollout-runner','rollout-boot','rollout-ab','ready','test','test',1,'rollout-session');
      INSERT INTO traffic_router(id,tenant_id,name,draft,active_revision,desired_generation) VALUES
        ('router-a','tenantA','A','{}',1,7),('router-b','tenantB','B','{}',1,7),('router-c','tenantC','C','{}',1,7),
        ('router-future','tenantA','Future','{}',1,9),('router-draft','tenantA','Draft','{}',NULL,7);`);
  }, 30000);
  afterAll(async () => { await database?.drop(); });
  beforeEach(async () => {
    await database.pool.query("UPDATE traffic_router SET rollout_error=NULL; DELETE FROM audit_event; UPDATE runner_instance SET control_session_id='rollout-session',status='ready'; UPDATE runner_control_session SET disconnected_at=NULL");
  });
  const failures = async () => (await database.pool.query("SELECT id FROM traffic_router WHERE rollout_error IS NOT NULL ORDER BY id")).rows.map(row => row.id);
  it("affects A/B's own group only and retains raw private diagnostics exclusively in platform audit", async () => {
    await service.reportRolloutFailure(7, "rollout-runner", "private-policy-a secret-endpoint-a " + "x".repeat(3000), principal);
    expect(await failures()).toEqual(["router-a", "router-b"]);
    const routers = (await database.pool.query("SELECT rollout_error FROM traffic_router")).rows;
    expect(JSON.stringify(routers)).not.toMatch(/private-policy|secret-endpoint/);
    const [audit] = (await database.pool.query("SELECT tenant_id,detail FROM audit_event")).rows;
    expect(audit.tenant_id).toBeNull();
    expect(audit.detail.reason).toHaveLength(2000);
    expect(audit.detail.reason).toContain("private-policy-a");
  });
  it.each([undefined, { ...principal, poolId: "rollout-c" }, { ...principal, bootId: "foreign" },
    { ...principal, controlSessionId: "foreign" }])("ignores absent or inconsistent session authority %j", async identity => {
    await service.reportRolloutFailure(7, "rollout-runner", "private", identity);
    expect(await failures()).toEqual([]);
    expect((await database.pool.query("SELECT * FROM audit_event")).rows).toEqual([]);
  });
  it("ignores disconnected or offline sources", async () => {
    await database.pool.query("UPDATE runner_control_session SET disconnected_at=now()");
    await service.reportRolloutFailure(7, "rollout-runner", "private", principal);
    expect(await failures()).toEqual([]);
    await database.pool.query("UPDATE runner_control_session SET disconnected_at=NULL; UPDATE runner_instance SET status='offline'");
    await service.reportRolloutFailure(7, "rollout-runner", "private", principal);
    expect(await failures()).toEqual([]);
  });
});
