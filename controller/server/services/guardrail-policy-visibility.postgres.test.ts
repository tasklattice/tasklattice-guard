// @vitest-environment node
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { loadConfig } from "../config.js";
import { ControlPlaneService } from "./control-plane.js";
import { runWithTenantContext } from "./tenant-context.js";
import { frozenBuiltInDefinition, planPolicyVersion, snapshotChecksum } from "../domain/policy-node.js";
import type { ProgrammablePolicySnapshot } from "../policy-studio/model.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { mayReadFrozenPolicyContent } from "./guardrail-policy-visibility.js";
import { storeValidationSnapshot } from "./testing-reports.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Guardrail version Policy-content visibility", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: ControlPlaneService;
  const version = "20261012-030000.000Z";
  const snapshot: Record<string, unknown> = { policy_id: "private-policy", version: "1", name: "Private", source: "custom", colang_version: "2.x",
    sources: [{ path: "main.co", content: "PRIVATE POLICY SOURCE" }], parameter_schema: [], rail_bindings: [], action_references: [],
    evaluation_contracts: [], prompt_dependencies: [], execution_contract: [], test_cases: [{ name: "PRIVATE CASE", content: "PRIVATE CASE", expected_decision: "block" }] };
  snapshot.checksum = snapshotChecksum(snapshot);
  const plan = { policy_bindings: [{ policy_id: "private-policy", policy_version: "1" }], policy_versions: [planPolicyVersion(snapshot as unknown as ProgrammablePolicySnapshot)] };
  const nodes = [{ id: "private-policy", version: "1", kind: "programmable" as const, definition: snapshot }];
  const asTenant = <T>(tenantId: string, fn: () => T) => runWithTenantContext({ tenantId, role: "user" }, fn);
  beforeAll(async () => {
    database = await createTestDatabase(url!, "guardrail_policy_visibility");
    service = new ControlPlaneService(database.db, loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!,
      CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key",
      CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"), BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters" }));
    await database.pool.query(`INSERT INTO guardrail(id,tenant_id,name,draft_config) VALUES ('shared-guard','tenantA','Shared','{}');
      INSERT INTO policy_record(id,tenant_id,name,owner,draft) VALUES ('private-policy','tenantA','Private','A','{}');
      INSERT INTO resource_share(id,owner_tenant_id,recipient_tenant_id,resource_type,resource_id)
        VALUES ('guard-share','tenantA','tenantB','guardrail','shared-guard')`);
    await database.pool.query("INSERT INTO policy_version(policy_id,version,snapshot,checksum) VALUES ('private-policy',1,$1,'private-checksum')", [JSON.stringify(snapshot)]);
    await database.pool.query(`INSERT INTO guardrail_artifact(id,guardrail_id,guardrail_version,generation,compiler_version,nemo_version,runtime_profile,plan,config_yaml,colang_content,checksum,signature)
        VALUES ('artifact','shared-guard',$1,1,'test','test','auto',$2,'PRIVATE YAML','PRIVATE COLANG','artifact-checksum','signature')`, [version, JSON.stringify(plan)]);
    await database.pool.query(`INSERT INTO guardrail_version(guardrail_id,version,generation,status,runtime_profile,plan,artifact_id,policies,test_suite)
        VALUES ('shared-guard',$1,1,'pending','auto',$2,'artifact',$3,$4)`, [version, JSON.stringify(plan), JSON.stringify(nodes), JSON.stringify([{ id: "case", content: "PRIVATE CASE" }])]);
  }, 30000);
  afterAll(async () => { await database?.drop(); });
  it("does not expose Policy leaves, compiled content or frozen tests through a Guardrail share alone", async () => {
    const detail = await asTenant("tenantB", () => service.getGuardrail("shared-guard"));
    const view = detail.versions[0]!;
    expect(view).toMatchObject({ policyContentAccessible: false, plan: {}, policies: null, artifact: null, inspection: null, testSuiteCount: null });
    expect(JSON.stringify(view)).not.toContain("PRIVATE");
    await expect(asTenant("tenantB", () => service.guardrailVersionTestSuite("shared-guard", version))).rejects.toMatchObject({ code: "not_found" });
  });
  it("permits explicit Policy shares and revokes access immediately", async () => {
    await database.pool.query("INSERT INTO resource_share(id,owner_tenant_id,recipient_tenant_id,resource_type,resource_id) VALUES ('policy-share','tenantA','tenantB','policy','private-policy')");
    const visible = await asTenant("tenantB", () => service.getGuardrail("shared-guard"));
    expect(visible.versions[0]).toMatchObject({ policyContentAccessible: true, artifact: { colangContent: "PRIVATE COLANG" } });
    expect((await asTenant("tenantB", () => service.guardrailVersionTestSuite("shared-guard", version))).items).toHaveLength(1);
    await database.pool.query("DELETE FROM resource_share WHERE id='policy-share'");
    expect((await asTenant("tenantB", () => service.getGuardrail("shared-guard"))).versions[0]).toMatchObject({ policyContentAccessible: false });
  });
  it("preserves owner and platform access, and denies unproven legacy leaves", async () => {
    expect((await asTenant("tenantA", () => service.getGuardrail("shared-guard"))).versions[0]).toMatchObject({ policyContentAccessible: true });
    expect((await service.getGuardrail("shared-guard")).versions[0]).toMatchObject({ policyContentAccessible: true });
    await database.pool.query("UPDATE guardrail_version SET policies=NULL WHERE guardrail_id='shared-guard'");
    expect((await asTenant("tenantA", () => service.getGuardrail("shared-guard"))).versions[0]).toMatchObject({ policyContentAccessible: false });
    await expect(asTenant("tenantA", () => service.guardrailVersionTestSuite("shared-guard", version))).rejects.toMatchObject({ code: "not_found" });
    await database.pool.query("UPDATE guardrail_version SET policies=$1 WHERE guardrail_id='shared-guard'", [JSON.stringify(nodes)]);
  });
  it("protects generated draft cases and validation results with the same independent Policy grant", async () => {
    await database.pool.query(`INSERT INTO guardrail_test_case(id,guardrail_id,name,policy_id,phase,content,expected_decision,origin,source_policy_id,source_policy_version)
      VALUES ('generated-private','shared-guard','Private case','private-policy','input','PRIVATE CASE','block','generated','private-policy','1')`);
    const snapshotDigest = await storeValidationSnapshot(database.db, { candidateArtifact: null, candidatePolicies: nodes as never, candidateInspection: null, testSuite: null });
    await database.pool.query(`INSERT INTO guardrail_validation_run(id,guardrail_id,guardrail_version,source_draft_revision,subject,snapshot_digest,failure_reason,excluded_case_ids,test_scope)
      VALUES ('private-run','shared-guard',$1,1,'version',$2,'PRIVATE FAILURE',$3,$4)`, [version, snapshotDigest,
      JSON.stringify(["PRIVATE CASE ID"]), JSON.stringify({ skippedRules: [{ reason: "PRIVATE SKIP" }] })]);
    await expect(asTenant("tenantB", () => service.listTestCases("shared-guard"))).rejects.toMatchObject({ code: "not_found" });
    await expect(asTenant("tenantB", () => service.getValidationRun("private-run"))).rejects.toMatchObject({ code: "not_found" });
    await expect(asTenant("tenantB", () => service.authorizeReportRead("private-run"))).rejects.toMatchObject({ code: "not_found" });
    const reports = await asTenant("tenantB", () => service.queryValidationRuns({ guardrailId: "shared-guard" }));
    expect(reports.items[0]).toMatchObject({ id: "private-run", failureReason: null, excludedCaseIds: [], testScope: null });
    expect(JSON.stringify(reports)).not.toContain("PRIVATE");
    expect(JSON.stringify((await asTenant("tenantB", () => service.getGuardrail("shared-guard"))).latestTestingReport)).not.toContain("PRIVATE");
    expect((await asTenant("tenantA", () => service.listTestCases("shared-guard")))[0]?.content).toBe("PRIVATE CASE");
    await database.pool.query("INSERT INTO resource_share(id,owner_tenant_id,recipient_tenant_id,resource_type,resource_id) VALUES ('detail-policy-share','tenantA','tenantB','policy','private-policy')");
    expect((await asTenant("tenantB", () => service.listTestCases("shared-guard")))[0]?.content).toBe("PRIVATE CASE");
    expect(JSON.stringify(await asTenant("tenantB", () => service.getValidationRun("private-run")))).toContain("PRIVATE FAILURE");
    await expect(asTenant("tenantB", () => service.authorizeReportRead("private-run"))).resolves.toBeUndefined();
    await expect(asTenant("tenantC", () => service.authorizeReportRead("private-run"))).rejects.toMatchObject({ code: "not_found" });
    expect((await asTenant("tenantB", () => service.queryValidationRuns({ guardrailId: "shared-guard" }))).items[0]?.failureReason).toBe("PRIVATE FAILURE");
    await database.pool.query("DELETE FROM resource_share WHERE id='detail-policy-share'");
    await expect(asTenant("tenantB", () => service.getValidationRun("private-run"))).rejects.toMatchObject({ code: "not_found" });
  });
  it("rejects divergent plan projections and Artifact plans even for a readable Policy", async () => {
    const altered = { ...plan, policy_versions: [{ ...plan.policy_versions[0], sources: [{ path: "private.co", content: "OTHER PRIVATE SOURCE" }] }] };
    await database.pool.query("UPDATE guardrail_version SET plan=$1 WHERE guardrail_id='shared-guard'", [JSON.stringify(altered)]);
    await database.pool.query("UPDATE guardrail_artifact SET plan=$1 WHERE id='artifact'", [JSON.stringify(altered)]);
    expect((await asTenant("tenantA", () => service.getGuardrail("shared-guard"))).versions[0]?.policyContentAccessible).toBe(false);
    await expect(asTenant("tenantA", () => service.guardrailVersionTestSuite("shared-guard", version))).rejects.toMatchObject({ code: "not_found" });
    await database.pool.query("UPDATE guardrail_version SET plan=$1 WHERE guardrail_id='shared-guard'", [JSON.stringify(plan)]);
    expect((await asTenant("tenantA", () => service.getGuardrail("shared-guard"))).versions[0]?.policyContentAccessible).toBe(false);
    await database.pool.query("UPDATE guardrail_artifact SET plan=$1 WHERE id='artifact'", [JSON.stringify(plan)]);
    expect((await asTenant("tenantA", () => service.getGuardrail("shared-guard"))).versions[0]?.policyContentAccessible).toBe(true);
  });
  it("rejects reused Policy identities with a different frozen definition", async () => {
    await database.pool.query("UPDATE policy_version SET snapshot=$1 WHERE policy_id='private-policy'", [JSON.stringify({ ...snapshot, name: "Replacement" })]);
    expect((await asTenant("tenantA", () => service.getGuardrail("shared-guard"))).versions[0]?.policyContentAccessible).toBe(false);
    await database.pool.query("UPDATE policy_version SET snapshot=$1 WHERE policy_id='private-policy'", [JSON.stringify(snapshot)]);
  });
  it("accepts the exact public catalog definition but rejects unchecked source-bearing projections", async () => {
    const catalog = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const policy = catalog[0]!;
    const publicNodes = [{ id: policy.id, version: policy.version, kind: "catalog" as const, definition: frozenBuiltInDefinition(policy) }];
    const publicPlan = { policy_bindings: [{ policy_id: policy.id, policy_version: policy.version }] };
    expect(await asTenant("tenantB", () => mayReadFrozenPolicyContent(database.db, publicNodes, publicPlan, catalog))).toBe(true);
    expect(await asTenant("tenantB", () => mayReadFrozenPolicyContent(database.db, [{ ...publicNodes[0]!, definition: { ...publicNodes[0]!.definition, name: "PRIVATE REPLACEMENT" } }], publicPlan, catalog))).toBe(false);
    expect(await asTenant("tenantB", () => mayReadFrozenPolicyContent(database.db, [], { policy_bindings: [], policy_versions: plan.policy_versions }, catalog))).toBe(false);
    expect(await asTenant("tenantA", () => mayReadFrozenPolicyContent(database.db, nodes, { ...plan, policy_versions: [null] }, catalog))).toBe(false);
    expect(await asTenant("tenantB", () => mayReadFrozenPolicyContent(database.db, publicNodes, { ...publicPlan,
      steps: [{ capability: "builtin_content_filter", parameters: [["policy_definitions_json", "PRIVATE MALFORMED JSON"]] }] }, catalog))).toBe(false);
  });
  it("does not disclose Policy-derived expectation overrides through a shared Guardrail summary", async () => {
    const override = { sourcePolicyVersion: "1", reason: "PRIVATE REVIEW REASON", expectedDecision: "allow",
      expectedOutputContent: "PRIVATE CASE SOURCE", expectedMatches: [] };
    const draft = { policyBindings: [{ policyId: "private-policy", policyVersion: "1", enabledRails: ["input"],
      enabledRuleIds: [], parameterValues: {}, testCaseOverrides: { "PRIVATE SOURCE CASE ID": override } }] };
    await database.pool.query("UPDATE guardrail SET draft_config=$1, excluded_test_case_ids=$2 WHERE id='shared-guard'", [
      JSON.stringify(draft), JSON.stringify(["PRIVATE EXCLUDED CASE ID"]),
    ]);
    const hidden = await asTenant("tenantB", () => service.getGuardrail("shared-guard"));
    expect(hidden.draftConfig.policyBindings[0]?.testCaseOverrides).toEqual({});
    expect(hidden.excludedTestCaseIds).toEqual([]);
    expect(JSON.stringify(hidden.draftConfig)).not.toContain("PRIVATE");
    const summary = (await asTenant("tenantB", () => service.listGuardrails())).find(guardrail => guardrail.id === "shared-guard")!;
    expect(summary.draftConfig.policyBindings[0]?.testCaseOverrides).toEqual({});
    expect(summary.excludedTestCaseIds).toEqual([]);
    expect((await asTenant("tenantA", () => service.getGuardrail("shared-guard"))).draftConfig.policyBindings[0]?.testCaseOverrides)
      .toEqual({ "PRIVATE SOURCE CASE ID": override });
    expect((await service.getGuardrail("shared-guard")).draftConfig.policyBindings[0]?.testCaseOverrides)
      .toEqual({ "PRIVATE SOURCE CASE ID": override });
    await database.pool.query("INSERT INTO resource_share(id,owner_tenant_id,recipient_tenant_id,resource_type,resource_id) VALUES ('override-policy-share','tenantA','tenantB','policy','private-policy')");
    const shared = await asTenant("tenantB", () => service.getGuardrail("shared-guard"));
    expect(shared.draftConfig.policyBindings[0]?.testCaseOverrides).toEqual({ "PRIVATE SOURCE CASE ID": override });
    expect(shared.excludedTestCaseIds).toEqual(["PRIVATE EXCLUDED CASE ID"]);
    await database.pool.query("UPDATE guardrail_version SET policies=NULL WHERE guardrail_id='shared-guard'");
    expect((await asTenant("tenantB", () => service.getGuardrail("shared-guard"))).draftConfig.policyBindings[0]?.testCaseOverrides).toEqual({});
    await database.pool.query("UPDATE guardrail_version SET policies=$1 WHERE guardrail_id='shared-guard'", [JSON.stringify(nodes)]);
    await database.pool.query("DELETE FROM resource_share WHERE id='override-policy-share'");
    expect((await asTenant("tenantB", () => service.getGuardrail("shared-guard"))).draftConfig.policyBindings[0]?.testCaseOverrides).toEqual({});
    expect((await database.pool.query("SELECT draft_config FROM guardrail WHERE id='shared-guard'")).rows[0].draft_config).toEqual(draft);
  });
});
