import { completeReport, getReport } from "../db/report-test-utils.js";
// @vitest-environment node
import { generateKeyPairSync, sign } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { verifyArtifactDigest, type ArtifactContent } from "../domain/artifact-content.js";
import { buildGuardrailPlan } from "../domain/guardrail-plan.js";
import { DEFAULT_GUARDRAIL_ID, defaultGuardrailDraft } from "../domain/defaults.js";
import { buildPackage, parsePackage, type ParsedPackage } from "../domain/guardrail-package.js";
import type { ArtifactContent as Content } from "../domain/artifact-content.js";
import { testCases as testCaseTable } from "../db/schema.js";
import { emptyValidationMetrics, generatedTestCases } from "../domain/validation.js";
import { readZip, writeZip } from "../domain/zip.js";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { programmablePolicyDraftSchema } from "../policy-studio/model.js";
import { ControlPlaneService } from "./control-plane.js";
import { routingEventSchema } from "./traffic-routing.js";
import { emptyPolicyDefinition } from "../../shared/policy-definition.js";
import type { ValidationCaseResult } from "../domain/models.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
const catalogDir = resolve("../runner/toolkit/policy_library/assets");
const protoPath = resolve("../proto/tasklattice/guard/control/v1/runner_control.proto");

const STUDIO = "policy-studio-marker";
const studioDraft = programmablePolicyDraftSchema.parse({ guardrail_category: "content_safety", sources: [{ path: "main.co", content: "flow check $text\n  pass\n" }],
  rail_bindings: [{ rail_type: "input", flow_name: "check", execution_mode: "detect", on_unsafe: "block", risk_severity: "medium" }],
  test_cases: [{ name: "safe", rail_type: "input", content: "ordinary", expected_decision: "allow", covered_rule_ids: ["flow/input/check"], case_type: "input_rail" }] });
const studioBinding = { policyId: STUDIO, policyVersion: "1", action: null, parameterValues: {}, enabledRuleIds: ["flow/input/check"], ruleActions: {}, enabledRails: ["input" as const], reasoningPolicy: null };

/** The Policy nodes one parsed version uses, as buildPackage takes them. */
const nodesOf = (parsed: ParsedPackage, item: ParsedPackage["versions"][number]) => item.policies
  .map(ref => parsed.policies.find(node => node.id === ref.id && node.version === ref.version)!)
  .map(({ id, version, kind, definition }) => ({ id, version, kind, definition }));
const rebuilt = (parsed: ParsedPackage, item: ParsedPackage["versions"][number], content: Content = item.content) =>
  ({ content, config: item.config, testSuite: item.testSuite, policies: nodesOf(parsed, item) });

function keyPair(directory: string, name: string) {
  const pair = generateKeyPairSync("ed25519");
  const path = join(directory, `${name}.pem`);
  writeFileSync(path, pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  return { path, publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString() };
}

describe.skipIf(!url)("Guardrail release packages between isolated environments", () => {
  const keys = mkdtempSync(join(tmpdir(), "guard-packages-"));
  const uatArtifactKey = keyPair(keys, "uat-artifact");
  const prodArtifactKey = keyPair(keys, "prod-artifact");
  const environment = (artifactKey: string, extra: Record<string, string>) => loadConfig({
    NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!, CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
    CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: artifactKey, CONTROLLER_POLICY_CATALOG_DIR: catalogDir, CONTROLLER_PROTO_PATH: protoPath,
    BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters", ...extra,
  });
  if (!url) return;
  const uatConfig = environment(uatArtifactKey.path, {});
  const prodConfig = environment(prodArtifactKey.path, {});
  let uatDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let prodDb: Awaited<ReturnType<typeof createTestDatabase>>;
  let uat: ControlPlaneService;
  let prod: ControlPlaneService;
  let guardrailId: string;
  const published: string[] = [];

  async function seed(database: Awaited<ReturnType<typeof createTestDatabase>>) {
    await database.pool.query("INSERT INTO auth_user (id, name, email, role) VALUES ('admin', 'Admin', 'admin@example.test', 'admin')");
    await database.pool.query("INSERT INTO controller_state (id, desired_generation) VALUES ('singleton', 0)");
    await database.pool.query("INSERT INTO runner_pool (id, name) VALUES ('default', 'Default')");
  }

  /** Test, then publish exactly the tested candidate, as a Runner would. */
  async function testAndPublish(id: string, revision: number, record = true) {
    const run = await uat.requestValidation({ guardrailId: id, actorId: "admin", compilerAvailable: true });
    const { rows: [request] } = await uatDb.pool.query("SELECT payload FROM controller_outbox WHERE id = $1", [run.id]);
    const candidate: ArtifactContent = {
      guardrailId: id, guardrailVersion: run.guardrailVersion, compilerVersion: "tasklattice-nemo-config-v29-single-contract", nemoVersion: "0.24.0",
      runtimeProfile: "llmrails_colang1_standard", plan: request.payload.plan, configYaml: "models: []\n", colangContent: "",
      prompts: [], actionBindings: [], dependencyManifest: [["action", "GuardContentFilterAction", "1.0.0"]],
    };
    await completeReport(uat, { runId: run.id, status: "passed", metrics: emptyValidationMetrics(run.metrics.total), results: [], candidateArtifact: candidate,
      runtime: { runnerId: "uat-runner-0", runnerVersion: "1.0.0", nemoVersion: "0.24.0", modelRevisionId: "", compilerModelTypes: [] } });
    const version = await uat.requestGuardrailPublish({ guardrailId: id, actorId: "admin", expectedDraftRevision: revision });
    if (record) published.push(version.version);
    return version;
  }

  beforeAll(async () => {
    [uatDb, prodDb] = await Promise.all([createTestDatabase(url!, "guard_pkg_uat"), createTestDatabase(url!, "guard_pkg_prod")]);
    await Promise.all([seed(uatDb), seed(prodDb)]);
    uat = new ControlPlaneService(uatDb.db, uatConfig);
    prod = new ControlPlaneService(prodDb.db, prodConfig);
    const policies = PolicyCatalog.load(catalogDir).list();
    // A Policy Studio Policy published in UAT, bound next to catalog Policies.
    await uatDb.pool.query("INSERT INTO policy_record (id, name, owner, draft) VALUES ($1, 'Studio marker', 'uat', $2)", [STUDIO, studioDraft]);
    await uatDb.pool.query("INSERT INTO policy_validation_run (id, policy_id, draft_revision, status, created_by) VALUES ('studio-run', $1, 1, 'passed', 'admin')", [STUDIO]);
    await uat.publishPolicy({ id: STUDIO, actorId: "admin", expectedDraftRevision: 1 });
    const defaults = defaultGuardrailDraft(policies);
    const draft = { ...defaults, policyBindings: [...defaults.policyBindings, studioBinding] };
    const created = await uat.createGuardrail({ name: "Bank assistant", draftConfig: draft, runtimeProfile: "auto", actorId: "admin" });
    guardrailId = created.id;
    await testAndPublish(guardrailId, 1);
    await uat.updateGuardrail({ id: guardrailId, actorId: "admin", draftConfig: { ...draft, policyBindings: draft.policyBindings.slice(1) }, expectedDraftRevision: 1 });
    await testAndPublish(guardrailId, 2);
  });
  afterAll(async () => {
    await uatDb?.drop();
    await prodDb?.drop();
    rmSync(keys, { recursive: true, force: true });
  });

  it("starts production with the same features as UAT: a complete bundled Default baseline without model configuration", async () => {
    await prod.initialize();
    const defaultId = (await prodDb.pool.query("SELECT guardrail_id FROM deployment_preset")).rows[0].guardrail_id;
    // A platform release does not claim that installation tests have passed.
    expect((await prodDb.pool.query("SELECT origin FROM guardrail WHERE id = $1", [defaultId])).rows).toEqual([{ origin: "local" }]);
    expect((await prod.getGuardrail(defaultId)).readiness).toBe("ready");
    expect((await prodDb.pool.query("SELECT validation_run_id, publication FROM guardrail_version WHERE guardrail_id=$1", [defaultId])).rows[0])
      .toMatchObject({ validation_run_id: null, publication: { source: "deployment" } });
    await prod.initialize();
    expect((await prodDb.pool.query("SELECT count(*)::int AS count FROM guardrail_version WHERE guardrail_id=$1", [defaultId])).rows[0].count).toBe(1);
    expect((await prod.listPolicies()).map(p => p.id)).toEqual(expect.arrayContaining(["builtin-jailbreak", "builtin-content-safety"]));
    expect(await prod.requiredPlatformModelBindings()).toEqual([]);
    const updated = await prod.getGuardrail(defaultId);
    expect(updated.draftConfig.policyBindings).toHaveLength(12);
    expect((await prodDb.pool.query("SELECT jsonb_array_length(test_suite) AS count FROM guardrail_version WHERE guardrail_id=$1", [defaultId])).rows[0].count).toBe(748);
  });

  it("requires models only for enabled routed targets, not historical versions or disabled routes", async () => {
    const catalog = PolicyCatalog.load(catalogDir).list();
    const policy = catalog.find(p => p.id === "builtin-content-safety")!;
    const draft = { ...defaultGuardrailDraft(catalog), policyBindings: [{ policyId: policy.id, policyVersion: policy.version,
      action: null, parameterValues: {}, enabledRuleIds: policy.rules.map(r => r.id), ruleActions: {}, enabledRails: [...policy.rails], reasoningPolicy: null }] };
    await prodDb.pool.query("INSERT INTO guardrail (id,name,draft_config,status) VALUES ('opt-in','Opt-in',$1,'active')", [draft]);
    const plan = buildGuardrailPlan({ guardrailId: "opt-in", guardrailVersion: "v1", draft, policies: catalog });
    await prodDb.pool.query("INSERT INTO guardrail_artifact (id,guardrail_id,guardrail_version,generation,compiler_version,nemo_version,runtime_profile,plan,config_yaml,checksum,signature) VALUES ('opt-in-artifact','opt-in','v1',1,'test','test','auto',$1,'','opt-in-checksum','test')", [plan]);
    expect(await prod.requiredPlatformModelBindings()).toEqual([]);
    const route = { id: "r", name: "Fallback", kind: "fallback", enabled: true, selector: { expression: { combinator: "and", conditions: [] } },
      targets: [{ id: "t", guardrailId: "opt-in", guardrailVersion: "v1", weightBps: 10000 }] };
    await prodDb.pool.query("INSERT INTO traffic_router (id,name,draft,active_snapshot,active_revision) VALUES ('health-router','Health',$1,$1,1)", [{ routes: [route] }]);
    expect(await prod.requiredPlatformModelBindings()).toEqual(["content_safety.input", "content_safety.output"]);
    for (const changed of [{ ...route, enabled: false }, { ...route, targets: [{ ...route.targets[0]!, weightBps: 0 }] },
      { ...route, targets: [{ ...route.targets[0]!, guardrailVersion: "v2" }] }]) {
      await prodDb.pool.query("UPDATE traffic_router SET active_snapshot=$1 WHERE id='health-router'", [{ routes: [changed] }]);
      expect(await prod.requiredPlatformModelBindings()).toEqual([]);
    }
    await prodDb.pool.query("UPDATE traffic_router SET active_snapshot=$1 WHERE id='health-router'", [{ routes: [route] }]);
    await prodDb.pool.query("UPDATE guardrail SET status='disabled' WHERE id='opt-in'");
    expect(await prod.requiredPlatformModelBindings()).toEqual([]);
    await prodDb.pool.query("DELETE FROM traffic_router WHERE id='health-router'");
    await prodDb.pool.query("DELETE FROM guardrail_artifact WHERE id='opt-in-artifact'");
    await prodDb.pool.query("DELETE FROM guardrail WHERE id='opt-in'");
  });

  it("exports the resource tree: byte-identical, deterministic, every Policy version as a leaf", async () => {
    const first = await uat.packages.exportPackage(guardrailId, published);
    const second = await uat.packages.exportPackage(guardrailId, published);
    const filesOf = (bytes: Buffer) => [...readZip(bytes, { maxEntries: 1024, maxEntryBytes: 1 << 24, maxTotalBytes: 1 << 26 })].filter(([path]) => path.startsWith("guardrails/") || path.startsWith("policies/"));
    expect(filesOf(first.bytes)).toEqual(filesOf(second.bytes));
    const paths = filesOf(first.bytes).map(([path]) => path);
    expect(paths.filter(path => path.startsWith("guardrails/")).sort()).toEqual([
      `guardrails/${guardrailId}/guardrail.json`,
      ...published.flatMap(version => ["artifact", "requirements", "test-suite", "version"].map(file => `guardrails/${guardrailId}/versions/${version}/${file}.json`)),
    ].sort());
    expect(paths).toContain(`policies/${STUDIO}/1/policy.json`);
    const parsed = parsePackage(first.bytes);
    expect(parsed.manifest).toMatchObject({ source: { id: "tasklattice-guard" }, guardrail: { id: guardrailId, name: "Bank assistant" } });
    expect(parsed.manifest).not.toHaveProperty("recommendedVersion");
    // A Policy Studio leaf is the Library's own immutable version; catalog leaves are frozen definitions.
    const { rows: [studio] } = await uatDb.pool.query("SELECT snapshot FROM policy_version WHERE policy_id = $1 AND version = 1", [STUDIO]);
    expect(parsed.policies.find(node => node.id === STUDIO)).toMatchObject({ kind: "programmable", version: "1", definition: studio.snapshot });
    expect(parsed.policies.filter(node => node.kind === "catalog").length).toBe(parsed.policies.length - 1);
    // v1 binds one more catalog Policy than v2; each leaf appears once.
    expect(parsed.versions[0]!.policies.length).toBe(parsed.versions[1]!.policies.length + 1);
    expect(parsed.policies.length).toBe(parsed.versions[0]!.policies.length);
    // Each version carries the suite it was published with; the UAT report stays in UAT.
    const { rows: [stored] } = await uatDb.pool.query("SELECT test_suite FROM guardrail_version WHERE version = $1", [published[0]]);
    expect(parsed.versions[0]!.testSuite).toEqual(stored.test_suite);
    expect(JSON.stringify(parsed)).not.toMatch(/uat-runner-0|resultsDigest/);
  });

  it("keeps model costs and global prices out of exported resource files", async () => {
    const before = readZip((await uat.packages.exportPackage(guardrailId, published)).bytes, { maxEntries: 1024, maxEntryBytes: 1 << 24, maxTotalBytes: 1 << 26 });
    await uatDb.pool.query("INSERT INTO model_usage_cost(id,event_id,guardrail_id,model,provider,source,occurred_at,currency,amount,reason) VALUES ('export-cost','export-cost',$1,'cost-model-marker','cost-provider-marker','runtime',now(),'USD',0.123456,'priced')", [guardrailId]);
    await uatDb.pool.query("INSERT INTO model_price_revision(id,key,source,rates) VALUES ('export-price','price-marker','manual',$1)", [JSON.stringify({ unit: "free", currency: "USD" })]);
    const after = readZip((await uat.packages.exportPackage(guardrailId, published)).bytes, { maxEntries: 1024, maxEntryBytes: 1 << 24, maxTotalBytes: 1 << 26 });
    const resources = (files: typeof before) => [...files].filter(([path]) => path.startsWith("guardrails/") || path.startsWith("policies/"));
    expect(resources(after)).toEqual(resources(before));
    expect([...after.values()].map(bytes => bytes.toString("utf8")).join("\n")).not.toMatch(/cost-model-marker|cost-provider-marker|price-marker/);
  });

  it("exports immutable content without local test evidence or release prerequisites", async () => {
    const { rows: [before] } = await uatDb.pool.query("SELECT status, validation_run_id, released_at FROM guardrail_version WHERE guardrail_id=$1 AND version=$2", [guardrailId, published[0]]);
    await uatDb.pool.query("UPDATE guardrail_version SET status='pending', validation_run_id=NULL, released_at=NULL WHERE guardrail_id=$1 AND version=$2", [guardrailId, published[0]]);
    try {
      const parsed = parsePackage((await uat.packages.exportPackage(guardrailId, [published[0]!])).bytes);
      expect(parsed.manifest.schemaVersion).toBe(4);
      expect(parsed.signatures).toEqual([]);
      expect(parsed.versions).toHaveLength(1);
      const preview = await uat.packages.inspectUpload((await uat.packages.exportPackage(guardrailId, [published[0]!])).bytes, "admin");
      expect(preview.blockers).toEqual([]);
      expect(preview.versions[0]?.state).toBe("existing");
      expect(await uat.packages.importPackage(preview.packageId, { actorId: "admin" })).toMatchObject({ imported: [], existing: [published[0]] });
    } finally {
      await uatDb.pool.query("UPDATE guardrail_version SET status=$3, validation_run_id=$4, released_at=$5 WHERE guardrail_id=$1 AND version=$2", [guardrailId, published[0], before.status, before.validation_run_id, before.released_at]);
    }
  });

  it("imports released versions as they are, preserving digests but signing locally", async () => {
    const { bytes } = await uat.packages.exportPackage(guardrailId, published);
    const preview = await prod.packages.inspectUpload(bytes, "admin");
    expect(preview).toMatchObject({ source: { id: "tasklattice-guard" }, keyId: null, guardrail: { id: guardrailId, exists: false }, blockers: [] });
    expect(preview.versions.map(item => [item.version, item.state, item.environment?.status])).toEqual(published.map(version => [version, "new", undefined]));

    // Leaves first: the Studio Policy is new here; catalog Policies this installation ships are already here.
    expect(preview.policies.filter(node => node.state === "new").map(node => node.id)).toEqual([STUDIO]);
    expect(preview.policies.filter(node => node.kind === "catalog").every(node => node.state === "existing")).toBe(true);
    const result = await prod.packages.importPackage(preview.packageId, { actorId: "admin" });
    expect(result).toMatchObject({ guardrailId, imported: published, existing: [], policies: { imported: [`${STUDIO}@1`] } });
    expect(result.policies.existing.length).toBe(preview.policies.length - 1);
    expect(parsePackage((await prod.packages.exportPackage(guardrailId, published)).bytes).versions.map(item => item.version)).toEqual(published);

    const uatArtifacts = (await uatDb.pool.query("SELECT guardrail_version, checksum, signature, generation FROM guardrail_artifact WHERE guardrail_id = $1 ORDER BY guardrail_version", [guardrailId])).rows;
    const prodArtifacts = (await prodDb.pool.query("SELECT guardrail_version, checksum, signature, generation, content_digest_version FROM guardrail_artifact WHERE guardrail_id = $1 ORDER BY guardrail_version", [guardrailId])).rows;
    expect(prodArtifacts.map(row => row.checksum)).toEqual(uatArtifacts.map(row => row.checksum));
    for (const [index, row] of prodArtifacts.entries()) {
      expect(row.signature).not.toBe(uatArtifacts[index].signature);
      expect(verifyArtifactDigest(row.checksum, row.signature, prodArtifactKey.publicKeyPem)).toBe(true);
      expect(row.content_digest_version).toBe(2);
    }
    const { rows: [guardrail] } = await prodDb.pool.query("SELECT origin, source_id, status FROM guardrail WHERE id = $1", [guardrailId]);
    // Nothing imported is usable yet: each version waits to be tested and released here.
    expect(guardrail).toEqual({ origin: "imported", source_id: "tasklattice-guard", status: "draft" });
    expect((await prodDb.pool.query("SELECT DISTINCT status FROM guardrail_version WHERE guardrail_id = $1", [guardrailId])).rows).toEqual([{ status: "pending" }]);
    const { rows: provenance } = await prodDb.pool.query("SELECT version, source_id, source_key_id FROM guardrail_version_provenance ORDER BY version");
    expect(provenance).toEqual(published.map(version => ({ version, source_id: "tasklattice-guard", source_key_id: null })));
    const { rows: suites } = await prodDb.pool.query("SELECT v.test_suite AS prod, v.inspection->'testSuite'->>'total' AS total FROM guardrail_version v WHERE v.guardrail_id = $1 ORDER BY v.version", [guardrailId]);
    expect(suites.map(row => row.prod.length)).toEqual(suites.map(row => Number(row.total)));
    // Import neither distributes nor routes anything, and creates no test or compile work.
    expect((await prodDb.pool.query("SELECT kind FROM controller_outbox WHERE aggregate_id = $1", [guardrailId])).rows).toEqual([]);
    expect((await prodDb.pool.query("SELECT count(*)::int AS n FROM guardrail_validation_run WHERE guardrail_id = $1", [guardrailId])).rows[0].n).toBe(0);
    // Provenance stays recorded; administrators can maintain an imported draft.
    expect((await prodDb.pool.query("SELECT id, origin, source_id FROM policy_record")).rows).toEqual([{ id: STUDIO, origin: "imported", source_id: "tasklattice-guard" }]);
    const checksums = async (db: typeof uatDb) => (await db.pool.query("SELECT checksum FROM policy_version WHERE policy_id = $1", [STUDIO])).rows;
    expect(await checksums(prodDb)).toEqual(await checksums(uatDb));
    expect((await prodDb.pool.query("SELECT count(*)::int AS n FROM policy_imported_version")).rows[0].n).toBe(0);
    expect((await prod.listPolicies()).find(policy => policy.id === STUDIO)).toMatchObject({ version: "1", origin: "imported", source_id: "tasklattice-guard" });
    await prod.updatePolicy({ id: STUDIO, name: "Renamed", actorId: "admin" });
    expect((await prodDb.pool.query("SELECT name FROM policy_record WHERE id=$1", [STUDIO])).rows).toEqual([{ name: "Renamed" }]);
    expect(await checksums(prodDb)).toEqual(await checksums(uatDb));
    await expect(prod.publishPolicy({ id: STUDIO, actorId: "admin" })).rejects.toMatchObject({ code: "policy_validation_required" });
    await expect(prod.deletePolicy({ id: STUDIO, actorId: "admin" })).rejects.toMatchObject({ code: "policy_in_use" });
    // Each version keeps the Policy nodes it was built from.
    expect((await prodDb.pool.query("SELECT jsonb_array_length(policies) AS n FROM guardrail_version WHERE guardrail_id = $1 ORDER BY version", [guardrailId])).rows.map(row => row.n))
      .toEqual((await uatDb.pool.query("SELECT jsonb_array_length(policies) AS n FROM guardrail_version WHERE guardrail_id = $1 ORDER BY version", [guardrailId])).rows.map(row => row.n));
    const desired = await prod.desiredStateForPool("default");
    expect(desired.artifacts.filter(item => item.guardrailId === guardrailId)).toEqual([]);
  });

  it("treats re-uploads and subsets as already present, and keeps Latest", async () => {
    const all = await uat.packages.exportPackage(guardrailId, published);
    const again = await prod.packages.inspectUpload(all.bytes, "admin");
    expect(again.versions.map(item => item.state)).toEqual(["existing", "existing"]);
    expect(await prod.packages.importPackage(again.packageId, { actorId: "admin" })).toMatchObject({ imported: [], existing: published });
    const subset = await uat.packages.exportPackage(guardrailId, [published[0]!]);
    const preview = await prod.packages.inspectUpload(subset.bytes, "admin");
    expect(await prod.packages.importPackage(preview.packageId, { actorId: "admin" })).toMatchObject({ imported: [], existing: [published[0]] });
  });

  it("rejects the whole batch when one version number carries different content", async () => {
    const parsed = parsePackage((await uat.packages.exportPackage(guardrailId, published)).bytes);
    const altered = parsed.versions.map(item => item.version === published[1] ? { ...item, content: { ...item.content, configYaml: "models: [] # changed\n" } } : item);
    const bytes = buildPackage({
      source: parsed.manifest.source, guardrail: parsed.manifest.guardrail, exportedAt: new Date(),
      versions: altered.map(item => rebuilt(parsed, item)),
    });
    const before = (await prodDb.pool.query("SELECT count(*)::int AS n FROM guardrail_version")).rows[0].n;
    const preview = await prod.packages.inspectUpload(bytes, "admin");
    expect(preview.versions.map(item => item.state)).toEqual(["existing", "conflict"]);
    expect(preview.blockers.map(item => item.code)).toEqual(["guardrail_version_conflict"]);
    await expect(prod.packages.importPackage(preview.packageId, { actorId: "admin" })).rejects.toMatchObject({ code: "guardrail_version_conflict" });
    expect((await prodDb.pool.query("SELECT count(*)::int AS n FROM guardrail_version")).rows[0].n).toBe(before);
  });

  it.each([
    ["a tampered byte", (bytes: Buffer) => { const files = readZip(bytes, { maxEntries: 1024, maxEntryBytes: 1 << 24, maxTotalBytes: 1 << 26 }); const path = [...files.keys()].find(item => item.endsWith("artifact.json"))!; files.set(path, Buffer.from(files.get(path)!.toString().replace("models: []", "models: [ ]"))); return writeZip(files); }, "guardrail_package_digest_mismatch"],
    ["an undeclared file", (bytes: Buffer) => { const files = readZip(bytes, { maxEntries: 1024, maxEntryBytes: 1 << 24, maxTotalBytes: 1 << 26 }); files.set("versions/extra.json", Buffer.from("{}\n")); return writeZip(files); }, "guardrail_package_undeclared_content"],
  ] as const)("rejects %s", async (_name, mutate, code) => {
    const { bytes } = await uat.packages.exportPackage(guardrailId, published);
    await expect(prod.packages.inspectUpload(mutate(bytes), "admin")).rejects.toMatchObject({ code });
  });

  it("accepts legacy signed packages without configuring keys, sources or Runner checks", async () => {
    const parsed = parsePackage((await uat.packages.exportPackage(guardrailId, published)).bytes);
    const pair = generateKeyPairSync("ed25519");
    const bytes = buildPackage({ source: { id: "arbitrary-source", name: "Legacy exporter" }, guardrail: parsed.manifest.guardrail,
      exportedAt: new Date(), versions: parsed.versions.map(item => rebuilt(parsed, item)),
      sign: manifest => [{ keyId: "legacy-key", algorithm: "ed25519", signature: sign(null, manifest, pair.privateKey).toString("base64") }] });
    expect(parsePackage(bytes).manifest.schemaVersion).toBe(3);
    let admissions = 0;
    prod.packages.setArtifactAdmission(async () => { admissions++; throw new Error("No Runner configured"); });
    const preview = await prod.packages.inspectUpload(bytes, "admin");
    expect(preview.blockers).toEqual([]);
    expect(preview.keyId).toBeNull(); // No claim that legacy signatures were authenticated.
    expect(await prod.packages.importPackage(preview.packageId, { actorId: "admin" })).toMatchObject({ imported: [], existing: published });
    expect(admissions).toBe(0);
    prod.packages.setArtifactAdmission(async () => []);
    // The same package also round-trips to the original, locally owned resource.
    const own = await uat.packages.inspectUpload(bytes, "admin");
    expect(own.blockers).toEqual([]);
    expect(await uat.packages.importPackage(own.packageId, { actorId: "admin" })).toMatchObject({ imported: [], existing: published });
  });

  it("serializes concurrent imports of the same package", async () => {
    const third = await uat.updateGuardrail({ id: guardrailId, actorId: "admin", draftConfig: { ...(await uat.getGuardrail(guardrailId)).draftConfig, safetyLevel: "strict" }, expectedDraftRevision: 2 });
    await testAndPublish(guardrailId, third.draftRevision);
    const { bytes } = await uat.packages.exportPackage(guardrailId, [published.at(-1)!]);
    const preview = await prod.packages.inspectUpload(bytes, "admin");
    const results = await Promise.all([1, 2, 3].map(() => prod.packages.importPackage(preview.packageId, { actorId: "admin" })));
    expect(results.map(item => item.imported.length).sort()).toEqual([0, 0, 1]);
    expect((await prodDb.pool.query("SELECT count(*)::int AS n FROM guardrail_version WHERE version = $1", [published.at(-1)])).rows[0].n).toBe(1);
  });

  /** Run a version's own suite here and record the Runner's verdict, as the control channel would. */
  async function testHere(id: string, version: string, status: "passed" | "failed") {
    const run = await prod.requestVersionTestRun({ guardrailId: id, version, actorId: "admin" });
    await completeReport(prod, { runId: run.id, status, metrics: emptyValidationMetrics(run.metrics.total), results: [] });
    return run;
  }

  it("publishes imported content independently of its untested, failed and passed outcomes", async () => {
    const version = published[1]!;
    await expect(prod.releaseGuardrailVersion({ guardrailId, version, actorId: "admin" })).resolves.toMatchObject({ status: "ready", validationRunId: null });
    await testHere(guardrailId, version, "failed");
    await expect(prod.releaseGuardrailVersion({ guardrailId, version, actorId: "admin" })).resolves.toMatchObject({ status: "ready", validationRunId: null });
    const passed = await testHere(guardrailId, version, "passed");
    const released = await prod.releaseGuardrailVersion({ guardrailId, version, actorId: "admin" });
    // Same version number and content; tests do not replace publication provenance.
    expect(released).toMatchObject({ version, status: "ready", validationRunId: null, releasedBy: "admin" });
    // Testing a frozen version does not mark its independent working draft as tested.
    expect((await prod.getGuardrail(guardrailId)).latestValidationRun).toBeNull();
    expect((await prod.getGuardrail(guardrailId)).latestTestingReport).toMatchObject({ id: passed.id, status: "passed" });
    expect((await prod.getGuardrail(guardrailId)).hasUnpublishedChanges).toBe(false);
    expect((await prodDb.pool.query("SELECT status FROM guardrail WHERE id = $1", [guardrailId])).rows[0].status).toBe("active");
    const { rows: [audit] } = await prodDb.pool.query("SELECT detail FROM audit_event WHERE kind = 'guardrail.version_released'");
    expect(audit.detail).toMatchObject({ version, testsRequired: false, origin: "imported" });
    // A later failure does not revoke the release.
    await testHere(guardrailId, version, "failed");
    expect((await prodDb.pool.query("SELECT status FROM guardrail_version WHERE guardrail_id = $1 AND version = $2", [guardrailId, version])).rows[0].status).toBe("ready");
  });

  it("routes an imported version only after Runners here confirm they can load it", async () => {
    await prodDb.pool.query("INSERT INTO auth_user (id, name, email, role) VALUES ('approver', 'Approver', 'approver@example.test', 'admin')");
    const version = published[1]!;
    const router = await prod.trafficRouting.create("Bank traffic", "", { routes: [{ id: "fallback", name: "Fallback", kind: "fallback", enabled: true,
      selector: { expression: { combinator: "and", conditions: [] } },
      targets: [{ id: "target", guardrailId, guardrailVersion: version, weightBps: 10000 }] }] }, "admin");
    const submit = async () => {
      const review = await prod.trafficRouting.preview(router.id, 1);
      await prod.packages.checkRoutedImports(review.snapshot);
      return prod.trafficRouting.submitChange(router.id, { expectedDraftRevision: 1, reviewedSnapshot: review.snapshot, reviewedEndpointIds: review.endpointIds, reason: "CR-1", ticket: "CR-1" }, "admin");
    };
    // No Runner answered: not yet a verdict, so traffic cannot move.
    await expect(submit()).rejects.toMatchObject({ code: "guardrail_version_environment_unverified", detail: { environment: { status: "pending" } } });
    // A Runner that cannot serve the content blocks it with the reason.
    const answer = (admitted: boolean) => async () => [{ poolId: "default", runnerId: "prod-runner-0", admitted, unavailable: false,
      reason: admitted ? "" : "NeMo Action providers are unavailable for: GuardContentFilterAction@1.0.0.", nemoVersion: "0.24.0", modelRevisionId: "" }];
    prod.setArtifactAdmission(answer(false));
    await expect(submit()).rejects.toMatchObject({ code: "guardrail_version_environment_unverified", detail: { environment: { status: "missing" } } });
    const { rows: [stored] } = await prodDb.pool.query("SELECT environment_check FROM guardrail_version WHERE version = $1", [version]);
    expect(stored.environment_check.pools[0].reason).toContain("GuardContentFilterAction");

    prod.setArtifactAdmission(answer(true));
    const generation = await prod.desiredGeneration();
    const change = await submit();
    // Passing the load check lets the default pool hold the version, so it can
    // be tried in Playground before any Router serves it.
    expect(await prod.desiredGeneration()).toBe(generation + 1);
    expect((await prod.desiredStateForPool("default")).artifacts.filter(item => item.guardrailId === guardrailId).map(item => item.guardrailVersion)).toEqual([version]);
    await prod.packages.checkRoutedImports(change.snapshot);
    await prod.trafficRouting.approveChange(router.id, change.id, "approver", {});
    const desired = await prod.desiredStateForPool("default");
    expect(desired.artifacts.filter(item => item.guardrailId === guardrailId).map(item => [item.guardrailVersion, item.checksum])).toEqual([[version, expect.stringMatching(/^[0-9a-f]{64}$/)]]);
    // What a published Router pins is delivered whatever its row says: Runners
    // reject a desired state with a missing target, which would stop all traffic.
    const { rows: [release] } = await prodDb.pool.query("SELECT released_at, validation_run_id FROM guardrail_version WHERE guardrail_id = $1 AND version = $2", [guardrailId, version]);
    await prodDb.pool.query("UPDATE guardrail_version SET status = 'pending', released_at = NULL WHERE guardrail_id = $1 AND version = $2", [guardrailId, version]);
    expect((await prod.desiredStateForPool("default")).artifacts.filter(item => item.guardrailId === guardrailId).map(item => item.guardrailVersion)).toEqual([version]);
    await prodDb.pool.query("UPDATE guardrail_version SET status = 'ready', released_at = $3, validation_run_id = $4 WHERE guardrail_id = $1 AND version = $2", [guardrailId, version, release.released_at, release.validation_run_id]);

  });

  it("imports Default versions through the ordinary local test and release workflow", async () => {
    const defaultId = (await prodDb.pool.query("SELECT guardrail_id FROM deployment_preset")).rows[0].guardrail_id;
    const parsed = parsePackage((await uat.packages.exportPackage(guardrailId, [published[0]!])).bytes);
    const versions = parsed.versions.map(item => rebuilt(parsed, item, { ...item.content, guardrailId: defaultId, plan: { ...item.content.plan, guardrail_id: defaultId } }));
    const bytes = buildPackage({ source: { id: "bank-uat-system", name: "UAT system baseline" }, guardrail: { id: defaultId, name: "Default Guardrail" },
      exportedAt: new Date(), versions });
    const preview = await prod.packages.inspectUpload(bytes, "admin");
    expect(preview.blockers).toEqual([]);
    await prod.packages.importPackage(preview.packageId, { actorId: "admin" });
    // An authorized source adds a version to the local Default; import alone never changes basic protection.
    expect((await prodDb.pool.query("SELECT origin FROM guardrail WHERE id = $1", [defaultId])).rows).toEqual([{ origin: "local" }]);
    expect((await prodDb.pool.query("SELECT origin FROM guardrail_version WHERE guardrail_id = $1 AND version = $2", [defaultId, published[0]])).rows).toEqual([{ origin: "imported" }]);
    const before = await prod.desiredStateForPool("default");
    await testHere(defaultId, published[0]!, "passed");
    await prod.releaseGuardrailVersion({ guardrailId: defaultId, version: published[0]!, actorId: "admin" });

    expect((await prod.desiredStateForPool("default")).artifacts).toEqual(before.artifacts);
    await prod.packages.checkVersionEnvironment(defaultId, published[0]!);
    const after = await prod.desiredStateForPool("default");
    expect(after.artifacts.length).toBe(before.artifacts.length + 1);
    expect(after.artifacts.some(item => item.guardrailId === defaultId && item.guardrailVersion === published[0])).toBe(true);
  });

  /** Another installation whose catalog differs in one Policy, with its own database. */
  async function installationWith(name: string, edit: (policy: Record<string, unknown>) => void) {
    const dir = mkdtempSync(join(tmpdir(), `guard-catalog-${name}-`));
    cpSync(catalogDir, dir, { recursive: true });
    const file = join(dir, "focused_policies.json");
    const items = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
    edit(items.find(item => item.id === "local-network-addresses")!);
    writeFileSync(file, JSON.stringify(items));
    const database = await createTestDatabase(url!, `guard_pkg_${name}`);
    await seed(database);
    const service = new ControlPlaneService(database.db, environment(prodArtifactKey.path, { CONTROLLER_POLICY_CATALOG_DIR: dir }));
    return { database, service, cleanup: async () => { await database.drop(); rmSync(dir, { recursive: true, force: true }); } };
  }

  it("keeps a catalog version this installation no longer ships as a read-only version of that Policy", async () => {
    const importedVersion = PolicyCatalog.load(catalogDir).get("local-network-addresses")!.version;
    const next = await installationWith("next", policy => { policy.version = "2.1.0"; });
    try {
      const { bytes } = await uat.packages.exportPackage(guardrailId, [published[0]!]);
      const preview = await next.service.packages.inspectUpload(bytes, "admin");
      expect(preview.policies.find(node => node.id === "local-network-addresses")).toMatchObject({ version: importedVersion, state: "new" });
      await next.service.packages.importPackage(preview.packageId, { actorId: "admin" });
      const { rows } = await next.database.pool.query("SELECT policy_id, version, source_id FROM policy_imported_version");
      expect(rows).toEqual([{ policy_id: "local-network-addresses", version: importedVersion, source_id: "tasklattice-guard" }]);
      // The Library lists the shipped version, with the imported one as a pinned, read-only version.
      const policy = (await next.service.listPolicies()).find(item => item.id === "local-network-addresses")!;
      expect(policy.version).toBe("2.1.0");
      expect(policy.published_versions?.find(item => item.version === importedVersion)).toMatchObject({ origin: "imported", source_id: "tasklattice-guard" });
      expect((await next.service.getPolicy("local-network-addresses")).published_versions?.some(item => item.version === importedVersion)).toBe(true);
      // Importing it again finds it already here.
      expect((await next.service.packages.inspectUpload(bytes, "admin")).policies.every(node => node.state === "existing")).toBe(true);
    } finally {
      await next.cleanup();
    }
  });

  it("refuses to change a Policy version or take over a Policy that exists here, and writes nothing", async () => {
    const diverged = await installationWith("diverged", policy => { policy.description = "Edited in this installation"; });
    try {
      await diverged.database.pool.query("INSERT INTO policy_record (id, name, owner, draft) VALUES ($1, 'Local namesake', 'prod', $2)", [STUDIO, studioDraft]);
      const { bytes } = await uat.packages.exportPackage(guardrailId, published);
      const preview = await diverged.service.packages.inspectUpload(bytes, "admin");
      expect(preview.policies.find(node => node.id === "local-network-addresses")!.state).toBe("conflict");
      expect(preview.policies.find(node => node.id === STUDIO)!.state).toBe("new");
      expect(new Set(preview.blockers.map(item => item.code))).toEqual(new Set(["policy_version_conflict"]));
      await expect(diverged.service.packages.importPackage(preview.packageId, { actorId: "admin" })).rejects.toMatchObject({ code: expect.stringMatching(/^policy_(version|ownership)_conflict$/) });
      for (const table of ["guardrail_version", "policy_version", "policy_imported_version"]) {
        expect((await diverged.database.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, table).toBe(0);
      }
    } finally {
      await diverged.cleanup();
    }
  });

  it("adds versions to locally created resources without replacing either working draft", async () => {
    const database = await createTestDatabase(url!, "guard_pkg_local_append");
    try {
      await seed(database);
      const service = new ControlPlaneService(database.db, prodConfig);
      const local = await service.createGuardrail({ name: "Keep my local draft", draftConfig: defaultGuardrailDraft(PolicyCatalog.load(catalogDir).list()), runtimeProfile: "auto", actorId: "admin" });
      await database.pool.query("INSERT INTO policy_record (id, name, owner, draft) VALUES ($1, 'Keep my local Policy draft', 'local', $2)", [STUDIO, studioDraft]);
      const beforeGuardrail = (await database.pool.query("SELECT name, origin, draft_config, draft_revision FROM guardrail WHERE id=$1", [local.id])).rows[0];
      const beforePolicy = (await database.pool.query("SELECT name, origin, draft, draft_revision FROM policy_record WHERE id=$1", [STUDIO])).rows[0];
      const parsed = parsePackage((await uat.packages.exportPackage(guardrailId, [published[0]!])).bytes);
      const bytes = buildPackage({ source: { id: "another-source", name: "Another source" }, guardrail: { id: local.id, name: "Imported label" }, exportedAt: new Date(),
        versions: parsed.versions.map(item => rebuilt(parsed, item, { ...item.content, guardrailId: local.id, plan: { ...item.content.plan, guardrail_id: local.id } })) });
      const preview = await service.packages.inspectUpload(bytes, "admin");
      expect(preview.blockers).toEqual([]);
      expect(await service.packages.importPackage(preview.packageId, { actorId: "admin" })).toMatchObject({ imported: [published[0]], policies: { imported: [`${STUDIO}@1`] } });
      expect((await database.pool.query("SELECT name, origin, draft_config, draft_revision FROM guardrail WHERE id=$1", [local.id])).rows[0]).toEqual(beforeGuardrail);
      expect((await database.pool.query("SELECT name, origin, draft, draft_revision FROM policy_record WHERE id=$1", [STUDIO])).rows[0]).toEqual(beforePolicy);
      const roundTrip = await service.packages.inspectUpload((await service.packages.exportPackage(local.id, [published[0]!])).bytes, "admin");
      expect(roundTrip.blockers).toEqual([]);
      expect(roundTrip.versions[0]?.state).toBe("existing");
    } finally { await database.drop(); }
  });

  it("never deletes a Policy that a Guardrail version was built from", async () => {
    await expect(uat.deletePolicy({ id: STUDIO, actorId: "admin" })).rejects.toMatchObject({ code: "policy_in_use" });
  });

  it("imports an editable draft from the selected version, then edits, tests, publishes, copies and exports normally", async () => {
    const next = await installationWith("authoring", policy => { policy.version = "2.1.0"; });
    const { database, service } = next;
    try {
      const bytes = (await uat.packages.exportPackage(guardrailId, published.slice(0, 2))).bytes;
      const parsed = parsePackage(bytes);
      const chosen = parsed.versions.find(item => item.version === published[0])!;
      const preview = await service.packages.inspectUpload(bytes, "admin");
      await service.packages.importPackage(preview.packageId, { versions: [chosen.version], actorId: "admin" });
      const original = await service.getGuardrail(guardrailId);
      expect(original).toMatchObject({ origin: "imported", draftRevision: 1, draftConfig: chosen.config.draftConfig, testCaseCount: chosen.testSuite.length });
      expect(original.versions[0]!.hasSourceSnapshot).toBe(true);
      const frozen = (await database.pool.query("SELECT plan, test_suite, inspection FROM guardrail_version WHERE guardrail_id=$1", [guardrailId])).rows;
      // The pinned imported catalog node is usable even when the local shipped version differs.
      const candidate = await service.playgroundDraftCandidate(guardrailId);
      expect(candidate.plan).toBeTruthy();
      await service.previewGuardrailPlan({ draftConfig: original.draftConfig, runtimeProfile: original.runtimeProfile });
      const run = await service.requestVersionTestRun({ guardrailId, version: chosen.version, actorId: "admin" });
      await completeReport(service, { runId: run.id, status: "passed", metrics: emptyValidationMetrics(run.metrics.total), results: [] });
      await service.releaseGuardrailVersion({ guardrailId, version: chosen.version, actorId: "admin" });
      expect((await service.getGuardrail(guardrailId)).hasUnpublishedChanges).toBe(false);
      const copiedVersion = await service.duplicateGuardrail({ id: guardrailId, name: "Copy imported version", sourceVersion: chosen.version, idempotencyKey: "imported-version", actorId: "admin" });
      expect(copiedVersion.testCaseCount).toBe(chosen.testSuite.length);

      // Editing bindings regenerates draft cases using the pinned imported Policy, not the shipped one.
      const bindings = original.draftConfig.policyBindings;
      const edited = await service.updateGuardrail({ id: guardrailId, expectedDraftRevision: 1, actorId: "admin",
        draftConfig: { ...original.draftConfig, policyBindings: [bindings[1]!, bindings[0]!, ...bindings.slice(2)] } });
      expect(edited).toMatchObject({ draftRevision: 2, hasUnpublishedChanges: true });
      const restored = await service.discardGuardrailDraft({ id: guardrailId, expectedDraftRevision: 2, expectedBaselineVersion: chosen.version, actorId: "admin" });
      expect(restored).toMatchObject({ draftRevision: 3, hasUnpublishedChanges: false, draftConfig: original.draftConfig });
      const custom = await service.createTestCase({ guardrailId, actorId: "admin", name: "Local case", policyId: bindings[0]!.policyId,
        phase: "input", content: "ordinary", expectedDecision: "allow", trustedInstruction: "", targetSource: "user_input", query: "", groundingSources: [], expectedReasoningResult: null });
      const editedDraft = await service.getGuardrail(guardrailId);
      expect(editedDraft.testCaseCount).toBe(chosen.testSuite.length + 1);
      // Later package imports append versions; they cannot replace local work.
      await service.packages.importPackage(preview.packageId, { actorId: "admin" });
      expect(await service.getGuardrail(guardrailId)).toMatchObject({ draftRevision: editedDraft.draftRevision, draftConfig: editedDraft.draftConfig, testCaseCount: editedDraft.testCaseCount });
      expect((await database.pool.query("SELECT id FROM guardrail_test_case WHERE guardrail_id=$1 AND id=$2", [guardrailId, custom.id])).rows).toHaveLength(1);
      const copiedDraft = await service.duplicateGuardrail({ id: guardrailId, name: "Copy imported draft", sourceDraftRevision: editedDraft.draftRevision, idempotencyKey: "imported-draft", actorId: "admin" });
      expect(copiedDraft.testCaseCount).toBe(editedDraft.testCaseCount);
      const draftRun = await service.requestValidation({ guardrailId, actorId: "admin", compilerAvailable: true });
      const { rows: [request] } = await database.pool.query("SELECT payload FROM controller_outbox WHERE id=$1", [draftRun.id]);
      await completeReport(service, { runId: draftRun.id, status: "passed", metrics: emptyValidationMetrics(draftRun.metrics.total), results: [],
        candidateArtifact: { ...chosen.content, guardrailVersion: draftRun.guardrailVersion, plan: request.payload.plan },
        runtime: { runnerId: "prod-runner", runnerVersion: "1.0.0", nemoVersion: "0.24.0", modelRevisionId: "", compilerModelTypes: [] } });
      const publishedHere = await service.requestGuardrailPublish({ guardrailId, expectedDraftRevision: editedDraft.draftRevision, actorId: "admin" });
      expect(publishedHere).toMatchObject({ status: "ready" });
      expect((await database.pool.query("SELECT origin FROM guardrail_version WHERE guardrail_id=$1 AND version=$2", [guardrailId, publishedHere.version])).rows).toEqual([{ origin: "local" }]);
      expect(await service.getGuardrail(guardrailId)).toMatchObject({ origin: "imported", sourceId: "tasklattice-guard", hasUnpublishedChanges: false, latestValidationRun: { id: draftRun.id, subject: "draft" } });
      expect((await database.pool.query("SELECT plan, test_suite, inspection FROM guardrail_version WHERE guardrail_id=$1 AND version=$2", [guardrailId, chosen.version])).rows).toEqual(frozen);
      const exporter = new ControlPlaneService(database.db, prodConfig);
      const exported = parsePackage((await exporter.packages.exportPackage(guardrailId, [chosen.version, publishedHere.version])).bytes);
      expect(exported.versions).toHaveLength(2);
      expect(exported.versions.find(item => item.version === chosen.version)!.testSuite).toEqual(chosen.testSuite);
    } finally { await next.cleanup(); }
  });

  it("backfills legacy imported drafts without changing versions, reports, or a user's working draft", async () => {
    const next = await installationWith("draft_migration", () => {});
    const { database, service } = next;
    try {
      const bytes = (await uat.packages.exportPackage(guardrailId, published.slice(0, 2))).bytes;
      const preview = await service.packages.inspectUpload(bytes, "admin");
      await service.packages.importPackage(preview.packageId, { actorId: "admin" });
      const original = await service.getGuardrail(guardrailId);
      const before = (await database.pool.query("SELECT version, plan, test_suite, inspection FROM guardrail_version WHERE guardrail_id=$1 ORDER BY version", [guardrailId])).rows;
      await database.pool.query("DELETE FROM guardrail_test_case WHERE guardrail_id=$1", [guardrailId]);
      await database.pool.query("UPDATE guardrail_version SET source_snapshot=NULL WHERE guardrail_id=$1", [guardrailId]);
      const migration = readFileSync(resolve("server/db/migrations/0033_imported_guardrail_drafts.sql"), "utf8");
      await database.pool.query(migration);
      expect(await service.getGuardrail(guardrailId)).toMatchObject({ draftConfig: original.draftConfig, draftRevision: 1, testCaseCount: original.testCaseCount });
      expect((await service.getGuardrail(guardrailId)).versions.every(item => item.hasSourceSnapshot)).toBe(true);
      expect((await database.pool.query("SELECT version, plan, test_suite, inspection FROM guardrail_version WHERE guardrail_id=$1 ORDER BY version", [guardrailId])).rows).toEqual(before);
      const edited = await service.updateGuardrail({ id: guardrailId, expectedDraftRevision: 1, actorId: "admin", runtimeProfile: "llmrails_colang1_standard" });
      await database.pool.query("DELETE FROM guardrail_test_case WHERE guardrail_id=$1", [guardrailId]);
      await database.pool.query(migration);
      expect(await service.getGuardrail(guardrailId)).toMatchObject({ runtimeProfile: edited.runtimeProfile, draftRevision: edited.draftRevision, testCaseCount: 0 });
    } finally { await next.cleanup(); }
  });

  it("applies the same independent report deletion lifecycle to an imported version", async () => {
    const next = await installationWith("report_delete", () => {});
    try {
      const { bytes } = await uat.packages.exportPackage(guardrailId, [published[0]!]);
      const preview = await next.service.packages.inspectUpload(bytes, "admin");
      await next.service.packages.importPackage(preview.packageId, { actorId: "admin" });
      const run = await next.service.requestVersionTestRun({ guardrailId, version: published[0]!, actorId: "admin" });
      await completeReport(next.service, { runId: run.id, status: "passed", metrics: emptyValidationMetrics(run.metrics.total), results: [] });
      await next.service.releaseGuardrailVersion({ guardrailId, version: published[0]!, actorId: "admin" });
      expect(await next.service.getGuardrail(guardrailId)).toMatchObject({ latestTestingReport: { id: run.id }, latestValidationRun: null });
      await next.service.deleteTestingReport({ runId: run.id, actorId: "admin", expectedPendingVersion: null });
      expect((await next.service.getGuardrail(guardrailId)).versions[0]).toMatchObject({ status: "ready", origin: "imported", validationRunId: null });
      expect((await next.service.packages.previewPackage(preview.packageId)).versions[0]).toMatchObject({ state: "existing" });
      expect((await next.database.pool.query("SELECT count(*)::int AS n FROM guardrail_version_provenance WHERE guardrail_id=$1", [guardrailId])).rows[0].n).toBe(1);
    } finally { await next.cleanup(); }
  });

  async function deletedInstallation(released = false, beforeDelete?: (database: Awaited<ReturnType<typeof createTestDatabase>>, service: ControlPlaneService) => Promise<void>) {
    const database = await createTestDatabase(url!, "guard_pkg_restore");
    await seed(database);
    const service = new ControlPlaneService(database.db, prodConfig);
    const { bytes } = await uat.packages.exportPackage(guardrailId, [published[0]!]);
    const preview = await service.packages.inspectUpload(bytes, "admin");
    await service.packages.importPackage(preview.packageId, { actorId: "admin" });
    if (released) {
      const run = await service.requestVersionTestRun({ guardrailId, version: published[0]!, actorId: "admin" });
      await completeReport(service, { runId: run.id, status: "passed", metrics: emptyValidationMetrics(run.metrics.total), results: [] });
      await service.releaseGuardrailVersion({ guardrailId, version: published[0]!, actorId: "admin" });
    }
    await beforeDelete?.(database, service);
    await service.softDeleteGuardrail({ id: guardrailId, actorId: "admin", reason: "Re-import regression", confirmRecentTraffic: false });
    return { database, service, bytes, packageId: preview.packageId };
  }

  it.each([false, true])("restores definitions with fresh test/release state without restoring routing (released: %s)", async released => {
    const { database, service, bytes, packageId } = await deletedInstallation(released);
    try {
      const versions = (await database.pool.query("SELECT * FROM guardrail_version ORDER BY version")).rows;
      const preview = await service.packages.inspectUpload(bytes, "admin");
      expect(preview.guardrail).toMatchObject({ exists: true, deleted: true });
      expect(preview.blockers).toEqual([]);
      expect(preview.versions.map(item => item.state)).toEqual(["existing"]);
      expect((await service.listGuardrails()).some(item => item.id === guardrailId)).toBe(false);
      await expect(service.packages.importPackage(packageId, { actorId: "admin" })).rejects.toMatchObject({ code: "guardrail_restore_required" });
      const generation = await service.desiredGeneration();
      const results = await Promise.all([1, 2].map(() => service.packages.importPackage(packageId, { actorId: "admin", restoreDeleted: true })));
      expect(results.filter(result => result.restored)).toHaveLength(1);
      expect(results.every(result => result.imported.length === 0 && result.existing[0] === published[0])).toBe(true);
      expect((await database.pool.query("SELECT * FROM guardrail_version ORDER BY version")).rows).toEqual(versions);
      expect((await database.pool.query("SELECT deleted_at, deleted_by, delete_reason, status FROM guardrail WHERE id = $1", [guardrailId])).rows[0])
        .toEqual({ deleted_at: null, deleted_by: null, delete_reason: null, status: "draft" });
      expect((await service.listGuardrails()).some(item => item.id === guardrailId)).toBe(true);
      expect(versions.every(row => row.status === "pending" && row.validation_run_id === null && row.released_at === null && row.released_by === null)).toBe(true);
      expect(await service.listValidationRuns(guardrailId)).toEqual([]);
      await expect(service.releaseGuardrailVersion({ guardrailId, version: published[0]!, actorId: "admin" }))
        .resolves.toMatchObject({ status: "ready", validationRunId: null });
      expect(await service.desiredGeneration()).toBe(generation + 2);
      expect((await database.pool.query("SELECT * FROM audit_event WHERE kind = 'guardrail.restored'")).rows).toHaveLength(1);
      expect((await database.pool.query("SELECT payload FROM controller_outbox WHERE payload->>'restored' = 'true'")).rows).toHaveLength(1);
      expect((await service.trafficRouting.list()).length).toBe(0);
    } finally { await database.drop(); }
  });

  it("restores and imports new versions atomically while keeping existing versions", async () => {
    const { database, service } = await deletedInstallation();
    try {
      const { bytes } = await uat.packages.exportPackage(guardrailId, published.slice(0, 2));
      const preview = await service.packages.inspectUpload(bytes, "admin");
      expect(preview.versions.map(item => item.state)).toEqual(["existing", "new"]);
      const result = await service.packages.importPackage(preview.packageId, { actorId: "admin", restoreDeleted: true });
      expect(result).toMatchObject({ restored: true, imported: [published[1]], existing: [published[0]] });
      expect((await database.pool.query("SELECT status FROM guardrail_version")).rows.every(row => row.status === "pending")).toBe(true);
    } finally { await database.drop(); }
  });

  it("purges operational data, retains audit/definitions, and rejects late results after restoration", async () => {
    const oldTime = new Date(Date.now() - 2 * 86400000);
    const runtime = (id: string, target = guardrailId, occurredAt = oldTime) => ({
      id, guardrailId: target, guardrailVersion: published[0]!, occurredAt, requestId: id, runnerId: "test-runner",
      direction: "incoming" as const, decision: "block", durationMs: 5,
      metadata: { capturedContent: { input: "sensitive runtime input" }, findings: [{ verdict: "matched" }] },
    });
    const call = (id: string, target = guardrailId, decisionAt = oldTime) => routingEventSchema.parse({
      id, decisionId: id, callId: id, runnerId: "test-runner", eventType: "completion", assignmentStatus: "assigned",
      endpointId: "endpoint", routerId: "router", routerRevision: 1, routeId: "route", targetId: "target",
      guardrailId: target, guardrailVersion: published[0]!, occurredAt: new Date(), decisionAt, outcome: "error", durationMs: 5,
    });
    let runningId = "";
    const preserved: Record<string, unknown[]> = {};
    const { database, service, packageId } = await deletedInstallation(true, async (database, service) => {
      await database.pool.query("INSERT INTO guardrail (id,name,draft_config) VALUES ('other','Other','{}')");
      await database.pool.query("INSERT INTO guardrail_validation_run (id,guardrail_id,guardrail_version,source_draft_revision,status) VALUES ('other-report','other','v1',1,'passed')");
      await database.pool.query("INSERT INTO controller_outbox (id,kind,aggregate_id,payload) VALUES ('other-request','guardrail.validation_requested','other','{}')");
      const run = await service.requestVersionTestRun({ guardrailId, version: published[0]!, actorId: "admin" });
      runningId = run.id;
      await service.markValidationRunning(run.id);
      await service.recordRuntimeEvents([runtime("old-runtime"), runtime("other-runtime", "other")]);
      await service.trafficRouting.recordEvents([call("old-call"), call("other-call", "other")]);
      for (const table of ["guardrail_artifact", "guardrail_version_provenance", "guardrail_package", "policy_record", "policy_version", "policy_imported_version", "policy_validation_run", "guardrail_test_case"]) {
        preserved[table] = (await database.pool.query(`SELECT * FROM ${table}`)).rows;
      }
    });
    try {
      for (const table of ["guardrail_validation_run", "runtime_event", "route_assignment"]) {
        expect((await database.pool.query(`SELECT * FROM ${table} WHERE guardrail_id=$1`, [guardrailId])).rows).toEqual([]);
        expect((await database.pool.query(`SELECT * FROM ${table} WHERE guardrail_id='other'`)).rows).toHaveLength(1);
      }
      expect((await database.pool.query("SELECT * FROM controller_outbox WHERE aggregate_id=$1 AND kind='guardrail.validation_requested'", [guardrailId])).rows).toEqual([]);
      expect((await database.pool.query("SELECT * FROM controller_outbox WHERE id='other-request'")).rows).toHaveLength(1);
      expect((await database.pool.query("SELECT detail FROM audit_event WHERE kind='guardrail.disabled'")).rows[0].detail.cleared)
        .toMatchObject({ testingReports: 2, testRequests: 2, runtimeEvents: 1, routeAssignments: 1 });
      expect((await database.pool.query("SELECT * FROM audit_event WHERE kind='guardrail.version_released'")).rows).toHaveLength(1);
      for (const [table, rows] of Object.entries(preserved)) expect((await database.pool.query(`SELECT * FROM ${table}`)).rows).toEqual(rows);
      await service.recordRuntimeEvents([runtime("late-runtime", guardrailId, new Date())]);
      await service.trafficRouting.recordEvents([call("late-call", guardrailId, new Date())]);
      await expect(service.requestVersionTestRun({ guardrailId, version: published[0]!, actorId: "admin" })).rejects.toMatchObject({ status: 404 });
      await service.packages.importPackage(packageId, { actorId: "admin", restoreDeleted: true });
      await completeReport(service, { runId: runningId, status: "passed", metrics: emptyValidationMetrics(1), results: [] });
      await service.updateValidationProgress(runningId, { phase: "executing", completedCases: 1, passedCases: 1 });
      await service.markValidationRunning(runningId);
      await service.recordRuntimeEvents([runtime("old-runtime")]);
      // Completion arrives now but belongs to a call assigned before restoration.
      await service.trafficRouting.recordEvents([call("old-call")]);
      expect(await service.listValidationRuns(guardrailId)).toEqual([]);
      for (const table of ["runtime_event", "route_assignment"]) expect((await database.pool.query(`SELECT * FROM ${table} WHERE guardrail_id=$1`, [guardrailId])).rows).toEqual([]);
      await expect(service.releaseGuardrailVersion({ guardrailId, version: published[0]!, actorId: "admin" })).resolves.toMatchObject({ status: "ready", validationRunId: null });
      const fresh = await service.requestVersionTestRun({ guardrailId, version: published[0]!, actorId: "admin" });
      expect(fresh.id).not.toBe(runningId);
      await completeReport(service, { runId: fresh.id, status: "passed", metrics: emptyValidationMetrics(fresh.metrics.total), results: [] });
      const released = await service.releaseGuardrailVersion({ guardrailId, version: published[0]!, actorId: "admin" });
      expect(released.validationRunId).toBeNull();
      expect(await getReport(service, fresh.id)).toMatchObject({ status: "passed" });
      await service.recordRuntimeEvents([runtime("fresh-runtime", guardrailId, new Date())]);
      await service.trafficRouting.recordEvents([call("fresh-call", guardrailId, new Date())]);
      expect((await database.pool.query("SELECT id FROM runtime_event WHERE guardrail_id=$1", [guardrailId])).rows).toEqual([{ id: "fresh-runtime" }]);
      expect((await database.pool.query("SELECT decision_id FROM route_assignment WHERE guardrail_id=$1", [guardrailId])).rows).toEqual([{ decision_id: "fresh-call" }]);
    } finally { await database.drop(); }
  });

  it("does not let a concurrent test request survive deletion", async () => {
    const { database, service, packageId } = await deletedInstallation();
    try {
      await service.packages.importPackage(packageId, { actorId: "admin", restoreDeleted: true });
      const [deletion, request] = await Promise.allSettled([
        service.softDeleteGuardrail({ id: guardrailId, actorId: "admin", reason: "Concurrent delete", confirmRecentTraffic: false }),
        service.requestVersionTestRun({ guardrailId, version: published[0]!, actorId: "admin" }),
      ]);
      expect(deletion.status).toBe("fulfilled");
      if (request.status === "rejected") expect(request.reason).toMatchObject({ status: 404 });
      expect(await service.listValidationRuns(guardrailId)).toEqual([]);
      expect((await database.pool.query("SELECT * FROM controller_outbox WHERE kind='guardrail.validation_requested' AND aggregate_id=$1", [guardrailId])).rows).toEqual([]);
    } finally { await database.drop(); }
  });

  it("discards an environment check that completes after deletion and restoration", async () => {
    const { database, service, packageId } = await deletedInstallation();
    try {
      await service.packages.importPackage(packageId, { actorId: "admin", restoreDeleted: true });
      const started = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<[]>();
      service.setArtifactAdmission(async () => { started.resolve(); return finished.promise; });
      const check = service.packages.checkVersionEnvironment(guardrailId, published[0]!).catch(error => error);
      await started.promise;
      await service.softDeleteGuardrail({ id: guardrailId, actorId: "admin", reason: "Delete during check", confirmRecentTraffic: false });
      await service.packages.importPackage(packageId, { actorId: "admin", restoreDeleted: true });
      finished.resolve([]);
      expect(await check).toMatchObject({ code: "guardrail_lifecycle_changed" });
      expect((await database.pool.query("SELECT environment_check FROM guardrail_version WHERE guardrail_id=$1", [guardrailId])).rows)
        .toEqual([{ environment_check: null }]);
    } finally { await database.drop(); }
  });

  it("clears operational data retained by the old soft-delete implementation on explicit restore", async () => {
    const { database, service, packageId } = await deletedInstallation();
    try {
      await database.pool.query("UPDATE guardrail SET operational_reset_at=NULL WHERE id=$1", [guardrailId]);
      await database.pool.query("INSERT INTO guardrail_validation_run (id,guardrail_id,guardrail_version,source_draft_revision,status) VALUES ('legacy-report',$1,$2,0,'passed')", [guardrailId, published[0]]);
      await database.pool.query("UPDATE guardrail_version SET status='ready', validation_run_id='legacy-report', released_at=now(), released_by='admin' WHERE guardrail_id=$1", [guardrailId]);
      await service.packages.importPackage(packageId, { actorId: "admin", restoreDeleted: true });
      expect(await service.listValidationRuns(guardrailId)).toEqual([]);
      expect((await database.pool.query("SELECT status, validation_run_id, released_at FROM guardrail_version WHERE guardrail_id=$1", [guardrailId])).rows)
        .toEqual([{ status: "pending", validation_run_id: null, released_at: null }]);
      expect((await database.pool.query("SELECT detail FROM audit_event WHERE kind='guardrail.restored'")).rows[0].detail.cleared.testingReports).toBe(1);
    } finally { await database.drop(); }
  });

  it("allows restoration regardless of origin but keeps a deleted resource deleted on content conflict", async () => {
    const { database, service, bytes, packageId } = await deletedInstallation();
    try {
      for (const ownership of [{ origin: "local", source: null }, { origin: "imported", source: "bank-uat-b" }]) {
        await database.pool.query("UPDATE guardrail SET origin=$2, source_id=$3 WHERE id=$1", [guardrailId, ownership.origin, ownership.source]);
        expect((await service.packages.previewPackage(packageId)).blockers).toEqual([]);
      }
      await database.pool.query("UPDATE guardrail SET origin='imported', source_id='bank-uat' WHERE id=$1", [guardrailId]);
      const parsed = parsePackage(bytes);
      const altered = buildPackage({ source: parsed.manifest.source, guardrail: parsed.manifest.guardrail, exportedAt: new Date(),
        versions: parsed.versions.map(item => rebuilt(parsed, item, { ...item.content, configYaml: "models: [] # changed\n" })) });
      const conflict = await service.packages.inspectUpload(altered, "admin");
      await expect(service.packages.importPackage(conflict.packageId, { actorId: "admin", restoreDeleted: true })).rejects.toMatchObject({ code: "guardrail_version_conflict" });
      expect((await database.pool.query("SELECT deleted_at FROM guardrail WHERE id=$1", [guardrailId])).rows[0].deleted_at).not.toBeNull();
      expect((await database.pool.query("SELECT * FROM audit_event WHERE kind='guardrail.restored'")).rows).toHaveLength(0);
    } finally { await database.drop(); }
  });
  it("enforces import capacity in preview and transaction, including concurrent imports and existing releases", async () => {
    const database = await createTestDatabase(url!, "guard_pkg_quota");
    try {
      await seed(database);
      const service = new ControlPlaneService(database.db, prodConfig);
      const { bytes } = await uat.packages.exportPackage(guardrailId, published.slice(0, 2));
      const preview = await service.packages.inspectUpload(bytes, "admin");
      await service.packages.importPackage(preview.packageId, { versions: [published[0]!], actorId: "admin" });
      await database.pool.query(`INSERT INTO guardrail_version (guardrail_id, version, generation, status, runtime_profile, plan)
        SELECT $1, 'retained-' || n, -n, 'pending', 'auto', '{}'::jsonb FROM generate_series(1, 8) n`, [guardrailId]);
      expect((await service.packages.previewPackage(preview.packageId)).blockers).toEqual([]);
      // Two different valid packages each want the one remaining slot.
      const parsed = parsePackage(bytes);
      const item = parsed.versions[1]!;
      const thirdVersion = "20261009-235959.999Z";
      const third = buildPackage({ source: parsed.manifest.source, guardrail: parsed.manifest.guardrail, exportedAt: new Date(),
        versions: [rebuilt(parsed, item, { ...item.content, guardrailVersion: thirdVersion, plan: { ...item.content.plan, guardrail_version: thirdVersion } })] });
      const other = await service.packages.inspectUpload(third, "admin");
      expect(other.blockers).toEqual([]);
      const combined = buildPackage({ source: parsed.manifest.source, guardrail: parsed.manifest.guardrail, exportedAt: new Date(),
        versions: [rebuilt(parsed, item), rebuilt(parsed, item, { ...item.content, guardrailVersion: thirdVersion, plan: { ...item.content.plan, guardrail_version: thirdVersion } })] });
      const batch = await service.packages.inspectUpload(combined, "admin");
      expect(batch.blockers).toContainEqual(expect.objectContaining({ code: "guardrail_version_limit" }));
      await expect(service.packages.importPackage(batch.packageId, { actorId: "admin" })).rejects.toMatchObject({ code: "guardrail_version_limit", detail: { current: 9, incoming: 2 } });
      expect((await database.pool.query("SELECT count(*)::int AS n FROM guardrail_version WHERE guardrail_id=$1", [guardrailId])).rows[0].n).toBe(9);
      const attempts = await Promise.allSettled([
        service.packages.importPackage(preview.packageId, { actorId: "admin" }),
        service.packages.importPackage(other.packageId, { actorId: "admin" }),
      ]);
      expect(attempts.filter(item => item.status === "fulfilled")).toHaveLength(1);
      expect(attempts.find(item => item.status === "rejected")).toMatchObject({ reason: { code: "guardrail_version_limit", detail: { current: 10, incoming: 1, limit: 10 } } });
      expect((await database.pool.query("SELECT count(*)::int AS n FROM guardrail_version WHERE guardrail_id=$1", [guardrailId])).rows[0].n).toBe(10);
      const blockedId = attempts[0].status === "rejected" ? preview.packageId : other.packageId;
      expect((await service.packages.previewPackage(blockedId)).blockers).toContainEqual(expect.objectContaining({ code: "guardrail_version_limit" }));
      // Existing content is idempotent even at capacity, and can still be tested/released.
      await expect(service.packages.importPackage(preview.packageId, { versions: [published[0]!], actorId: "admin" })).resolves.toBeTruthy();
      const run = await service.requestVersionTestRun({ guardrailId, version: published[0]!, actorId: "admin" });
      await completeReport(service, { runId: run.id, status: "passed", metrics: emptyValidationMetrics(run.metrics.total), results: [] });
      await expect(service.releaseGuardrailVersion({ guardrailId, version: published[0]!, actorId: "admin" })).resolves.toBeTruthy();
      await service.deleteGuardrailVersion({ guardrailId, version: "retained-1", actorId: "admin" });
      expect((await service.packages.previewPackage(blockedId)).blockers).toEqual([]);
      await expect(service.packages.importPackage(blockedId, { actorId: "admin" })).resolves.toBeTruthy();
      expect((await database.pool.query("SELECT count(*)::int AS n FROM guardrail_version WHERE guardrail_id=$1", [guardrailId])).rows[0].n).toBe(10);
    } finally { await database.drop(); }
  });

  it("round-trips a complete declarative Policy leaf and allows maintenance after import", async () => {
    const definition = emptyPolicyDefinition(); definition.metadata.name = "Portable Policy";
    definition.rules = ["first", "second"].map(id => ({ id, name: id, description: "", stages: ["input"], detector: { ref: "text/keyword", version: "1.0.0", parameters: { detector_options: { terms: [id] } } }, on_match: { action: "block" }, risk_level: "medium", metadata: { taxonomy_ids: ["TALI-BUSINESS-POLICY"] } }));
    definition.tests = definition.rules.map(rule => ({ id: rule.id, name: rule.name, description: "", phase: "input", content: rule.id, expected_decision: "block", covered_rule_ids: [rule.id], kind: "rule_acceptance", scope: "rule", required: true, group: "Tests", parameter_names: [] }));
    const id = definition.metadata.id;
    await uat.policyResources.save({ definition, maintainer: "Admin", expectedRevision: 0, create: true, actorId: "admin" });
    const report = await uat.policyResources.validate(id, "admin", true);
    const jobs = (await uatDb.pool.query("SELECT id, tests FROM policy_resource_validation WHERE parent_id=$1", [report.id])).rows;
    for (const job of jobs) {
      const test = job.tests[0];
      await completeReport(uat, { metrics: emptyValidationMetrics(1), runId: job.id, status: "passed", results: [{ caseId: test.id, name: test.name, actualDecision: "block", passed: true, sourcePolicyId: id, outputContent: "", findings: [{ policy_id: id, rule_id: test.id, verdict: "matched" }] } as ValidationCaseResult] });
    }
    const policy = await uat.policyResources.publish(id, 1, "admin");
    const guardrail = await uat.createGuardrail({ name: "Portable Guardrail", actorId: "admin", runtimeProfile: "auto", draftConfig: { policyBindings: [{ policyId: id, policyVersion: policy.version, enabledRuleIds: ["second"], enabledRails: ["input"] }] } });
    const release = await testAndPublish(guardrail.id, 1, false);
    const exported = await uat.packages.exportPackage(guardrail.id, [release.version]);
    const parsed = parsePackage(exported.bytes);
    expect(parsed.policies).toHaveLength(1);
    const node = parsed.policies[0]!;
    expect(node.definition).not.toHaveProperty("source");
    expect(node.definition.definition).toEqual(policy.definition);
    expect(node.definition.rules).toHaveLength(2); expect(node.definition.test_cases).toHaveLength(2);
    const preview = await prod.packages.inspectUpload(exported.bytes, "admin");
    expect(preview.blockers).toEqual([]);
    await prod.packages.importPackage(preview.packageId, { actorId: "admin" });
    const imported = await prod.policyResources.get(id);
    expect(imported.definition).toEqual(policy.definition);
    await prod.policyResources.save({ definition: { ...imported.definition, metadata: { ...imported.definition.metadata, name: "Maintained here" } }, maintainer: "Destination admin", expectedRevision: 0, actorId: "admin" });
    expect((await prod.policyResources.get(id)).definition.metadata.name).toBe("Maintained here");
    const again = parsePackage((await prod.packages.exportPackage(guardrail.id, [release.version])).bytes);
    expect(again.policies[0]).toEqual(node);
  });
});
