// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { queryAuditEvents } from "./audit-events.js";
import { runWithProjectContext } from "./project-context.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("audit project attribution", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => {
    database = await createTestDatabase(url!, "audit_project");
    await database.pool.query(`
      INSERT INTO auth_user (id,name,email,role) SELECT id,name,email,role FROM (VALUES ('admin-a','projectA','Admin','admin@example.test','admin'),('user-a','projectA','A','a@example.test','user'),('user-b','projectB','B','b@example.test','user')) AS fixture(id,project_id,name,email,role);
      INSERT INTO guardrail (id,project_id,name,draft_config) VALUES
        ('guard-c','projectC','C','{}'), ('guard-a','projectA','A','{}');
      INSERT INTO policy_resource (id,project_id,definition,maintainer) VALUES ('conflicted-policy','projectA','{}','A');
      INSERT INTO policy_imported_version (policy_id,project_id,version,digest,definition,source_id)
        VALUES ('conflicted-policy','projectB','v1','digest','{}','test');
      INSERT INTO resource_share (id,owner_project_id,recipient_project_id,resource_type,resource_id)
        VALUES ('share-c-b','projectC','projectB','guardrail','guard-c');
      INSERT INTO personal_access_token (id,project_id,user_id,name,prefix,token_hash,permissions,expires_at) VALUES
        ('token-user','projectB','user-b','B token','prefix','hash-b','{}',now()+interval '1 day'),
        ('token-admin',NULL,'admin-a','Admin token','prefix','hash-admin','{}',now()+interval '1 day');
      INSERT INTO model_provider (id,name,kind,base_url,credential_ciphertext)
        VALUES ('provider','Provider','custom-openai-compatible','http://invalid.test','');
      INSERT INTO model_definition (id,project_id,provider_id,name,model) VALUES
        ('platform-model',NULL,'provider','Platform','platform'),
        ('model-b','projectB','provider','B model','project');
      INSERT INTO audit_event (id,project_id,kind,actor_id,resource_type,resource_id,detail) VALUES
        ('admin-on-c','projectA','guardrail.updated','admin-a','guardrail','guard-c','{"private":"C detail"}'),
        ('shared-b-on-c','projectB','guardrail.updated','user-b','guardrail','guard-c','{}'),
        ('system-on-c','projectA','guardrail.completed',NULL,'guardrail','guard-c','{}'),
        ('user-own-a',NULL,'guardrail.updated','user-a','guardrail','guard-a','{}'),
        ('platform','projectA','provider.updated','admin-a','model_provider','provider','{"private":"platform"}'),
        ('unknown','projectA','guardrail.updated',NULL,'guardrail','missing','{}'),
        ('platform-model-audit','projectA','model.updated','admin-a','model','platform-model','{}'),
        ('project-model-audit','projectA','model.updated','admin-a','model_definition','model-b','{}'),
        ('token-own','projectA','access_token.request','user-b','access_token','token-user','{}'),
        ('token-admin-audit','projectA','access_token.request','admin-a','access_token','token-admin','{}'),
        ('token-forged','projectA','access_token.request','user-a','access_token','token-user','{}'),
        ('deleted-policy','projectC','policy.deleted','admin-a','policy','gone','{}'),
        ('conflicted-policy-audit','projectA','policy.updated','user-a','policy','conflicted-policy','{}');
    `);
  }, 30000);
  afterAll(async () => { await database?.drop(); });

  it("derives known resources from their owner and quarantines unknown and platform events", async () => {
    const rows = (await database.pool.query("SELECT id,project_id FROM audit_event ORDER BY id")).rows;
    expect(Object.fromEntries(rows.map(row => [row.id, row.project_id]))).toEqual({
      "admin-on-c": "projectC", "conflicted-policy-audit": null, "deleted-policy": "projectC", "platform": null,
      "platform-model-audit": null, "shared-b-on-c": "projectC", "system-on-c": "projectC",
      "project-model-audit": "projectB", "token-admin-audit": null, "token-forged": null,
      "token-own": "projectB", "unknown": null, "user-own-a": "projectA",
    });
  });

  it("keeps private and platform audit details out of other projects even when a resource is shared", async () => {
    const visible = async (projectId: string) => runWithProjectContext({ projectId, role: "user" }, () => queryAuditEvents(database.db, { window: "all", limit: 100 }));
    expect((await visible("projectA")).items.map(row => row.id)).toEqual(["user-own-a"]);
    expect(new Set((await visible("projectB")).items.map(row => row.id))).toEqual(new Set(["project-model-audit", "token-own"]));
    expect(new Set((await visible("projectC")).items.map(row => row.id))).toEqual(new Set(["admin-on-c", "deleted-policy", "shared-b-on-c", "system-on-c"]));
    expect((await queryAuditEvents(database.db, { window: "all", limit: 100 })).total).toBe(13);
  });

});
