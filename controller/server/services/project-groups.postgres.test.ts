// @vitest-environment node
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { ControlPlaneService } from "./control-plane.js";
import { ProjectGroupService } from "./project-groups.js";
import { runWithProjectContext } from "./project-context.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Project Group persistence and safe allocation in PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: ProjectGroupService;
  let control: ControlPlaneService;
  let keyDirectory: string;
  const actor = "group-platform-admin";
  const asAdmin = <T>(callback: () => T) => runWithProjectContext({ role: "admin", projectId: "projectA", actorId: actor }, callback);
  const group = (id: string) => asAdmin(() => service.create({ id, name: id }, actor));
  const pool = async (groupId: string, id: string) => {
    await database.pool.query("INSERT INTO project(id,name,group_id) VALUES ($1,$2,$3) ON CONFLICT(id) DO UPDATE SET group_id=excluded.group_id", [`pool-project-${id}`,id,groupId]);
    return asAdmin(() => service.createPool(groupId, {projectId:`pool-project-${id}`,runtimeUrl:`http://${id}:8091`},actor));
  };
  const generation = async () => Number((await database.pool.query("SELECT desired_generation FROM controller_state WHERE id='singleton'")).rows[0].desired_generation);

  beforeAll(async () => {
    keyDirectory = mkdtempSync(join(tmpdir(), "guard-pool-bootstrap-"));
    const signingKey = join(keyDirectory, "signing.pem");
    writeFileSync(signingKey, generateKeyPairSync("ed25519").privateKey.export({type:"pkcs8",format:"pem"}), {mode:0o600});
    database = await createTestDatabase(url!, "project_groups"); service = new ProjectGroupService(database.db);
    control = new ControlPlaneService(database.db, loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!,
      CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: signingKey,
      BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" }));
    await database.pool.query("INSERT INTO auth_user (id,username,email,role) SELECT id,name,email,role FROM (VALUES ($1,'Group admin','group-admin@example.test','admin','projectA')) AS fixture(id,name,email,role,project_id)", [actor]);
  }, 30000);
  beforeEach(async () => {
    await database.pool.query(`
      DELETE FROM controller_outbox; DELETE FROM audit_event; DELETE FROM runner_serving_grant; DELETE FROM runner_pool_lease_epoch; DELETE FROM runner_instance;
      DELETE FROM resource_share; DELETE FROM endpoint; DELETE FROM traffic_router;
      DELETE FROM deployment_preset; DELETE FROM guardrail_version; DELETE FROM guardrail_artifact; DELETE FROM guardrail;
      DELETE FROM runner_pool; DELETE FROM project WHERE id LIKE 'pool-project-%'; UPDATE project SET group_id='default'; DELETE FROM project_group WHERE id<>'default';
      INSERT INTO controller_state(id,desired_generation) VALUES ('singleton',0) ON CONFLICT(id) DO UPDATE SET desired_generation=0;
      INSERT INTO runner_pool(id,name,is_default) VALUES ('default','runner-default',true);`);
  });
  afterAll(async () => { try { await database?.drop(); } finally { if (keyDirectory) rmSync(keyDirectory, {recursive:true,force:true}); } });

  it("reads one Project allocation with counts without hydrating other Projects or instances", async () => {
    const detail = await asAdmin(() => service.projectRunner("projectB"));
    expect(detail).toMatchObject({projectId:"projectB",pool:{id:"default",connectedCount:0},modelScope:{projectCount:3,poolCount:1}});
    expect(detail).not.toHaveProperty("instances");
    await expect(asAdmin(() => service.projectRunner("missing"))).rejects.toMatchObject({status:404});
  });

  it("atomically registers a canonical dedicated Runner with a separate, ungranted model scope", async () => {
    const result = await asAdmin(() => service.configureProjectRunner("projectB",{
      mode:"dedicated",expectedGroupId:"default",expectedPoolId:"default",runtimeUrl:"http://runner-test-project-b:8091",publicUrl:null,
    },actor));
    expect(result).toMatchObject({projectId:"projectB",pool:{id:"test-project-b",name:"runner-test-project-b",desiredReplicas:1},modelScope:{projectCount:1,poolCount:1}});
    expect(result.groupId).not.toBe("default");
    expect((await asAdmin(() => service.projectRunner("projectA"))).pool?.id).toBe("default");
    expect((await database.pool.query("SELECT * FROM project_group_model_configuration WHERE group_id=$1",[result.groupId])).rows).toEqual([]);
    expect(await generation()).toBe(1);
    expect((await database.pool.query("SELECT kind FROM audit_event")).rows).toEqual([{kind:"project.runner_configured"}]);
    await expect(asAdmin(() => service.configureProjectRunner("projectB",{
      mode:"shared",expectedGroupId:"default",expectedPoolId:"default",
    },actor))).rejects.toMatchObject({code:"project_group_assignment_conflict"});
  });

  it("keeps an exclusive model scope when completing an unallocated Project", async () => {
    await group("exclusive");
    await database.pool.query("UPDATE project SET group_id='exclusive' WHERE id='projectB'");
    const result = await asAdmin(() => service.configureProjectRunner("projectB",{
      mode:"dedicated",expectedGroupId:"exclusive",expectedPoolId:null,runtimeUrl:"http://runner-test-project-b:8091",publicUrl:null,
    },actor));
    expect(result.groupId).toBe("exclusive");
    expect(result.modelScope).toEqual({projectCount:1,poolCount:1});
    await expect(asAdmin(() => service.configureProjectRunner("projectB",{
      mode:"shared",expectedGroupId:"exclusive",expectedPoolId:"test-project-b",
    },actor))).rejects.toMatchObject({code:"runner_pool_exists"});
  });

  it("assigns an unallocated Project to default without changing other Projects", async () => {
    await group("empty");
    await database.pool.query("UPDATE project SET group_id='empty' WHERE id='projectB'");
    const result = await asAdmin(() => service.configureProjectRunner("projectB",{
      mode:"shared",expectedGroupId:"empty",expectedPoolId:null,
    },actor));
    expect(result).toMatchObject({groupId:"default",pool:{id:"default"}});
    expect(result.modelScope.projectCount).toBe(3);
  });

  it("rolls back the allocation and new model scope when pool registration conflicts", async () => {
    await database.pool.query("INSERT INTO runner_pool(id,name,project_id,group_id) VALUES ('test-project-b','runner-test-project-b','projectC','default')");
    const count = (await database.pool.query("SELECT count(*)::int AS n FROM project_group")).rows[0].n;
    await expect(asAdmin(() => service.configureProjectRunner("projectB",{
      mode:"dedicated",expectedGroupId:"default",expectedPoolId:"default",runtimeUrl:"http://runner-test-project-b:8091",publicUrl:null,
    },actor))).rejects.toMatchObject({code:"runner_pool_exists"});
    expect((await database.pool.query("SELECT count(*)::int AS n FROM project_group")).rows[0].n).toBe(count);
    expect((await asAdmin(() => service.projectRunner("projectB"))).pool?.id).toBe("default");
    expect(await generation()).toBe(0);
  });

  it("rejects dedicated registration while source Runners are online, before making changes", async () => {
    await database.pool.query("INSERT INTO runner_instance(runner_id,boot_id,pool_id,runner_version,nemo_version,max_concurrency,status) VALUES ('runner-default-0','boot','default','test','test',4,'ready')");
    await expect(asAdmin(() => service.configureProjectRunner("projectB",{
      mode:"dedicated",expectedGroupId:"default",expectedPoolId:"default",runtimeUrl:"http://runner-test-project-b:8091",publicUrl:null,
    },actor))).rejects.toMatchObject({code:"project_group_runners_active"});
    expect(await generation()).toBe(0);
    expect((await asAdmin(() => service.projectRunner("projectB"))).pool?.id).toBe("default");
  });

  it("bootstraps runner-default without overwriting an administrator's custom pool name", async () => {
    const fresh = await createTestDatabase(url!, "pool_bootstrap");
    try {
      const bootstrap = new ControlPlaneService(fresh.db, loadConfig({NODE_ENV:"test",CONTROLLER_DATABASE_URL:url!,
        CONTROLLER_RUNNER_TOKEN:"test-bootstrap-runner-token-at-least-32",BETTER_AUTH_SECRET:"test-bootstrap-auth-secret-at-least-32",
        CONTROLLER_ARTIFACT_SIGNING_KEY_PATH:join(keyDirectory,"signing.pem")}));
      await bootstrap.initialize();
      expect((await fresh.pool.query("SELECT id,name,is_default FROM runner_pool WHERE id='default'")).rows)
        .toEqual([{id:"default",name:"runner-default",is_default:true}]);
      await fresh.pool.query("UPDATE runner_pool SET name='Custom primary pool' WHERE id='default'");
      await bootstrap.initialize();
      expect((await fresh.pool.query("SELECT name FROM runner_pool WHERE id='default'")).rows).toEqual([{name:"Custom primary pool"}]);
    } finally { await fresh.drop(); }
  });


  it("lists protected default group summaries and validates Project group ownership", async () => {
    const inventory = await asAdmin(() => service.list({q:"",limit:25}));
    expect(inventory.items).toEqual([expect.objectContaining({id:"default",isDefault:true,poolCount:1,projectCount:3})]);
    expect(inventory).not.toHaveProperty("projects");
    await expect(asAdmin(() => service.remove("default", actor))).rejects.toMatchObject({ code: "default_project_group_protected" });
    await expect(database.pool.query("UPDATE project SET group_id=NULL WHERE id='projectB'")).rejects.toMatchObject({ code: "23502" });
    await expect(database.pool.query("UPDATE project SET group_id='missing' WHERE id='projectB'")).rejects.toMatchObject({ code: "23503" });
  });

  it("creates, renames and deletes only empty non-default groups with audit evidence", async () => {
    await group("team-a");
    await expect(group("team-a")).rejects.toMatchObject({ code: "project_group_exists" });
    expect(await asAdmin(() => service.update("team-a", { name: "Renamed" }, actor))).toMatchObject({ id: "team-a", name: "Renamed" });
    await asAdmin(() => service.remove("team-a", actor));
    expect((await asAdmin(() => service.list({q:"",limit:25}))).items.map(item => item.id)).toEqual(["default"]);
    expect((await database.pool.query("SELECT kind FROM audit_event ORDER BY occurred_at,id")).rows.map(row => row.kind).sort()).toEqual([
      "project_group.created", "project_group.deleted", "project_group.updated" ].sort());
    expect(await generation()).toBe(0);
  });

  it("atomically assigns membership with expectedGroupId, generation and a durable outbox event", async () => {
    await group("team-a"); await pool("team-a", "pool-a");
    const moved = await asAdmin(() => service.assignProject("projectB", { groupId: "team-a", expectedGroupId: "default" }, actor));
    expect(moved).toMatchObject({ id: "projectB", groupId: "team-a", generation: 2 });
    expect(await generation()).toBe(2);
    expect((await database.pool.query("SELECT group_id FROM project WHERE id='projectB'")).rows).toEqual([{ group_id: "team-a" }]);
    expect((await database.pool.query("SELECT payload FROM controller_outbox WHERE aggregate_id='projectB'")).rows[0].payload)
      .toMatchObject({ generation: 2, groupId: "team-a", previousGroupId: "default" });
    await expect(asAdmin(() => service.assignProject("projectB", { groupId: "default", expectedGroupId: "default" }, actor)))
      .rejects.toMatchObject({ code: "project_group_assignment_conflict" });
    await expect(asAdmin(() => service.remove("team-a", actor))).rejects.toMatchObject({ code: "project_group_in_use" });
    await asAdmin(() => service.assignProject("projectB", { groupId: "team-a", expectedGroupId: "team-a" }, actor));
    expect(await generation()).toBe(2);
  });

  it.each(["ready", "syncing", "draining"])("rejects project moves while an old-group Runner is %s", async status => {
    await group("team-a");
    await database.pool.query("INSERT INTO runner_instance(runner_id,boot_id,pool_id,runner_version,nemo_version,max_concurrency,status) VALUES ('old-runner','boot','default','test','test',4,$1)", [status]);
    await expect(asAdmin(() => service.assignProject("projectB", { groupId: "team-a", expectedGroupId: "default" }, actor)))
      .rejects.toMatchObject({ code: "project_group_runners_active" });
    expect(await generation()).toBe(0);
    expect((await database.pool.query("SELECT group_id FROM project WHERE id='projectB'")).rows[0].group_id).toBe("default");
    await database.pool.query("UPDATE runner_instance SET status='offline'");
    expect(await asAdmin(() => service.assignProject("projectB", { groupId: "team-a", expectedGroupId: "default" }, actor)))
      .toMatchObject({ groupId: "team-a", generation: 1 });
  });

  it("requires pool preregistration, protects the default pool and blocks reallocation of connected pools", async () => {
    await group("team-a"); await group("team-b");
    const registered = await pool("team-a", "pool-a");
    expect(registered).toMatchObject({ id: "pool-a", groupId: "team-a", runtimeUrl: "http://pool-a:8091", publicUrl: null, generation: 1 });
    await database.pool.query("INSERT INTO runner_instance(runner_id,boot_id,pool_id,runner_version,nemo_version,max_concurrency,status) VALUES ('pool-runner','boot','pool-a','test','test',4,'syncing')");
    expect(await generation()).toBe(1);
    await database.pool.query("UPDATE runner_instance SET status='offline'");
    expect(await asAdmin(() => service.assignProject("pool-project-pool-a", { groupId: "team-b", expectedGroupId: "team-a" }, actor)))
      .toMatchObject({ groupId: "team-b", generation: 2 });
  });

  it("prevents a scoped pool from taking over a Runner ID registered to another pool, even when offline", async () => {
    await group("team-a"); await group("team-b"); await pool("team-a", "pool-a"); await pool("team-b", "pool-b");
    const scoped = new ControlPlaneService(database.db, loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!,
      CONTROLLER_RUNNER_TOKEN: "legacy-runner-token-with-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/unused-key",
      BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
      CONTROLLER_RUNNER_POOL_TOKENS_JSON: JSON.stringify({ "pool-a": "pool-a-token-with-at-least-32-characters", "pool-b": "pool-b-token-with-at-least-32-characters" }),
    }));
    const registration = { runnerId: "runner-pool-a-0", bootId: "boot-a", poolId: "pool-a", runnerVersion: "test", nemoVersion: "test",
      maxConcurrency: 4, compilerCapable: false, labels: {}, appliedGeneration: 0 };
    await scoped.registerRunner(registration);
    await database.pool.query("UPDATE runner_instance SET status='offline' WHERE runner_id='runner-pool-a-0'");
    await expect(scoped.registerRunner({ ...registration, bootId: "boot-b", poolId: "pool-b" }))
      .rejects.toMatchObject({ code: "runner_pool_identity_conflict" });
    const row = (await database.pool.query("SELECT pool_id, boot_id FROM runner_instance WHERE runner_id='runner-pool-a-0'")).rows[0];
    expect(row).toEqual({ pool_id: "pool-a", boot_id: "boot-a" });
  });

  it("blocks non-noop reassignment in experimental lease mode even when all Runners appear offline", async () => {
    await group("team-a"); await group("team-b"); await pool("team-a", "pool-a");
    const guarded = new ControlPlaneService(database.db, loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!,
      CONTROLLER_RUNNER_TOKEN: "legacy-runner-token-with-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/unused-key",
      BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
      CONTROLLER_RUNNER_POOL_TOKENS_JSON: JSON.stringify({ "pool-a": "pool-a-token-with-at-least-32-characters" }),
      CONTROLLER_EXPERIMENTAL_RUNNER_LEASE_GRANTS: "true",
    })).projectGroups;
    await database.pool.query("INSERT INTO runner_instance(runner_id,boot_id,pool_id,runner_version,nemo_version,max_concurrency,status) VALUES ('old-offline','boot','default','test','test',4,'offline')");
    const before = await generation();
    const outboxBefore = (await database.pool.query("SELECT count(*)::int AS count FROM controller_outbox")).rows[0].count;
    await expect(asAdmin(() => guarded.assignProject("projectB", { groupId: "team-a", expectedGroupId: "default" }, actor)))
      .rejects.toMatchObject({ code: "runner_lease_reassignment_unavailable" });
    expect((await database.pool.query("SELECT group_id FROM project WHERE id='projectB'")).rows[0].group_id).toBe("default");
    expect((await database.pool.query("SELECT group_id FROM runner_pool WHERE id='pool-a'")).rows[0].group_id).toBe("team-a");
    expect(await generation()).toBe(before);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM controller_outbox")).rows[0].count).toBe(outboxBefore);
    await expect(asAdmin(() => guarded.assignProject("projectB", { groupId: "default", expectedGroupId: "default" }, actor)))
      .resolves.toMatchObject({ groupId: "default", generation: before });
    // Turning the experiment off must not erase authority already issued.
    // Even clock-expired rows are not external evidence that a workload stopped.
    await database.pool.query(`INSERT INTO runner_pool_lease_epoch(pool_id) VALUES ('default'),('pool-a');
      INSERT INTO runner_serving_grant(pool_id,runner_id,boot_id,nonce,epoch,generation,duration_ms,uncertainty_ms,issued_at,conservative_expires_at)
      VALUES ('default','old','boot','nonce-default',0,0,1000,1000,now()-interval '2 hours',now()-interval '1 hour'),
             ('pool-a','old','boot','nonce-pool',0,0,1000,1000,now()-interval '2 hours',now()-interval '1 hour');`);
    await expect(asAdmin(() => service.assignProject("projectB", { groupId: "team-a", expectedGroupId: "default" }, actor)))
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

  it("serializes concurrent project reassignment and never commits an untested stale allocation", async () => {
    await group("team-a"); await group("team-b");
    const results = await Promise.allSettled(["team-a", "team-b"].map(groupId => asAdmin(() => service.assignProject("projectB", { groupId, expectedGroupId: "default" }, actor))));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "project_group_assignment_conflict" } });
    expect(await generation()).toBe(1);
  });

  const seedAllocatedRuntime = async () => {
    await group("team-a"); await group("team-b");
    await pool("team-a", "pool-a"); await pool("team-b", "pool-b");
    await asAdmin(() => service.assignProject("projectA", { groupId: "team-a", expectedGroupId: "default" }, actor));
    await asAdmin(() => service.assignProject("projectB", { groupId: "team-b", expectedGroupId: "default" }, actor));
    await database.pool.query("UPDATE runner_pool SET project_id='projectA',name='runner-test-project-a' WHERE id='pool-a'; UPDATE runner_pool SET project_id='projectB',name='runner-test-project-b' WHERE id='pool-b'");
    // Synthetic immutable artifacts exercise distribution SQL, not signing or
    // runtime admission (which have their own focused suites).
    await database.pool.query(`INSERT INTO guardrail(id,project_id,name,draft_config,status,logging_level) VALUES
      ('guard-a','projectA','A Guardrail','{}','active','debug'), ('guard-b','projectB','B Guardrail','{}','active','error'),
      ('disabled-a','projectA','A disabled','{}','disabled','off'), ('disabled-b','projectB','B disabled','{}','disabled','off');
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
      await database.pool.query(`INSERT INTO traffic_router(id,project_id,name,draft,active_snapshot,active_revision)
        VALUES ($1,$2,$1,$3,$3,1)`, [`router-${suffix}`, `project${suffix.toUpperCase()}`, snapshot(`guard-${suffix}`)]);
    }
    await database.pool.query(`INSERT INTO traffic_router(id,project_id,name,draft) VALUES ('draft-a','projectA','Unpublished','{"routes":[]}');
      INSERT INTO endpoint(id,project_id,name,adapter,traffic_router_id,verification,status) VALUES
      ('endpoint-a','projectA','A Endpoint','litellm-generic-guardrail','router-a','{"credentialHash":"a-private"}','active'),
      ('endpoint-b','projectB','B Endpoint','litellm-generic-guardrail','router-b','{"credentialHash":"b-private"}','active'),
      ('foreign-binding-a','projectA','Invalid owner binding','litellm-generic-guardrail','router-b','{}','active'),
      ('draft-binding-a','projectA','Unpublished binding','litellm-generic-guardrail','draft-a','{}','active'),
      ('disabled-endpoint-a','projectA','A disabled','litellm-generic-guardrail',null,'{}','disabled'),
      ('disabled-endpoint-b','projectB','B disabled','litellm-generic-guardrail',null,'{}','disabled');`);
    return { snapshot };
  };

  it("reports monitoring topology for allocated pools without default or cross-project bindings", async () => {
    await seedAllocatedRuntime();
    await pool("team-a", "pool-a-secondary");
    const snapshot = await control.observabilitySnapshot();
    expect(snapshot.routers.map(item => [item.routerId,item.poolId]).sort()).toEqual([
      ["router-a","pool-a"], ["router-b","pool-b"],
    ]);
    expect(snapshot.endpointBindings.map(item => [item.endpointId,item.poolId]).sort()).toEqual([
      ["endpoint-a","pool-a"], ["endpoint-b","pool-b"],
    ]);
  });

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
    expect(a.endpoints.every(endpoint => endpoint.projectId === "projectA")).toBe(true);
    expect(b.endpoints.every(endpoint => endpoint.projectId === "projectB")).toBe(true);
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

  it("moves a dedicated pool with its Project without combining another Project's state", async () => {
    await seedAllocatedRuntime();
    await asAdmin(() => service.assignProject("projectA", { groupId: "team-b", expectedGroupId: "team-a" }, actor));
    const own = await control.desiredStateForPool("pool-a");
    const other = await control.desiredStateForPool("pool-b");
    expect(own.routerRevisions.map(item => item.routerId)).toEqual(["router-a"]);
    expect(other.routerRevisions.map(item => item.routerId)).toEqual(["router-b"]);
    expect(own.endpoints.every(item => item.projectId === "projectA")).toBe(true);
    expect(other.endpoints.every(item => item.projectId === "projectB")).toBe(true);
    expect((await database.pool.query("SELECT group_id,project_id FROM runner_pool WHERE id='pool-a'")).rows[0])
      .toEqual({group_id:"team-b",project_id:"projectA"});
  });
});
