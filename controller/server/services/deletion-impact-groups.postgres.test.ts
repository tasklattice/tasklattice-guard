// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { ControlPlaneService } from "./control-plane.js";
import { runWithProjectContext } from "./project-context.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("deletion-impact telemetry across project groups", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: ControlPlaneService;
  beforeAll(async () => {
    database = await createTestDatabase(url!, "deletion_impact_groups");
    service = new ControlPlaneService(database.db, loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!,
      CONTROLLER_RUNNER_TOKEN: "test-runner-token-at-least-thirty-two-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/unused-key",
      BETTER_AUTH_SECRET: "test-auth-secret-at-least-thirty-two-characters" }));
    await database.pool.query(`
      INSERT INTO project_group(id,name) VALUES ('group-c','Group C');
      UPDATE project SET group_id='group-c' WHERE id='projectC';
      INSERT INTO runner_pool(id,name,group_id,project_id) VALUES ('default','Default','default',NULL),('pool-c','Pool C','group-c','projectC');
      INSERT INTO guardrail(id,project_id,name,draft_config,status) VALUES ('guard','projectA','Guard','{}','active');
      INSERT INTO traffic_router(id,project_id,name,draft,active_snapshot,active_revision) VALUES
        ('router-a','projectA','A','{"routes":[]}', '{"routes":[{"targets":[{"guardrailId":"guard"}]}]}',1),
        ('router-c','projectC','C','{"routes":[]}', '{"routes":[{"targets":[{"guardrailId":"guard"}]}]}',1);
      INSERT INTO endpoint(id,project_id,name,adapter,traffic_router_id) VALUES ('endpoint-c','projectC','C','litellm-generic-guardrail','router-c');
      INSERT INTO runner_instance(runner_id,boot_id,pool_id,runner_version,nemo_version,max_concurrency,status) VALUES
        ('runner-a','boot-a','default','test','test',1,'ready'),('runner-c','boot-c','pool-c','test','test',1,'ready');
      INSERT INTO telemetry_watermark(runner_id,last_received_at) VALUES ('runner-a',now()),('runner-c',now() - interval '1 hour');
    `);
  }, 30000);
  afterAll(async () => { await database?.drop(); });

  it("reports Router freshness from its Project pool without trusting unrelated capacity", async () => {
    const distribution = () => service.trafficRouting.distribution("router-c", 24);
    // The unrelated default Runner is fresh; the C Runner is stale.
    await expect(distribution()).resolves.toMatchObject({ telemetryFresh: false, completeness: "delayed_or_unavailable" });
    await database.pool.query("UPDATE telemetry_watermark SET last_received_at=now() WHERE runner_id='runner-c'");
    await expect(distribution()).resolves.toMatchObject({ telemetryFresh: true, completeness: "current" });
    await database.pool.query("UPDATE project SET group_id='group-c' WHERE id='projectB'; INSERT INTO runner_pool(id,name,group_id,project_id) VALUES ('pool-c-2','Pool C 2','group-c','projectB')");
    await expect(distribution()).resolves.toMatchObject({ telemetryFresh: true });
    await database.pool.query(`INSERT INTO runner_instance(runner_id,boot_id,pool_id,runner_version,nemo_version,max_concurrency,status)
      VALUES ('runner-c-2','boot-c-2','pool-c-2','test','test',1,'ready'),
        ('retired-c','boot-retired','pool-c-2','test','test',1,'offline');
      INSERT INTO telemetry_watermark(runner_id,last_received_at) VALUES ('runner-c-2',now());`);
    await expect(distribution()).resolves.toMatchObject({ telemetryFresh: true });
    await database.pool.query("UPDATE telemetry_watermark SET last_received_at=now() - interval '2 minutes' WHERE runner_id='runner-c-2'");
    await expect(distribution()).resolves.toMatchObject({ telemetryFresh: true });
    await database.pool.query("DELETE FROM telemetry_watermark WHERE runner_id='runner-c-2'; DELETE FROM runner_instance WHERE runner_id IN ('runner-c-2','retired-c'); DELETE FROM runner_pool WHERE id='pool-c-2'; UPDATE project SET group_id='default' WHERE id='projectB'; UPDATE telemetry_watermark SET last_received_at=now() - interval '1 hour' WHERE runner_id='runner-c'");
  }, 30000);

  it("does not trust another group's healthy Runner or allow an empty pool to pass", async () => {
    await expect(service.guardrailDeletionImpact("guard")).resolves.toMatchObject({ activeRouterCount: 2, telemetryFresh: false });
    await expect(service.endpointDeletionImpact("endpoint-c")).resolves.toMatchObject({ activeRouterCount: 1, telemetryFresh: false });
    await database.pool.query("UPDATE telemetry_watermark SET last_received_at=now() WHERE runner_id='runner-c'");
    await expect(service.guardrailDeletionImpact("guard")).resolves.toMatchObject({ activeRouterCount: 2, telemetryFresh: true });
    await expect(service.endpointDeletionImpact("endpoint-c")).resolves.toMatchObject({ activeRouterCount: 1, telemetryFresh: true });
    await database.pool.query("UPDATE runner_instance SET status='offline' WHERE runner_id='runner-c'");
    await expect(service.guardrailDeletionImpact("guard")).resolves.toMatchObject({ telemetryFresh: false });
    await expect(service.endpointDeletionImpact("endpoint-c")).resolves.toMatchObject({ telemetryFresh: false });
    await database.pool.query("DELETE FROM telemetry_watermark WHERE runner_id='runner-c'; DELETE FROM runner_instance WHERE runner_id='runner-c'; DELETE FROM runner_pool WHERE id='pool-c'");
    await expect(service.trafficRouting.distribution("router-c", 24)).resolves.toMatchObject({ telemetryFresh: false, dataWatermark: null });
    await expect(service.endpointDeletionImpact("endpoint-c")).resolves.toMatchObject({ telemetryFresh: false });
    await database.pool.query(`INSERT INTO runner_pool(id,name,group_id,project_id) VALUES ('pool-c','Pool C','group-c','projectC');
      INSERT INTO runner_instance(runner_id,boot_id,pool_id,runner_version,nemo_version,max_concurrency,status)
        VALUES ('runner-c','boot-c','pool-c','test','test',1,'ready');
      INSERT INTO telemetry_watermark(runner_id,last_received_at) VALUES ('runner-c',now());`);
  }, 30000);

  it("redacts other projects and unknown events while retaining conservative deletion checks", async () => {
    const asA = <T>(work: () => T) => runWithProjectContext({ projectId: "projectA", role: "user", actorId: "actor-a" }, work);
    await database.pool.query(`UPDATE runner_instance SET status='ready', last_heartbeat_at=now();
      UPDATE telemetry_watermark SET last_received_at=now();
      INSERT INTO endpoint(id,project_id,name,adapter) VALUES ('endpoint-a','projectA','A Endpoint','litellm-generic-guardrail');
      INSERT INTO runtime_event(id,project_id,occurred_at,request_id,runner_id,guardrail_id,endpoint_id,direction,decision,duration_ms)
      VALUES ('event-c','projectC',now()-interval '1 minute','call-c','runner-c','guard','endpoint-a','incoming','allow',1),
        ('event-unknown',null,now(),'call-unknown','runner-c','guard','endpoint-a','incoming','allow',1);`);
    const adminGuard = await service.guardrailDeletionImpact("guard");
    expect(adminGuard).toMatchObject({ incomingRequestCount: 2, activeRouterCount: 2, requiresSecondConfirmation: true, telemetryFresh: true });
    const projectGuard = await asA(() => service.guardrailDeletionImpact("guard"));
    expect(projectGuard).toMatchObject({ incomingRequestCount: 0, lastRequestAt: null, activeRouterCount: 1,
      telemetryWatermark: null, requiresSecondConfirmation: true, telemetryFresh: true });
    await expect(asA(() => service.softDeleteGuardrail({ id: "guard", actorId: "actor-a", reason: "test", confirmRecentTraffic: false })))
      .rejects.toMatchObject({ code: "recent_traffic_confirmation_required", detail: { impact: projectGuard } });
    await expect(asA(() => service.softDeleteGuardrail({ id: "guard", actorId: "actor-a", reason: "test", confirmRecentTraffic: true, confirmationName: "wrong" })))
      .rejects.toMatchObject({ code: "confirmation_name_mismatch", detail: { impact: projectGuard } });
    const projectEndpoint = await asA(() => service.endpointDeletionImpact("endpoint-a"));
    expect(projectEndpoint).toMatchObject({ incomingRequestCount: 0, lastRequestAt: null, activeRouterCount: 0,
      telemetryWatermark: null, requiresSecondConfirmation: true });
    await expect(asA(() => service.softDeleteEndpoint({ id: "endpoint-a", actorId: "actor-a", reason: "test", confirmRecentTraffic: false })))
      .rejects.toMatchObject({ code: "recent_traffic_confirmation_required", detail: { impact: projectEndpoint } });
    await database.pool.query("UPDATE telemetry_watermark SET last_received_at=now()-interval '1 hour' WHERE runner_id='runner-c'");
    const stale = await asA(() => service.guardrailDeletionImpact("guard"));
    expect(stale).toMatchObject({ incomingRequestCount: 0, activeRouterCount: 1, telemetryFresh: false, telemetryWatermark: null });
    await expect(asA(() => service.softDeleteGuardrail({ id: "guard", actorId: "actor-a", reason: "test", confirmRecentTraffic: false })))
      .rejects.toMatchObject({ code: "telemetry_stale", detail: { impact: stale } });
    await database.pool.query(`INSERT INTO runtime_event(id,project_id,occurred_at,request_id,runner_id,guardrail_id,endpoint_id,direction,decision,duration_ms)
      VALUES ('event-a','projectA',now()-interval '2 minutes','call-a','runner-a','guard','endpoint-a','incoming','allow',1)`);
    const visible = await asA(() => service.guardrailDeletionImpact("guard"));
    expect(visible.incomingRequestCount).toBe(1);
    expect(visible.lastRequestAt?.getTime()).toBeLessThan(adminGuard.lastRequestAt!.getTime());
  });

  it("does not trust legacy watermarks or infer safety from no Router when scoped telemetry is enabled", async () => {
    await database.pool.query("UPDATE runner_instance SET status='ready', last_heartbeat_at=now(); UPDATE telemetry_watermark SET last_received_at=now()");
    const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!,
      CONTROLLER_RUNNER_TOKEN: "test-runner-token-at-least-thirty-two-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/unused-key",
      BETTER_AUTH_SECRET: "test-auth-secret-at-least-thirty-two-characters", CONTROLLER_RUNNER_SCOPED_TELEMETRY: "true",
      CONTROLLER_RUNNER_POOL_TOKENS_JSON: JSON.stringify({ default: "pool-default-token-at-least-thirty-two-characters" }) });
    const scoped = new ControlPlaneService(database.db, config);
    await expect(scoped.trafficRouting.distribution("router-c", 24)).resolves.toMatchObject({
      telemetryFresh: false, completeness: "delayed_or_unavailable", dataWatermark: null,
    });
    await expect(scoped.guardrailDeletionImpact("guard")).resolves.toMatchObject({ activeRouterCount: 2, telemetryFresh: false, telemetryWatermark: null });
    await expect(scoped.endpointDeletionImpact("endpoint-a")).resolves.toMatchObject({ activeRouterCount: 0, telemetryFresh: false, telemetryWatermark: null });
    await expect(scoped.softDeleteEndpoint({ id: "endpoint-a", actorId: "actor-a", reason: "test", confirmRecentTraffic: true, confirmationName: "A Endpoint" }))
      .rejects.toMatchObject({ code: "telemetry_stale" });
    expect((await scoped.observabilitySnapshot()).watermarks).toEqual([]);
  });
});
