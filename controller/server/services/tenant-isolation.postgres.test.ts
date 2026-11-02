// @vitest-environment node
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { securityEventsQuery } from "../../shared/security-events.js";
import { emptyPolicyDefinition } from "../../shared/policy-definition.js";
import { loadConfig } from "../config.js";
import { normalizeGuardrailDraft } from "../domain/guardrail-plan.js";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { ControlPlaneService } from "./control-plane.js";
import { assertResourceReadAccess, assertResourceWriteAccess, runWithTenantContext } from "./tenant-context.js";
import { TenantShareService } from "./tenant-shares.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("tenant authority across Policy, telemetry and package boundaries", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: ControlPlaneService;
  let shares: TenantShareService;
  const asTenant = <T>(tenantId: string, callback: () => T) => runWithTenantContext({ tenantId, actorId: `actor-${tenantId}`, role: "user" }, callback);
  beforeAll(async () => {
    database = await createTestDatabase(url!, "tenant_authority");
    const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!,
      CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/unused-signing-key.pem",
      CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"), BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" });
    service = new ControlPlaneService(database.db, config);
    shares = new TenantShareService(database.db);
    await database.pool.query(`INSERT INTO auth_user (id,name,email,role,tenant_id) VALUES
      ('actor-tenantA','A','a@example.test','user','tenantA'), ('actor-tenantB','B','b@example.test','user','tenantB'), ('actor-tenantC','C','c@example.test','user','tenantC');
      INSERT INTO guardrail (id,tenant_id,name,draft_config) VALUES ('shared-guardrail','tenantA','A Guardrail','{}');
      INSERT INTO endpoint (id,tenant_id,name,adapter) VALUES ('endpoint-b','tenantB','B Endpoint','litellm-generic-guardrail');
      INSERT INTO resource_share (id,owner_tenant_id,recipient_tenant_id,resource_type,resource_id) VALUES ('guardrail-share','tenantA','tenantB','guardrail','shared-guardrail');`);
  }, 30_000);
  afterAll(async () => { await database?.drop(); });

  it("keeps declarative Policy shares read-only and immediately revocable", async () => {
    const definition = emptyPolicyDefinition();
    definition.metadata.name = "Private A Policy";
    definition.rules = [{ id: "keyword", name: "Keyword", description: "", stages: ["input"], detector: { ref: "text/keyword", version: "1.0.0", parameters: { detector_options: { terms: ["synthetic"] } } }, on_match: { action: "block" }, risk_level: "medium", metadata: { taxonomy_ids: ["TALI-BUSINESS-POLICY"] } }];
    const id = definition.metadata.id;
    await asTenant("tenantA", () => service.policyResources.save({ definition, maintainer: "A", expectedRevision: 0, actorId: "actor-tenantA", create: true }));
    const view = service.policyResources.compiler.compile(definition);
    await database.pool.query("INSERT INTO policy_resource_version (policy_id,version,revision,definition,view,digest) VALUES ($1,$2,1,$3,$4,'synthetic')", [id, view.version, definition, view]);
    expect(await asTenant("tenantB", () => service.policyResources.views([]))).toEqual([]);
    await expect(asTenant("tenantB", () => service.policyResources.get(id))).rejects.toMatchObject({ code: "not_found" });
    const grant = await asTenant("tenantA", () => shares.createShare({ resourceType: "policy", resourceId: id, recipientTenantId: "tenantB" }, "actor-tenantA"));
    expect((await asTenant("tenantB", () => service.policyResources.get(id))).definition.metadata.name).toBe("Private A Policy");
    await expect(asTenant("tenantB", () => service.policyResources.save({ definition, maintainer: "B", expectedRevision: 1, actorId: "actor-tenantB" }))).rejects.toMatchObject({ code: "not_found" });
    await expect(asTenant("tenantB", () => service.policyResources.publish(id, 1, "actor-tenantB"))).rejects.toMatchObject({ code: "not_found" });
    const draftConfig = normalizeGuardrailDraft({ policyBindings: [{ policyId: id, policyVersion: view.version, enabledRails: ["input"], enabledRuleIds: view.rules.map(rule => rule.id), parameterValues: {} }] });
    const guardrail = await asTenant("tenantB", () => service.createGuardrail({ name: "Uses shared Policy", draftConfig, actorId: "actor-tenantB" }));
    await database.pool.query("INSERT INTO guardrail_validation_run (id,guardrail_id,guardrail_version,source_draft_revision,status) VALUES ('passed-before-revoke',$1,'20261019-000000.000Z',1,'passed')", [guardrail.id]);
    await asTenant("tenantA", () => shares.revokeShare(grant.id, "actor-tenantA"));
    await expect(asTenant("tenantB", () => service.requestGuardrailPublish({ guardrailId: guardrail.id, actorId: "actor-tenantB", expectedDraftRevision: 1 }))).rejects.toMatchObject({ code: "validation_failed" });
    expect((await database.pool.query("SELECT version FROM guardrail_version WHERE guardrail_id=$1", [guardrail.id])).rows).toEqual([]);

    await expect(asTenant("tenantB", () => service.policyResources.get(id))).rejects.toMatchObject({ code: "not_found" });
  });

  it("cannot claim another tenant's imported Policy ID through an ordinary save", async () => {
    const definition = emptyPolicyDefinition(); definition.metadata.name = "Imported private identity";
    await database.pool.query("INSERT INTO policy_imported_version (policy_id,tenant_id,version,digest,definition,source_id) VALUES ($1,'tenantB','1','synthetic','{}','synthetic')", [definition.metadata.id]);
    await expect(asTenant("tenantA", () => service.policyResources.save({ definition, maintainer: "A", expectedRevision: 0, actorId: "actor-tenantA" }))).rejects.toMatchObject({ code: "not_found" });
    expect((await database.pool.query("SELECT id FROM policy_resource WHERE id=$1", [definition.metadata.id])).rows).toEqual([]);
  });

  it("does not authorize read, write or share for an ambiguously owned Policy ID", async () => {
    const definition = emptyPolicyDefinition();
    definition.metadata.id = "policy-ambiguous-ownership";
    await database.pool.query("INSERT INTO policy_resource (id,tenant_id,definition,maintainer) VALUES ($1,'tenantA',$2,'A')", [definition.metadata.id, definition]);
    await database.pool.query("INSERT INTO policy_imported_version (policy_id,tenant_id,version,digest,definition,source_id) VALUES ($1,'tenantB','v1','digest','{}','test')", [definition.metadata.id]);
    for (const tenantId of ["tenantA", "tenantB", "tenantC"]) {
      await expect(asTenant(tenantId, () => assertResourceReadAccess(database.db, "policy", definition.metadata.id))).rejects.toMatchObject({ code: "not_found" });
      await expect(asTenant(tenantId, () => assertResourceWriteAccess(database.db, "policy", definition.metadata.id))).rejects.toMatchObject({ code: "not_found" });
      await expect(asTenant(tenantId, () => shares.createShare({ resourceType: "policy", resourceId: definition.metadata.id, recipientTenantId: tenantId === "tenantC" ? "tenantA" : "tenantC" }, `actor-${tenantId}`))).rejects.toMatchObject({ code: "not_found" });
    }
    await expect(runWithTenantContext({ tenantId: "tenantA", role: "admin" }, () => assertResourceReadAccess(database.db, "policy", definition.metadata.id))).resolves.toBeUndefined();
    await expect(runWithTenantContext({ tenantId: "tenantA", role: "admin" }, () => assertResourceWriteAccess(database.db, "policy", definition.metadata.id))).resolves.toBeUndefined();
    expect((await database.pool.query("SELECT count(*)::int AS count FROM resource_share WHERE resource_type='policy' AND resource_id=$1", [definition.metadata.id])).rows).toEqual([{ count: 0 }]);
  });

  it("scopes security findings and pagination cursors to the invoking tenant", async () => {
    const findings = JSON.stringify(Array.from({ length: 30 }, (_, id) => ({ id: String(id), verdict: "matched", riskSeverity: "high", ruleId: "synthetic" })));
    await database.pool.query(`INSERT INTO runtime_event (id,tenant_id,occurred_at,received_at,request_id,runner_id,guardrail_id,direction,decision,duration_ms,metadata)
      VALUES ('private-event-a','tenantA',now()-interval '1 minute',now()-interval '1 minute','call-a','runner','shared-guardrail','incoming','block',1,jsonb_build_object('findings',$1::jsonb)),
      ('private-event-b','tenantB',now()-interval '1 minute',now()-interval '1 minute','call-b','runner','shared-guardrail','incoming','block',1,jsonb_build_object('findings',$1::jsonb))`, [findings]);
    const query = securityEventsQuery.parse({ guardrailId: "shared-guardrail", limit: 25, window: "24h" });
    const a = await asTenant("tenantA", () => service.querySecurityEvents(query));
    const b = await asTenant("tenantB", () => service.querySecurityEvents(query));
    expect(a.items.every(item => item.eventId === "private-event-a")).toBe(true);
    expect(b.items.every(item => item.eventId === "private-event-b")).toBe(true);
    expect(b.items).toHaveLength(25); expect(b.nextCursor).toBeTruthy();
    await expect(asTenant("tenantB", () => service.querySecurityEvents({ ...query, cursor: a.nextCursor! }))).rejects.toMatchObject({ code: "validation_failed" });
    expect((await asTenant("tenantC", () => service.querySecurityEvents(query))).items).toEqual([]);
    await expect(asTenant("tenantB", () => service.getRuntimeEvent("private-event-a"))).rejects.toMatchObject({ code: "not_found" });
  });

  it("attributes shared Guardrail traffic to the caller Endpoint and protects package bytes", async () => {
    await service.recordRuntimeEvents([{ id: "endpoint-b-event", occurredAt: new Date(), requestId: "caller-b", runnerId: "runner", guardrailId: "shared-guardrail", endpointId: "endpoint-b", direction: "incoming", decision: "allow", durationMs: 1, metadata: {} }]);
    expect((await database.pool.query("SELECT tenant_id FROM runtime_event WHERE id='endpoint-b-event'")).rows).toEqual([{ tenant_id: "tenantB" }]);
    await database.pool.query("INSERT INTO guardrail_package (id,tenant_id,content,size_bytes,source_id,guardrail_id,manifest,uploaded_by) VALUES ('private-upload','tenantA',$1,9,'synthetic','shared-guardrail','{}','actor-tenantA')", [Buffer.from("synthetic")]);
    await expect(asTenant("tenantB", () => service.packages.previewPackage("private-upload"))).rejects.toMatchObject({ code: "not_found" });
    await expect(asTenant("tenantB", () => service.packages.checkVersionEnvironment("shared-guardrail", "missing"))).rejects.toMatchObject({ code: "not_found" });
    await expect(asTenant("tenantC", () => service.packages.exportPackage("shared-guardrail", undefined))).rejects.toMatchObject({ code: "not_found" });
  });
});
