// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { ControlPlaneService } from "./control-plane.js";
import { TenantGroupService } from "./tenant-groups.js";
import { runWithTenantContext } from "./tenant-context.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Tenant Group persistence and safe allocation in PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: TenantGroupService;
  let control: ControlPlaneService;
  const actor = "group-platform-admin";
  const asAdmin = <T>(callback: () => T) => runWithTenantContext({ role: "admin", tenantId: "tenantA", actorId: actor }, callback);
  const group = (id: string) => asAdmin(() => service.create({ id, name: id }, actor));
  const pool = (groupId: string, id: string) => asAdmin(() => service.createPool(groupId, { id, name: id, runtimeUrl: `http://${id}:8091` }, actor));
  const generation = async () => Number((await database.pool.query("SELECT desired_generation FROM controller_state WHERE id='singleton'")).rows[0].desired_generation);

  beforeAll(async () => {
    database = await createTestDatabase(url!, "tenant_groups"); service = new TenantGroupService(database.db);
    control = new ControlPlaneService(database.db, loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!,
      CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/unused-key",
      BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" }));
    await database.pool.query("INSERT INTO auth_user(id,name,email,role,tenant_id) VALUES ($1,'Group admin','group-admin@example.test','admin','tenantA')", [actor]);
  }, 30000);
  beforeEach(async () => {
    await database.pool.query(`DELETE FROM controller_outbox; DELETE FROM audit_event; DELETE FROM runner_serving_grant; DELETE FROM runner_pool_lease_epoch; DELETE FROM runner_instance;
      DELETE FROM resource_share; DELETE FROM endpoint; DELETE FROM traffic_router;
      DELETE FROM guardrail_version; DELETE FROM guardrail_artifact; DELETE FROM guardrail;
      DELETE FROM runner_pool; UPDATE tenant SET group_id='default'; DELETE FROM tenant_group WHERE id<>'default';
      INSERT INTO controller_state(id,desired_generation) VALUES ('singleton',0) ON CONFLICT(id) DO UPDATE SET desired_generation=0;
      INSERT INTO runner_pool(id,name,is_default) VALUES ('default','GuardRails 0',true);`);
  });
  afterAll(async () => { await database?.drop(); });

  it("backfills legacy tenants and default pools to one protected Default group", async () => {
    const inventory = await asAdmin(() => service.list());
    expect(inventory.items).toEqual([expect.objectContaining({ id: "default", isDefault: true, poolIds: ["default"] })]);
    expect([...inventory.items[0]!.tenantIds].sort()).toEqual(["tenantA", "tenantB", "tenantC"]);
    expect(inventory.tenants.every(tenant => tenant.groupId === "default")).toBe(true);
    expect(inventory.pools[0]).toMatchObject({ id: "default", groupId: "default", runtimeUrl: null, publicUrl: null });
    await expect(asAdmin(() => service.remove("default", actor))).rejects.toMatchObject({ code: "default_tenant_group_protected" });
    await expect(database.pool.query("UPDATE tenant SET group_id=NULL WHERE id='tenantB'")).rejects.toMatchObject({ code: "23502" });
    await expect(database.pool.query("UPDATE tenant SET group_id='missing' WHERE id='tenantB'")).rejects.toMatchObject({ code: "23503" });
  });

  it("creates, renames and deletes only empty non-default groups with audit evidence", async () => {
    await group("team-a");
    await expect(group("team-a")).rejects.toMatchObject({ code: "tenant_group_exists" });
    expect(await asAdmin(() => service.update("team-a", { name: "Renamed" }, actor))).toMatchObject({ id: "team-a", name: "Renamed" });
    await asAdmin(() => service.remove("team-a", actor));
    expect((await asAdmin(() => service.list())).items.map(item => item.id)).toEqual(["default"]);
    expect((await database.pool.query("SELECT kind FROM audit_event ORDER BY occurred_at,id")).rows.map(row => row.kind).sort()).toEqual([
      "tenant_group.created", "tenant_group.deleted", "tenant_group.updated" ].sort());
    expect(await generation()).toBe(0);
  });

  it("atomically assigns membership with expectedGroupId, generation and a durable outbox event", async () => {
    await group("team-a"); await pool("team-a", "pool-a");
    const moved = await asAdmin(() => service.assignTenant("tenantB", { groupId: "team-a", expectedGroupId: "default" }, actor));
    expect(moved).toMatchObject({ id: "tenantB", groupId: "team-a", generation: 2 });
    expect(await generation()).toBe(2);
    expect((await database.pool.query("SELECT group_id FROM tenant WHERE id='tenantB'")).rows).toEqual([{ group_id: "team-a" }]);
    expect((await database.pool.query("SELECT payload FROM controller_outbox WHERE aggregate_id='tenantB'")).rows[0].payload)
      .toMatchObject({ generation: 2, groupId: "team-a", previousGroupId: "default" });
    await expect(asAdmin(() => service.assignTenant("tenantB", { groupId: "default", expectedGroupId: "default" }, actor)))
      .rejects.toMatchObject({ code: "tenant_group_assignment_conflict" });
    await expect(asAdmin(() => service.remove("team-a", actor))).rejects.toMatchObject({ code: "tenant_group_in_use" });
    await asAdmin(() => service.assignTenant("tenantB", { groupId: "team-a", expectedGroupId: "team-a" }, actor));
    expect(await generation()).toBe(2);
  });

  it.each(["ready", "syncing", "draining"])("rejects tenant moves while an old-group Runner is %s", async status => {
    await group("team-a");
    await database.pool.query("INSERT INTO runner_instance(runner_id,boot_id,pool_id,runner_version,nemo_version,max_concurrency,status) VALUES ('old-runner','boot','default','test','test',4,$1)", [status]);
    await expect(asAdmin(() => service.assignTenant("tenantB", { groupId: "team-a", expectedGroupId: "default" }, actor)))
      .rejects.toMatchObject({ code: "tenant_group_runners_active" });
    expect(await generation()).toBe(0);
    expect((await database.pool.query("SELECT group_id FROM tenant WHERE id='tenantB'")).rows[0].group_id).toBe("default");
    await database.pool.query("UPDATE runner_instance SET status='offline'");
    expect(await asAdmin(() => service.assignTenant("tenantB", { groupId: "team-a", expectedGroupId: "default" }, actor)))
      .toMatchObject({ groupId: "team-a", generation: 1 });
  });

  it("requires pool preregistration, protects the default pool and blocks reallocation of connected pools", async () => {
    await group("team-a"); await group("team-b");
    const registered = await pool("team-a", "pool-a");
    expect(registered).toMatchObject({ id: "pool-a", groupId: "team-a", runtimeUrl: "http://pool-a:8091", publicUrl: null, generation: 1 });
    await expect(asAdmin(() => service.assignPool("default", { groupId: "team-a", expectedGroupId: "default" }, actor)))
      .rejects.toMatchObject({ code: "default_runner_pool_protected" });
    await database.pool.query("INSERT INTO runner_instance(runner_id,boot_id,pool_id,runner_version,nemo_version,max_concurrency,status) VALUES ('pool-runner','boot','pool-a','test','test',4,'syncing')");
    await expect(asAdmin(() => service.assignPool("pool-a", { groupId: "team-b", expectedGroupId: "team-a" }, actor)))
      .rejects.toMatchObject({ code: "runner_pool_runners_active" });
    expect(await generation()).toBe(1);
    await database.pool.query("UPDATE runner_instance SET status='offline'");
    expect(await asAdmin(() => service.assignPool("pool-a", { groupId: "team-b", expectedGroupId: "team-a" }, actor)))
      .toMatchObject({ groupId: "team-b", generation: 2 });
  });

  it("prevents a scoped pool from taking over a Runner ID registered to another pool, even when offline", async () => {
    await group("team-a"); await group("team-b"); await pool("team-a", "pool-a"); await pool("team-b", "pool-b");
    const scoped = new ControlPlaneService(database.db, loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!,
      CONTROLLER_RUNNER_TOKEN: "legacy-runner-token-with-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/unused-key",
      BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
      CONTROLLER_RUNNER_POOL_TOKENS_JSON: JSON.stringify({ "pool-a": "pool-a-token-with-at-least-32-characters", "pool-b": "pool-b-token-with-at-least-32-characters" }),
    }));
    const registration = { runnerId: "runner-shared-id", bootId: "boot-a", poolId: "pool-a", runnerVersion: "test", nemoVersion: "test",
      maxConcurrency: 4, compilerCapable: false, labels: {}, appliedGeneration: 0 };
    await scoped.registerRunner(registration);
    await database.pool.query("UPDATE runner_instance SET status='offline' WHERE runner_id='runner-shared-id'");
    await expect(scoped.registerRunner({ ...registration, bootId: "boot-b", poolId: "pool-b" }))
      .rejects.toMatchObject({ code: "runner_pool_identity_conflict" });
    const row = (await database.pool.query("SELECT pool_id, boot_id FROM runner_instance WHERE runner_id='runner-shared-id'")).rows[0];
    expect(row).toEqual({ pool_id: "pool-a", boot_id: "boot-a" });
  });

  it("blocks non-noop reassignment in experimental lease mode even when all Runners appear offline", async () => {
    await group("team-a"); await group("team-b"); await pool("team-a", "pool-a");
    const guarded = new ControlPlaneService(database.db, loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!,
      CONTROLLER_RUNNER_TOKEN: "legacy-runner-token-with-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/unused-key",
      BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
      CONTROLLER_RUNNER_POOL_TOKENS_JSON: JSON.stringify({ "pool-a": "pool-a-token-with-at-least-32-characters" }),
      CONTROLLER_EXPERIMENTAL_RUNNER_LEASE_GRANTS: "true",
    })).tenantGroups;
    await database.pool.query("INSERT INTO runner_instance(runner_id,boot_id,pool_id,runner_version,nemo_version,max_concurrency,status) VALUES ('old-offline','boot','default','test','test',4,'offline')");
    const before = await generation();
    const outboxBefore = (await database.pool.query("SELECT count(*)::int AS count FROM controller_outbox")).rows[0].count;
    await expect(asAdmin(() => guarded.assignTenant("tenantB", { groupId: "team-a", expectedGroupId: "default" }, actor)))
      .rejects.toMatchObject({ code: "runner_lease_reassignment_unavailable" });
    await expect(asAdmin(() => guarded.assignPool("pool-a", { groupId: "team-b", expectedGroupId: "team-a" }, actor)))
      .rejects.toMatchObject({ code: "runner_lease_reassignment_unavailable" });
    expect((await database.pool.query("SELECT group_id FROM tenant WHERE id='tenantB'")).rows[0].group_id).toBe("default");
    expect((await database.pool.query("SELECT group_id FROM runner_pool WHERE id='pool-a'")).rows[0].group_id).toBe("team-a");
    expect(await generation()).toBe(before);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM controller_outbox")).rows[0].count).toBe(outboxBefore);
    await expect(asAdmin(() => guarded.assignTenant("tenantB", { groupId: "default", expectedGroupId: "default" }, actor)))
      .resolves.toMatchObject({ groupId: "default", generation: before });
    await expect(asAdmin(() => guarded.assignPool("pool-a", { groupId: "team-a", expectedGroupId: "team-a" }, actor)))
      .resolves.toMatchObject({ groupId: "team-a", generation: before });
    // Turning the experiment off must not erase authority already issued.
    // Even clock-expired rows are not external evidence that a workload stopped.
    await database.pool.query(`INSERT INTO runner_pool_lease_epoch(pool_id) VALUES ('default'),('pool-a');
      INSERT INTO runner_serving_grant(pool_id,runner_id,boot_id,nonce,epoch,generation,duration_ms,uncertainty_ms,issued_at,conservative_expires_at)
      VALUES ('default','old','boot','nonce-default',0,0,1000,1000,now()-interval '2 hours',now()-interval '1 hour'),
             ('pool-a','old','boot','nonce-pool',0,0,1000,1000,now()-interval '2 hours',now()-interval '1 hour');`);
    await expect(asAdmin(() => service.assignTenant("tenantB", { groupId: "team-a", expectedGroupId: "default" }, actor)))
      .rejects.toMatchObject({ code: "runner_lease_reassignment_unavailable" });
    await expect(asAdmin(() => service.assignPool("pool-a", { groupId: "team-b", expectedGroupId: "team-a" }, actor)))
      .rejects.toMatchObject({ code: "runner_lease_reassignment_unavailable" });
    expect(await generation()).toBe(before);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM runner_serving_grant")).rows[0].count).toBe(2);
  });

  it("keeps connectivity explicit and never silently gives another group the default public URL", async () => {
    await group("team-a"); await pool("team-a", "pool-a");
    const changed = await asAdmin(() => service.updateConnectivity("pool-a", { runtimeUrl: "https://pool-a:8091/", publicUrl: "https://guard.example.test/" }, actor));
    expect(changed).toMatchObject({ runtimeUrl: "https://pool-a:8091", publicUrl: "https://guard.example.test", generation: 2 });
    await expect(asAdmin(() => service.updateConnectivity("pool-a", { runtimeUrl: null, publicUrl: null }, actor))).rejects.toMatchObject({ status: 422 });
    expect(await generation()).toBe(2);
    const legacy = await asAdmin(() => service.updateConnectivity("default", { runtimeUrl: null, publicUrl: null }, actor));
    expect(legacy).toMatchObject({ runtimeUrl: null, publicUrl: null, generation: 2 });
  });

  it("serializes concurrent tenant reassignment and never commits an untested stale allocation", async () => {
    await group("team-a"); await group("team-b");
    const results = await Promise.allSettled(["team-a", "team-b"].map(groupId => asAdmin(() => service.assignTenant("tenantB", { groupId, expectedGroupId: "default" }, actor))));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "tenant_group_assignment_conflict" } });
    expect(await generation()).toBe(1);
  });

  const seedAllocatedRuntime = async () => {
    await group("team-a"); await group("team-b");
    await pool("team-a", "pool-a"); await pool("team-b", "pool-b");
    await asAdmin(() => service.assignTenant("tenantA", { groupId: "team-a", expectedGroupId: "default" }, actor));
    await asAdmin(() => service.assignTenant("tenantB", { groupId: "team-b", expectedGroupId: "default" }, actor));
    // Synthetic immutable artifacts exercise distribution SQL, not signing or
    // runtime admission (which have their own focused suites).
    await database.pool.query(`INSERT INTO guardrail(id,tenant_id,name,draft_config,status,logging_level) VALUES
      ('guard-a','tenantA','A Guardrail','{}','active','debug'), ('guard-b','tenantB','B Guardrail','{}','active','error'),
      ('disabled-a','tenantA','A disabled','{}','disabled','off'), ('disabled-b','tenantB','B disabled','{}','disabled','off');
      INSERT INTO guardrail_artifact(id,guardrail_id,guardrail_version,generation,compiler_version,nemo_version,runtime_profile,plan,config_yaml,checksum,signature) VALUES
      ('artifact-a','guard-a','v1',1,'tasklattice-nemo-config-v1','test','local','{"compiler_version":"tasklattice-controller-plan-v1"}','','checksum-a','synthetic'),
      ('artifact-b','guard-b','v1',2,'tasklattice-nemo-config-v1','test','local','{"compiler_version":"tasklattice-controller-plan-v1"}','','checksum-b','synthetic');
      INSERT INTO guardrail_version(guardrail_id,version,generation,status,runtime_profile,plan,artifact_id,released_at) VALUES
      ('guard-a','v1',1,'ready','local','{}','artifact-a',now()), ('guard-b','v1',2,'ready','local','{}','artifact-b',now());
      UPDATE guardrail_version SET environment_check='{"status":"compatible"}';`);
    const snapshot = (guardrailId: string) => ({ routes: [{ id: "all", name: "All", kind: "fallback", enabled: true,
      selector: { expression: { combinator: "and", conditions: [] } },
      targets: [{ id: "target", guardrailId, guardrailVersion: "v1", weightBps: 10000 }] }] });
    for (const suffix of ["a", "b"]) {
      await database.pool.query(`INSERT INTO traffic_router(id,tenant_id,name,draft,active_snapshot,active_revision)
        VALUES ($1,$2,$1,$3,$3,1)`, [`router-${suffix}`, `tenant${suffix.toUpperCase()}`, snapshot(`guard-${suffix}`)]);
    }
    await database.pool.query(`INSERT INTO traffic_router(id,tenant_id,name,draft) VALUES ('draft-a','tenantA','Unpublished','{"routes":[]}');
      INSERT INTO endpoint(id,tenant_id,name,adapter,traffic_router_id,verification,status) VALUES
      ('endpoint-a','tenantA','A Endpoint','litellm-generic-guardrail','router-a','{"credentialHash":"a-private"}','active'),
      ('endpoint-b','tenantB','B Endpoint','litellm-generic-guardrail','router-b','{"credentialHash":"b-private"}','active'),
      ('foreign-binding-a','tenantA','Invalid owner binding','litellm-generic-guardrail','router-b','{}','active'),
      ('draft-binding-a','tenantA','Unpublished binding','litellm-generic-guardrail','draft-a','{}','active'),
      ('disabled-endpoint-a','tenantA','A disabled','litellm-generic-guardrail',null,'{}','disabled'),
      ('disabled-endpoint-b','tenantB','B disabled','litellm-generic-guardrail',null,'{}','disabled');`);
    return { snapshot };
  };

  it("distributes only allocated owners' credentials, published Routers, artifacts and logging controls", async () => {
    await seedAllocatedRuntime();
    const a = await control.desiredStateForPool("pool-a");
    const b = await control.desiredStateForPool("pool-b");
    expect(a.artifacts.map(item => item.id)).toEqual(["artifact-a"]);
    expect(b.artifacts.map(item => item.id)).toEqual(["artifact-b"]);
    expect(a.routerRevisions.map(item => item.routerId)).toEqual(["router-a"]);
    expect(b.routerRevisions[0]).toMatchObject({ routerId: "router-b", endpointIds: ["endpoint-b"] });
    expect(a.endpoints.map(item => [item.endpointId, item.trafficRouterId]).sort()).toEqual([
      ["draft-binding-a", null], ["endpoint-a", "router-a"], ["foreign-binding-a", null],
    ]);
    expect(b.endpoints).toEqual([expect.objectContaining({ endpointId: "endpoint-b", verification: { credentialHash: "b-private" } })]);
    expect(a.endpoints.every(endpoint => endpoint.tenantId === "tenantA")).toBe(true);
    expect(b.endpoints.every(endpoint => endpoint.tenantId === "tenantB")).toBe(true);
    expect(a.disabledEndpointIds).toEqual(["disabled-endpoint-a"]);
    expect(b.disabledEndpointIds).toEqual(["disabled-endpoint-b"]);
    expect(a.disabledGuardrailIds).toEqual(["disabled-a"]);
    expect(b.disabledGuardrailIds).toEqual(["disabled-b"]);
    expect(a.guardrailLoggingLevels).toEqual({ "guard-a": "debug", "disabled-a": "off" });
    expect(b.guardrailLoggingLevels).toEqual({ "guard-b": "error", "disabled-b": "off" });
    const empty = await control.desiredStateForPool("default");
    expect(empty).toMatchObject({ groupId: "default", artifacts: [], routerRevisions: [], endpoints: [], disabledEndpointIds: [], disabledGuardrailIds: [], guardrailLoggingLevels: {} });
    await expect(control.desiredStateForPool("unregistered")).rejects.toMatchObject({ code: "runner_pool_group_unavailable" });
  });

  it("includes an explicitly shared Guardrail dependency without its owner's Endpoints and fails closed on revocation", async () => {
    const { snapshot } = await seedAllocatedRuntime();
    await database.pool.query(`INSERT INTO resource_share(id,owner_tenant_id,recipient_tenant_id,resource_type,resource_id)
      VALUES ('a-to-b','tenantA','tenantB','guardrail','guard-a')`);
    await database.pool.query("UPDATE traffic_router SET active_snapshot=$1 WHERE id='router-b'", [snapshot("guard-a")]);
    const shared = await control.desiredStateForPool("pool-b");
    expect(shared.artifacts.map(item => item.id).sort()).toEqual(["artifact-a", "artifact-b"]);
    expect(shared.routerRevisions[0]!.routes[0]!.targets[0]).toMatchObject({ guardrailId: "guard-a", artifactId: "artifact-a" });
    expect(shared.endpoints.map(item => item.endpointId)).toEqual(["endpoint-b"]);
    await database.pool.query("DELETE FROM resource_share WHERE id='a-to-b'");
    const revoked = await control.desiredStateForPool("pool-b");
    expect(revoked.artifacts.map(item => item.id)).toEqual(["artifact-b"]);
    expect(revoked.routerRevisions).toEqual([]);
    expect(revoked.endpoints[0]!.trafficRouterId).toBeNull();
  });

  it("removes all moved tenant state from the previous group and publishes it only to the destination group", async () => {
    await seedAllocatedRuntime();
    const before = await control.desiredStateForPool("pool-a");
    await asAdmin(() => service.assignTenant("tenantA", { groupId: "team-b", expectedGroupId: "team-a" }, actor));
    const previous = await control.desiredStateForPool("pool-a");
    const destination = await control.desiredStateForPool("pool-b");
    expect(previous.generation).toBeGreaterThan(before.generation);
    expect(previous).toMatchObject({ artifacts: [], routerRevisions: [], endpoints: [], disabledEndpointIds: [], disabledGuardrailIds: [], guardrailLoggingLevels: {} });
    expect(destination.artifacts.map(item => item.id).sort()).toEqual(["artifact-a", "artifact-b"]);
    expect(destination.routerRevisions.map(item => item.routerId).sort()).toEqual(["router-a", "router-b"]);
    expect(destination.endpoints.map(item => item.endpointId).sort()).toEqual(["draft-binding-a", "endpoint-a", "endpoint-b", "foreign-binding-a"]);
    expect(destination.endpoints.find(item => item.endpointId === "endpoint-a")!.tenantId).toBe("tenantA");
    expect(destination.endpoints.find(item => item.endpointId === "endpoint-b")!.tenantId).toBe("tenantB");
    // Sharing a group does not permit cross-tenant Endpoint-to-Router bindings.
    expect(destination.endpoints.find(item => item.endpointId === "foreign-binding-a")!.trafficRouterId).toBeNull();
  });
});
