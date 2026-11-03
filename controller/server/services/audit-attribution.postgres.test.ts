// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { queryAuditEvents } from "./audit-events.js";
import { runWithTenantContext } from "./tenant-context.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("audit tenant attribution", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => {
    database = await createTestDatabase(url!, "audit_tenant");
    await database.pool.query(`
      INSERT INTO auth_user (id,tenant_id,name,email,role) VALUES
        ('admin-a','tenantA','Admin','admin@example.test','admin'),
        ('user-a','tenantA','A','a@example.test','user'),
        ('user-b','tenantB','B','b@example.test','user');
      INSERT INTO guardrail (id,tenant_id,name,draft_config) VALUES
        ('guard-c','tenantC','C','{}'), ('guard-a','tenantA','A','{}');
      INSERT INTO policy_resource (id,tenant_id,definition,maintainer) VALUES ('conflicted-policy','tenantA','{}','A');
      INSERT INTO policy_imported_version (policy_id,tenant_id,version,digest,definition,source_id)
        VALUES ('conflicted-policy','tenantB','v1','digest','{}','test');
      INSERT INTO resource_share (id,owner_tenant_id,recipient_tenant_id,resource_type,resource_id)
        VALUES ('share-c-b','tenantC','tenantB','guardrail','guard-c');
      INSERT INTO personal_access_token (id,user_id,name,prefix,token_hash,permissions,expires_at) VALUES
        ('token-user','user-b','B token','prefix','hash-b','{}',now()+interval '1 day'),
        ('token-admin','admin-a','Admin token','prefix','hash-admin','{}',now()+interval '1 day');
      INSERT INTO model_provider (id,name,kind,base_url,credential_ciphertext)
        VALUES ('provider','Provider','custom-openai-compatible','http://invalid.test','');
      INSERT INTO model_definition (id,tenant_id,provider_id,name,model) VALUES
        ('platform-model',NULL,'provider','Platform','platform'),
        ('model-b','tenantB','provider','B model','tenant');
      INSERT INTO audit_event (id,tenant_id,kind,actor_id,resource_type,resource_id,detail) VALUES
        ('admin-on-c','tenantA','guardrail.updated','admin-a','guardrail','guard-c','{"private":"C detail"}'),
        ('shared-b-on-c','tenantB','guardrail.updated','user-b','guardrail','guard-c','{}'),
        ('system-on-c','tenantA','guardrail.completed',NULL,'guardrail','guard-c','{}'),
        ('user-own-a',NULL,'guardrail.updated','user-a','guardrail','guard-a','{}'),
        ('platform','tenantA','provider.updated','admin-a','model_provider','provider','{"private":"platform"}'),
        ('unknown','tenantA','guardrail.updated',NULL,'guardrail','missing','{}'),
        ('platform-model-audit','tenantA','model.updated','admin-a','model','platform-model','{}'),
        ('tenant-model-audit','tenantA','model.updated','admin-a','model_definition','model-b','{}'),
        ('token-own','tenantA','access_token.request','user-b','access_token','token-user','{}'),
        ('token-admin-audit','tenantA','access_token.request','admin-a','access_token','token-admin','{}'),
        ('token-forged','tenantA','access_token.request','user-a','access_token','token-user','{}'),
        ('deleted-policy','tenantC','policy.deleted','admin-a','policy','gone','{}'),
        ('conflicted-policy-audit','tenantA','policy.updated','user-a','policy','conflicted-policy','{}');
    `);
  }, 30000);
  afterAll(async () => { await database?.drop(); });

  it("derives known resources from their owner and quarantines unknown and platform events", async () => {
    const rows = (await database.pool.query("SELECT id,tenant_id FROM audit_event ORDER BY id")).rows;
    expect(Object.fromEntries(rows.map(row => [row.id, row.tenant_id]))).toEqual({
      "admin-on-c": "tenantC", "conflicted-policy-audit": null, "deleted-policy": "tenantC", "platform": null,
      "platform-model-audit": null, "shared-b-on-c": "tenantC", "system-on-c": "tenantC",
      "tenant-model-audit": "tenantB", "token-admin-audit": null, "token-forged": null,
      "token-own": "tenantB", "unknown": null, "user-own-a": "tenantA",
    });
  });

  it("keeps private and platform audit details out of other tenants even when a resource is shared", async () => {
    const visible = async (tenantId: string) => runWithTenantContext({ tenantId, role: "user" }, () => queryAuditEvents(database.db, { window: "all", limit: 100 }));
    expect((await visible("tenantA")).items.map(row => row.id)).toEqual(["user-own-a"]);
    expect(new Set((await visible("tenantB")).items.map(row => row.id))).toEqual(new Set(["tenant-model-audit", "token-own"]));
    expect(new Set((await visible("tenantC")).items.map(row => row.id))).toEqual(new Set(["admin-on-c", "deleted-policy", "shared-b-on-c", "system-on-c"]));
    expect((await queryAuditEvents(database.db, { window: "all", limit: 100 })).total).toBe(13);
  });

  it("rolls back both preserved ownership and quarantine when an audit update fails", async () => {
    await database.pool.query(`
      DELETE FROM historical_audit_quarantine_checkpoint WHERE id='0054';
      CREATE FUNCTION reject_audit_quarantine() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'test audit quarantine failure'; END $$;
      CREATE TRIGGER reject_audit_quarantine BEFORE UPDATE ON audit_event
        FOR EACH ROW EXECUTE FUNCTION reject_audit_quarantine();
    `);
    const migration = readFileSync(new URL("../db/migrations/0008_audit_attribution_quarantine.sql", import.meta.url), "utf8");
    await expect(database.pool.query(migration)).rejects.toThrow("test audit quarantine failure");
    expect((await database.pool.query("SELECT tenant_id FROM audit_event WHERE id='admin-on-c'")).rows)
      .toEqual([{ tenant_id: "tenantC" }]);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM historical_audit_attribution")).rows)
      .toEqual([{ count: 0 }]);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM historical_audit_quarantine_checkpoint WHERE id='0054'")).rows)
      .toEqual([{ count: 0 }]);
  });
});
