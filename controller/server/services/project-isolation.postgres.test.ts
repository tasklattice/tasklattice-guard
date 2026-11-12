import { runnerAuthEnv } from "../../test/runner-auth-fixture.js";
import { withTestProject } from "../db/postgres-test-database.js";
// @vitest-environment node
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { securityEventsQuery } from "../../shared/security-events.js";
import { emptyPolicyDefinition } from "../../shared/policy-definition.js";
import { loadConfig } from "../config.js";
import { normalizeGuardrailDraft } from "../domain/guardrail-plan.js";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { ControlPlaneService } from "./control-plane.js";
import { assertResourceReadAccess, assertResourceWriteAccess, runWithProjectContext } from "./project-context.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("project authority across Policy, telemetry and package boundaries", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: ControlPlaneService;
  const asProject = <T>(projectId: string, callback: () => T) => runWithProjectContext({ projectId, actorId: `actor-${projectId}`, role: "user" }, callback);
  beforeAll(async () => {
    database = await createTestDatabase(url!, "project_authority");
    const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!,
      ...runnerAuthEnv("runner-token-that-is-at-least-32-characters"), CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/unused-signing-key.pem",
      CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"), BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" });
    service = new ControlPlaneService(database.db, config);
    await database.pool.query(`INSERT INTO auth_user (id,username,email,role) SELECT id,name,email,role FROM (VALUES ('actor-projectA','A','a@example.test','user','projectA'),('actor-projectB','B','b@example.test','user','projectB'),('actor-projectC','C','c@example.test','user','projectC')) AS fixture(id,name,email,role,project_id);
      INSERT INTO guardrail (id,project_id,name,draft_config) VALUES ('shared-guardrail','projectA','A Guardrail','{}');
      INSERT INTO endpoint (id,project_id,name,adapter) VALUES ('endpoint-b','projectB','B Endpoint','litellm-generic-guardrail');
      `);
  }, 30_000);
  afterAll(async () => { await database?.drop(); });


  it("cannot claim another project's imported Policy ID through an ordinary save", async () => {
    const definition = emptyPolicyDefinition(); definition.metadata.name = "Imported private identity";
    await database.pool.query("INSERT INTO policy_imported_version (policy_id,project_id,version,digest,definition,source_id) VALUES ($1,'projectB','1','synthetic','{}','synthetic')", [definition.metadata.id]);
    await expect(asProject("projectA", () => withTestProject(() => service.policyResources.save({ definition, maintainer: "A", expectedRevision: 0, actorId: "actor-projectA" })))).rejects.toMatchObject({ code: "not_found" });
    expect((await database.pool.query("SELECT id FROM policy_resource WHERE id=$1", [definition.metadata.id])).rows).toEqual([]);
  });

  it("does not authorize read or write for an ambiguously owned Policy ID", async () => {
    const definition = emptyPolicyDefinition();
    definition.metadata.id = "policy-ambiguous-ownership";
    await database.pool.query("INSERT INTO policy_resource (id,project_id,definition,maintainer) VALUES ($1,'projectA',$2,'A')", [definition.metadata.id, definition]);
    await database.pool.query("INSERT INTO policy_imported_version (policy_id,project_id,version,digest,definition,source_id) VALUES ($1,'projectB','v1','digest','{}','test')", [definition.metadata.id]);
    for (const projectId of ["projectA", "projectB", "projectC"]) {
      await expect(asProject(projectId, () => assertResourceReadAccess(database.db, "policy", definition.metadata.id))).rejects.toMatchObject({ code: "not_found" });
      await expect(asProject(projectId, () => assertResourceWriteAccess(database.db, "policy", definition.metadata.id))).rejects.toMatchObject({ code: "not_found" });
    }
    await expect(runWithProjectContext({ projectId: "projectA", role: "admin" }, () => assertResourceReadAccess(database.db, "policy", definition.metadata.id))).resolves.toBeUndefined();
    await expect(runWithProjectContext({ projectId: "projectA", role: "admin" }, () => assertResourceWriteAccess(database.db, "policy", definition.metadata.id))).resolves.toBeUndefined();
  });

  it("scopes security findings and pagination cursors to the invoking project", async () => {
    const findings = JSON.stringify(Array.from({ length: 30 }, (_, id) => ({ id: String(id), verdict: "matched", riskSeverity: "high", ruleId: "synthetic" })));
    await database.pool.query(`INSERT INTO runtime_event (id,project_id,occurred_at,received_at,request_id,runner_id,guardrail_id,direction,decision,duration_ms,metadata)
      VALUES ('private-event-a','projectA',now()-interval '1 minute',now()-interval '1 minute','call-a','runner','shared-guardrail','incoming','block',1,jsonb_build_object('findings',$1::jsonb)),
      ('private-event-b','projectB',now()-interval '1 minute',now()-interval '1 minute','call-b','runner','shared-guardrail','incoming','block',1,jsonb_build_object('findings',$1::jsonb))`, [findings]);
    const query = securityEventsQuery.parse({ guardrailId: "shared-guardrail", limit: 25, window: "24h" });
    const a = await asProject("projectA", () => service.querySecurityEvents(query));
    const b = await asProject("projectB", () => service.querySecurityEvents(query));
    expect(a.items.every(item => item.eventId === "private-event-a")).toBe(true);
    expect(b.items.every(item => item.eventId === "private-event-b")).toBe(true);
    expect(b.items).toHaveLength(25); expect(b.nextCursor).toBeTruthy();
    await expect(asProject("projectB", () => service.querySecurityEvents({ ...query, cursor: a.nextCursor! }))).rejects.toMatchObject({ code: "validation_failed" });
    expect((await asProject("projectC", () => service.querySecurityEvents(query))).items).toEqual([]);
    await expect(asProject("projectB", () => service.getRuntimeEvent("private-event-a"))).rejects.toMatchObject({ code: "not_found" });
  });

  it("attributes shared Guardrail traffic to the caller Endpoint and protects package bytes", async () => {
    await service.recordRuntimeEvents([{ id: "endpoint-b-event", occurredAt: new Date(), requestId: "caller-b", runnerId: "runner", guardrailId: "shared-guardrail", endpointId: "endpoint-b", direction: "incoming", decision: "allow", durationMs: 1, metadata: {} }]);
    expect((await database.pool.query("SELECT project_id FROM runtime_event WHERE id='endpoint-b-event'")).rows).toEqual([{ project_id: "projectB" }]);
    await database.pool.query("INSERT INTO guardrail_package (id,project_id,content,size_bytes,source_id,guardrail_id,manifest,uploaded_by) VALUES ('private-upload','projectA',$1,9,'synthetic','shared-guardrail','{}','actor-projectA')", [Buffer.from("synthetic")]);
    await expect(asProject("projectB", () => service.packages.previewPackage("private-upload"))).rejects.toMatchObject({ code: "not_found" });
    await expect(asProject("projectB", () => service.packages.checkVersionEnvironment("shared-guardrail", "missing"))).rejects.toMatchObject({ code: "not_found" });
    await expect(asProject("projectC", () => service.packages.exportPackage("shared-guardrail", undefined))).rejects.toMatchObject({ code: "not_found" });
  });
});
