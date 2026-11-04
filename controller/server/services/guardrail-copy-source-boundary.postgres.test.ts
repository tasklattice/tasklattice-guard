import { withTestProject } from "../db/postgres-test-database.js";
// @vitest-environment node
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { planPolicyVersion, snapshotChecksum } from "../domain/policy-node.js";
import { defaultGuardrailDraft } from "../domain/defaults.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import type { ProgrammablePolicySnapshot } from "../policy-studio/model.js";
import { ControlPlaneService } from "./control-plane.js";
import { runWithProjectContext } from "./project-context.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("shared Guardrail source copying and draft diffs", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: ControlPlaneService;
  const version = "20261012-030000.000Z";
  const asProject = <T>(projectId: string, fn: () => T) => runWithProjectContext({ projectId, actorId: projectId, role: "user" }, fn);
  const source: Record<string, unknown> = { policy_id: "copy-private-policy", version: "1", name: "Private", source: "custom", colang_version: "2.x",
    sources: [{ path: "main.co", content: "PRIVATE POLICY SOURCE" }], parameter_schema: [], rail_bindings: [], action_references: [],
    evaluation_contracts: [], prompt_dependencies: [], execution_contract: [], test_cases: [{ name: "PRIVATE CASE", content: "PRIVATE CASE", expected_decision: "block" }] };
  source.checksum = snapshotChecksum(source);
  const nodes = [{ id: "copy-private-policy", version: "1", kind: "programmable", definition: source }];
  const plan = { policy_bindings: [{ policy_id: "copy-private-policy", policy_version: "1" }],
    policy_versions: [planPolicyVersion(source as unknown as ProgrammablePolicySnapshot)] };
  const draft = (secret: string) => ({ policyBindings: [{ policyId: "copy-private-policy", policyVersion: "1", enabledRails: ["input"],
    enabledRuleIds: [], parameterValues: {}, testCaseOverrides: { "private-case": { sourcePolicyVersion: "1", reason: secret,
      expectedDecision: "allow", expectedOutputContent: secret, expectedMatches: [] } } }] });
  beforeAll(async () => {
    database = await createTestDatabase(url!, "guardrail_copy_source");
    service = new ControlPlaneService(database.db, loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!,
      CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key",
      CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"), BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" }));
    await database.pool.query(`INSERT INTO auth_user (id,name,email,role) SELECT id,name,email,role FROM (VALUES ('projectA','A','copy-a@test.invalid','user','projectA'),('projectB','B','copy-b@test.invalid','user','projectB'),('projectC','C','copy-c@test.invalid','user','projectC')) AS fixture(id,name,email,role,project_id);
      INSERT INTO project_group(id,name) VALUES ('copy-isolated','Isolated');
      UPDATE project SET group_id='copy-isolated' WHERE id='projectC';
      INSERT INTO policy_record(id,project_id,name,owner,draft) VALUES ('copy-private-policy','projectA','Private','A','{}');
      INSERT INTO guardrail(id,project_id,name,draft_config) VALUES ('copy-shared','projectA','Shared source','{}');
      INSERT INTO resource_share(id,owner_project_id,recipient_project_id,resource_type,resource_id) VALUES
      ('copy-guard-b','projectA','projectB','guardrail','copy-shared'),('copy-guard-c','projectA','projectC','guardrail','copy-shared');`);
    await database.pool.query("INSERT INTO policy_version(policy_id,version,snapshot,checksum) VALUES ('copy-private-policy',1,$1,'private-checksum')", [JSON.stringify(source)]);
    await database.pool.query("UPDATE guardrail SET draft_config=$1,excluded_test_case_ids='[\"private-case\"]' WHERE id='copy-shared'", [JSON.stringify(draft("PRIVATE CURRENT SOURCE"))]);
    await database.pool.query(`INSERT INTO guardrail_test_case(id,guardrail_id,name,policy_id,phase,content,expected_decision,origin,source_policy_id,source_policy_version)
      VALUES ('private-case','copy-shared','Private generated case','copy-private-policy','input','PRIVATE GENERATED CASE','block','generated','copy-private-policy','1')`);
    const cases = (await database.pool.query("SELECT * FROM guardrail_test_case WHERE guardrail_id='copy-shared'")).rows;
    // Source snapshots use the domain's camelCase case fields, as publication does.
    const testCases = cases.map(row => ({ id: row.id, guardrailId: row.guardrail_id, name: row.name, policyId: row.policy_id,
      phase: row.phase, content: row.content, expectedDecision: row.expected_decision, expectedOutputContent: row.expected_output_content,
      coveredRuleIds: row.covered_rule_ids, targetSource: row.target_source, messages: row.messages, groundingSources: row.grounding_sources,
      origin: row.origin, sourcePolicyId: row.source_policy_id, sourcePolicyVersion: row.source_policy_version, updatedAt: row.updated_at }));
    const snapshot = { draftConfig: draft("PRIVATE BASELINE SOURCE"), runtimeProfile: "auto", loggingLevel: "info", excludedTestCaseIds: ["private-case"], testCases };
    await database.pool.query(`INSERT INTO guardrail_version(guardrail_id,version,generation,status,runtime_profile,plan,policies,source_snapshot,released_at)
      VALUES ('copy-shared',$1,1,'ready','auto',$2,$3,$4,now())`, [version, JSON.stringify(plan), JSON.stringify(nodes), JSON.stringify(snapshot)]);
  }, 30000);
  afterAll(async () => { await database?.drop(); });

  it("denies same-group and cross-group Guardrail-only source copies/diffs without creating owned copies", async () => {
    for (const project of ["projectB", "projectC"]) {
      await expect(asProject(project, () => withTestProject(() => service.duplicateGuardrail({ id: "copy-shared", name: "Draft copy", sourceDraftRevision: 1,
        idempotencyKey: `denied-draft-${project}`, actorId: project })))).rejects.toMatchObject({ code: "not_found" });
      await expect(asProject(project, () => withTestProject(() => service.duplicateGuardrail({ id: "copy-shared", name: "Version copy", sourceVersion: version,
        idempotencyKey: `denied-version-${project}`, actorId: project })))).rejects.toMatchObject({ code: "not_found" });
      await expect(asProject(project, () => service.guardrailDraftChanges("copy-shared"))).rejects.toMatchObject({ code: "not_found" });
    }
    expect((await database.pool.query("SELECT count(*)::int AS count FROM guardrail WHERE duplicate_key IS NOT NULL")).rows[0].count).toBe(0);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM audit_event WHERE kind='guardrail.duplicated'")).rows[0].count).toBe(0);
    expect(JSON.stringify(await asProject("projectA", () => service.guardrailDraftChanges("copy-shared")))).toContain("PRIVATE CURRENT SOURCE");
  });

  it("permits independently readable matching Policy content and denies new copies/diffs again after revocation", async () => {
    await database.pool.query("INSERT INTO resource_share(id,owner_project_id,recipient_project_id,resource_type,resource_id) VALUES ('copy-policy-b','projectA','projectB','policy','copy-private-policy')");
    const copied = await asProject("projectB", () => withTestProject(() => service.duplicateGuardrail({ id: "copy-shared", name: "Readable draft", sourceDraftRevision: 1,
      idempotencyKey: "readable-draft", actorId: "projectB" })));
    expect(JSON.stringify(copied.draftConfig)).toContain("PRIVATE CURRENT SOURCE");
    const copiedVersion = await asProject("projectB", () => withTestProject(() => service.duplicateGuardrail({ id: "copy-shared", name: "Readable version", sourceVersion: version,
      idempotencyKey: "readable-version", actorId: "projectB" })));
    expect(JSON.stringify(copiedVersion.draftConfig)).toContain("PRIVATE BASELINE SOURCE");
    expect(JSON.stringify(await asProject("projectB", () => service.guardrailDraftChanges("copy-shared")))).toContain("PRIVATE CURRENT SOURCE");
    await database.pool.query("DELETE FROM resource_share WHERE id='copy-policy-b'");
    await expect(asProject("projectB", () => withTestProject(() => service.duplicateGuardrail({ id: "copy-shared", name: "Revoked", sourceVersion: version,
      idempotencyKey: "revoked-version", actorId: "projectB" })))).rejects.toMatchObject({ code: "not_found" });
    await expect(asProject("projectB", () => service.guardrailDraftChanges("copy-shared"))).rejects.toMatchObject({ code: "not_found" });
    expect((await database.pool.query("SELECT count(*)::int AS count FROM guardrail WHERE duplicate_key IS NOT NULL")).rows[0].count).toBe(2);
  });

  it("does not infer a shared published snapshot's source from a reused ID or missing frozen nodes", async () => {
    await database.pool.query("INSERT INTO resource_share(id,owner_project_id,recipient_project_id,resource_type,resource_id) VALUES ('copy-policy-b','projectA','projectB','policy','copy-private-policy')");
    await database.pool.query("UPDATE guardrail_version SET policies=NULL WHERE guardrail_id='copy-shared'");
    await expect(asProject("projectB", () => withTestProject(() => service.duplicateGuardrail({ id: "copy-shared", name: "Unknown", sourceVersion: version,
      idempotencyKey: "unknown-version", actorId: "projectB" })))).rejects.toMatchObject({ code: "not_found" });
    await database.pool.query("UPDATE guardrail_version SET policies=$1 WHERE guardrail_id='copy-shared'", [JSON.stringify(nodes)]);
    await database.pool.query("UPDATE policy_version SET snapshot=$1 WHERE policy_id='copy-private-policy'", [JSON.stringify({ ...source, name: "Replacement" })]);
    await expect(asProject("projectB", () => service.guardrailDraftChanges("copy-shared"))).rejects.toMatchObject({ code: "not_found" });
    await database.pool.query("UPDATE policy_version SET snapshot=$1 WHERE policy_id='copy-private-policy'", [JSON.stringify(source)]);
    await database.pool.query("DELETE FROM resource_share WHERE id='copy-policy-b'");
  });

  it("preserves owner copies and a shared unfrozen draft composed entirely of shipped public Policies", async () => {
    const own = await asProject("projectA", () => withTestProject(() => service.duplicateGuardrail({ id: "copy-shared", name: "Owner copy", sourceDraftRevision: 1,
      idempotencyKey: "owner-copy", actorId: "projectA" })));
    expect(JSON.stringify(own.draftConfig)).toContain("PRIVATE CURRENT SOURCE");
    const catalog = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const publicGuardrail = await asProject("projectA", () => withTestProject(() => service.createGuardrail({ name: "Public draft", actorId: "projectA",
      runtimeProfile: "auto", draftConfig: defaultGuardrailDraft(catalog) })));
    await database.pool.query("INSERT INTO resource_share(id,owner_project_id,recipient_project_id,resource_type,resource_id) VALUES ('public-copy-share','projectA','projectB','guardrail',$1)", [publicGuardrail.id]);
    const copied = await asProject("projectB", () => withTestProject(() => service.duplicateGuardrail({ id: publicGuardrail.id, name: "Public draft copy",
      sourceDraftRevision: publicGuardrail.draftRevision, idempotencyKey: "public-copy", actorId: "projectB" })));
    expect(copied.draftConfig).toEqual(publicGuardrail.draftConfig);
    expect(JSON.stringify(await asProject("projectB", () => service.guardrailDraftChanges(publicGuardrail.id)))).not.toContain("PRIVATE");
  });
});
