// @vitest-environment node
import { generateKeyPairSync } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { verifyArtifactDigest, type ArtifactContent } from "../domain/artifact-content.js";
import { DEFAULT_GUARDRAIL_ID, defaultGuardrailDraft } from "../domain/defaults.js";
import { buildPackage, parsePackage, type ParsedPackage } from "../domain/guardrail-package.js";
import type { ArtifactContent as Content } from "../domain/artifact-content.js";
import { emptyValidationMetrics } from "../domain/validation.js";
import { readZip, writeZip } from "../domain/zip.js";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { programmablePolicyDraftSchema } from "../policy-studio/model.js";
import { ControlPlaneService } from "./control-plane.js";
import { routingEventSchema } from "./traffic-routing.js";
import { packageSigner } from "./package-trust.js";

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
  const uatPackageKey = keyPair(keys, "uat-package");
  const otherPackageKey = keyPair(keys, "other-package");
  const prodArtifactKey = keyPair(keys, "prod-artifact");
  const systemPackageKey = keyPair(keys, "system-package");
  const trustPath = join(keys, "trust.json");
  writeFileSync(trustPath, JSON.stringify({ sources: [
    { id: "bank-uat", name: "Bank UAT", keys: [{ id: "uat-2026", publicKeyPem: uatPackageKey.publicKeyPem }], reservedGuardrailIds: [] },
    { id: "bank-uat-b", name: "Second UAT", keys: [{ id: "uat-b", publicKeyPem: otherPackageKey.publicKeyPem }] },
    { id: "bank-uat-system", name: "UAT system baseline", keys: [{ id: "system", publicKeyPem: systemPackageKey.publicKeyPem }], reservedGuardrailIds: [DEFAULT_GUARDRAIL_ID] },
  ] }));
  const environment = (artifactKey: string, extra: Record<string, string>) => loadConfig({
    NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!, CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
    CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: artifactKey, CONTROLLER_POLICY_CATALOG_DIR: catalogDir, CONTROLLER_PROTO_PATH: protoPath,
    BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters", ...extra,
  });
  if (!url) return;
  const uatConfig = environment(uatArtifactKey.path, { CONTROLLER_PACKAGE_SOURCE_ID: "bank-uat", CONTROLLER_PACKAGE_SOURCE_NAME: "Bank UAT", CONTROLLER_PACKAGE_SIGNING_KEY_PATH: uatPackageKey.path, CONTROLLER_PACKAGE_SIGNING_KEY_ID: "uat-2026" });
  const prodConfig = environment(prodArtifactKey.path, { CONTROLLER_PACKAGE_TRUST_PATH: trustPath });
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
  async function testAndPublish(id: string, revision: number) {
    const run = await uat.requestValidation({ guardrailId: id, actorId: "admin", compilerAvailable: true });
    const { rows: [request] } = await uatDb.pool.query("SELECT payload FROM controller_outbox WHERE id = $1", [run.id]);
    const candidate: ArtifactContent = {
      guardrailId: id, guardrailVersion: run.guardrailVersion, compilerVersion: "tasklattice-nemo-config-test", nemoVersion: "0.24.0",
      runtimeProfile: "llmrails_colang1_standard", plan: request.payload.plan, configYaml: "models: []\n", colangContent: "",
      prompts: [], actionBindings: [], dependencyManifest: [["action", "GuardContentFilterAction", "1.0.0"]],
    };
    await uat.completeValidation({ runId: run.id, status: "passed", metrics: emptyValidationMetrics(run.metrics.total), results: [], candidateArtifact: candidate,
      runtime: { runnerId: "uat-runner-0", runnerVersion: "1.0.0", nemoVersion: "0.24.0", modelRevisionId: "", compilerModelTypes: [] } });
    const version = await uat.requestGuardrailPublish({ guardrailId: id, actorId: "admin", expectedDraftRevision: revision });
    published.push(version.version);
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

  it("starts production with the same features as UAT: a local Default and no baseline until one is published", async () => {
    await prod.initialize();
    // Same as any installation: its own Default draft, queued for testing, and an editable Library.
    expect((await prodDb.pool.query("SELECT origin FROM guardrail WHERE id = $1", [DEFAULT_GUARDRAIL_ID])).rows).toEqual([{ origin: "local" }]);
    expect(await prod.systemBaseline()).toEqual({ guardrailId: DEFAULT_GUARDRAIL_ID, version: null });
    expect((await prod.listPolicies()).length).toBeGreaterThan(0);
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
    expect(parsed.manifest).toMatchObject({ source: { id: "bank-uat" }, guardrail: { id: guardrailId, name: "Bank assistant" } });
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

  it("refuses to export versions that cannot prove what was tested", async () => {
    await uatDb.pool.query("UPDATE guardrail_validation_run SET candidate_digest = NULL WHERE guardrail_version = $1", [published[0]]);
    await expect(uat.packages.exportPackage(guardrailId, published)).rejects.toMatchObject({
      code: "guardrail_package_incomplete", detail: { versions: [{ version: published[0], missing: ["tested_candidate_evidence"] }] },
    });
    await uatDb.pool.query("UPDATE guardrail_validation_run r SET candidate_digest = a.checksum FROM guardrail_version v JOIN guardrail_artifact a ON a.id = v.artifact_id WHERE r.id = v.validation_run_id");
    const { rows: [run] } = await uatDb.pool.query("SELECT id, test_suite_digest FROM guardrail_validation_run WHERE guardrail_version=$1", [published[0]]);
    await uatDb.pool.query("UPDATE guardrail_validation_run SET test_suite_digest='different-suite' WHERE id=$1", [run.id]);
    await expect(uat.packages.exportPackage(guardrailId, published)).rejects.toMatchObject({
      code: "guardrail_package_incomplete", detail: { versions: [{ version: published[0], missing: ["tested_candidate_evidence"] }] },
    });
    await uatDb.pool.query("UPDATE guardrail_validation_run SET test_suite_digest=$2 WHERE id=$1", [run.id, run.test_suite_digest]);
  });

  it("imports released versions as they are, preserving digests but signing locally", async () => {
    const { bytes } = await uat.packages.exportPackage(guardrailId, published);
    const preview = await prod.packages.inspectUpload(bytes, "admin");
    expect(preview).toMatchObject({ source: { id: "bank-uat" }, keyId: "uat-2026", guardrail: { id: guardrailId, exists: false }, blockers: [] });
    expect(preview.versions.map(item => [item.version, item.state, item.environment?.status])).toEqual(published.map(version => [version, "new", "pending"]));

    // Leaves first: the Studio Policy is new here; catalog Policies this installation ships are already here.
    expect(preview.policies.filter(node => node.state === "new").map(node => node.id)).toEqual([STUDIO]);
    expect(preview.policies.filter(node => node.kind === "catalog").every(node => node.state === "existing")).toBe(true);
    const result = await prod.packages.importPackage(preview.packageId, { actorId: "admin" });
    expect(result).toMatchObject({ guardrailId, imported: published, existing: [], policies: { imported: [`${STUDIO}@1`] } });
    expect(result.policies.existing.length).toBe(preview.policies.length - 1);

    const uatArtifacts = (await uatDb.pool.query("SELECT guardrail_version, checksum, signature, generation FROM guardrail_artifact ORDER BY guardrail_version")).rows;
    const prodArtifacts = (await prodDb.pool.query("SELECT guardrail_version, checksum, signature, generation, content_digest_version FROM guardrail_artifact ORDER BY guardrail_version")).rows;
    expect(prodArtifacts.map(row => row.checksum)).toEqual(uatArtifacts.map(row => row.checksum));
    for (const [index, row] of prodArtifacts.entries()) {
      expect(row.signature).not.toBe(uatArtifacts[index].signature);
      expect(verifyArtifactDigest(row.checksum, row.signature, prodArtifactKey.publicKeyPem)).toBe(true);
      expect(row.content_digest_version).toBe(2);
    }
    const { rows: [guardrail] } = await prodDb.pool.query("SELECT origin, source_id, status FROM guardrail WHERE id = $1", [guardrailId]);
    // Nothing imported is usable yet: each version waits to be tested and released here.
    expect(guardrail).toEqual({ origin: "imported", source_id: "bank-uat", status: "draft" });
    expect((await prodDb.pool.query("SELECT DISTINCT status FROM guardrail_version WHERE guardrail_id = $1", [guardrailId])).rows).toEqual([{ status: "pending" }]);
    const { rows: provenance } = await prodDb.pool.query("SELECT version, source_id, source_key_id FROM guardrail_version_provenance ORDER BY version");
    expect(provenance).toEqual(published.map(version => ({ version, source_id: "bank-uat", source_key_id: "uat-2026" })));
    const { rows: suites } = await prodDb.pool.query("SELECT v.test_suite AS prod, v.inspection->'testSuite'->>'total' AS total FROM guardrail_version v WHERE v.guardrail_id = $1 ORDER BY v.version", [guardrailId]);
    expect(suites.map(row => row.prod.length)).toEqual(suites.map(row => Number(row.total)));
    // Import neither distributes nor routes anything, and creates no test or compile work.
    expect((await prodDb.pool.query("SELECT kind FROM controller_outbox WHERE aggregate_id = $1", [guardrailId])).rows).toEqual([]);
    expect((await prodDb.pool.query("SELECT count(*)::int AS n FROM guardrail_validation_run WHERE guardrail_id = $1", [guardrailId])).rows[0].n).toBe(0);
    // The Studio Policy joined this Library, owned by its source and read only.
    expect((await prodDb.pool.query("SELECT id, origin, source_id FROM policy_record")).rows).toEqual([{ id: STUDIO, origin: "imported", source_id: "bank-uat" }]);
    const checksums = async (db: typeof uatDb) => (await db.pool.query("SELECT checksum FROM policy_version WHERE policy_id = $1", [STUDIO])).rows;
    expect(await checksums(prodDb)).toEqual(await checksums(uatDb));
    expect((await prodDb.pool.query("SELECT count(*)::int AS n FROM policy_imported_version")).rows[0].n).toBe(0);
    expect((await prod.listPolicies()).find(policy => policy.id === STUDIO)).toMatchObject({ version: "1", origin: "imported", source_id: "bank-uat" });
    await expect(prod.updatePolicy({ id: STUDIO, name: "Renamed", actorId: "admin" })).rejects.toMatchObject({ code: "policy_imported_read_only" });
    await expect(prod.publishPolicy({ id: STUDIO, actorId: "admin" })).rejects.toMatchObject({ code: "policy_imported_read_only" });
    await expect(prod.deletePolicy({ id: STUDIO, actorId: "admin" })).rejects.toMatchObject({ code: "policy_imported_read_only" });
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
    const signer = packageSigner(uatConfig);
    const parsed = parsePackage((await uat.packages.exportPackage(guardrailId, published)).bytes);
    const altered = parsed.versions.map(item => item.version === published[1] ? { ...item, content: { ...item.content, configYaml: "models: [] # changed\n" } } : item);
    const bytes = buildPackage({
      source: parsed.manifest.source, guardrail: parsed.manifest.guardrail, exportedAt: new Date(), sign: signer.sign,
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

  it("rejects packages signed by an untrusted key, even when the package names a trusted source", async () => {
    const forger = { ...uatConfig, packageExport: { ...uatConfig.packageExport!, signingKeyPath: otherPackageKey.path, signingKeyId: "uat-2026" } };
    const { bytes } = await new ControlPlaneService(uatDb.db, forger).packages.exportPackage(guardrailId, published);
    await expect(prod.packages.inspectUpload(bytes, "admin")).rejects.toMatchObject({ code: "guardrail_package_untrusted" });
  });

  it("never lets another source or a reserved ID take over a Guardrail", async () => {
    const otherSource = { ...uatConfig, packageExport: { sourceId: "bank-uat-b", sourceName: "Second UAT", signingKeyPath: otherPackageKey.path, signingKeyId: "uat-b" } };
    const { bytes } = await new ControlPlaneService(uatDb.db, otherSource).packages.exportPackage(guardrailId, published);
    const preview = await prod.packages.inspectUpload(bytes, "admin");
    expect(preview.blockers.map(item => item.code)).toContain("guardrail_ownership_conflict");
    await expect(prod.packages.importPackage(preview.packageId, { actorId: "admin" })).rejects.toMatchObject({ code: "guardrail_ownership_conflict" });

    const parsed = parsePackage((await uat.packages.exportPackage(guardrailId, [published[0]!])).bytes);
    const reserved = (id: string) => parsed.versions.map(item => rebuilt(parsed, item, { ...item.content, guardrailId: id, plan: { ...item.content.plan, guardrail_id: id } }));
    const defaultPackage = buildPackage({ source: parsed.manifest.source, guardrail: { id: DEFAULT_GUARDRAIL_ID, name: "Default Guardrail" },
      exportedAt: new Date(), sign: packageSigner(uatConfig).sign, versions: reserved(DEFAULT_GUARDRAIL_ID) });
    const defaultPreview = await prod.packages.inspectUpload(defaultPackage, "admin");
    expect(defaultPreview.blockers.map(item => item.code)).toEqual(["guardrail_reserved_id"]);
    await expect(prod.packages.importPackage(defaultPreview.packageId, { actorId: "admin" })).rejects.toMatchObject({ code: "guardrail_reserved_id" });
  });

  it("serializes concurrent imports of the same package", async () => {
    const third = await uat.updateGuardrail({ id: guardrailId, actorId: "admin", name: "Bank assistant", expectedDraftRevision: 2 });
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
    await prod.completeValidation({ runId: run.id, status, metrics: emptyValidationMetrics(run.metrics.total), results: [] });
    return run;
  }

  it("releases an imported version only after its own suite passes here, against exactly that content", async () => {
    const version = published[1]!;
    await expect(prod.releaseGuardrailVersion({ guardrailId, version, actorId: "admin" })).rejects.toMatchObject({ code: "guardrail_version_test_required" });
    await testHere(guardrailId, version, "failed");
    await expect(prod.releaseGuardrailVersion({ guardrailId, version, actorId: "admin" })).rejects.toMatchObject({ code: "guardrail_version_test_required", detail: { lastRun: { status: "failed" } } });
    const passed = await testHere(guardrailId, version, "passed");
    const released = await prod.releaseGuardrailVersion({ guardrailId, version, actorId: "admin" });
    // Same version number and content; the passing report is bound for good.
    expect(released).toMatchObject({ version, status: "ready", validationRunId: passed.id, releasedBy: "admin" });
    // Testing a frozen version does not mark its independent working draft as tested.
    expect((await prod.getGuardrail(guardrailId)).latestValidationRun).toBeNull();
    expect((await prod.getGuardrail(guardrailId)).latestTestingReport).toMatchObject({ id: passed.id, status: "passed" });
    expect((await prod.getGuardrail(guardrailId)).hasUnpublishedChanges).toBe(false);
    expect((await prodDb.pool.query("SELECT status FROM guardrail WHERE id = $1", [guardrailId])).rows[0].status).toBe("active");
    const { rows: [audit] } = await prodDb.pool.query("SELECT detail FROM audit_event WHERE kind = 'guardrail.version_released'");
    expect(audit.detail).toMatchObject({ version, validationRunId: passed.id, origin: "imported" });
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
    expect((await prod.desiredStateForPool("default")).artifacts.map(item => item.guardrailVersion)).toEqual([version]);
    await prod.packages.checkRoutedImports(change.snapshot);
    await prod.trafficRouting.approveChange(router.id, change.id, "approver", {});
    const desired = await prod.desiredStateForPool("default");
    expect(desired.artifacts.map(item => [item.guardrailVersion, item.checksum])).toEqual([[version, expect.stringMatching(/^[0-9a-f]{64}$/)]]);
    // What a published Router pins is delivered whatever its row says: Runners
    // reject a desired state with a missing target, which would stop all traffic.
    const { rows: [release] } = await prodDb.pool.query("SELECT released_at, validation_run_id FROM guardrail_version WHERE guardrail_id = $1 AND version = $2", [guardrailId, version]);
    await prodDb.pool.query("UPDATE guardrail_version SET status = 'pending', released_at = NULL WHERE guardrail_id = $1 AND version = $2", [guardrailId, version]);
    expect((await prod.desiredStateForPool("default")).artifacts.map(item => item.guardrailVersion)).toEqual([version]);
    await prodDb.pool.query("UPDATE guardrail_version SET status = 'ready', released_at = $3, validation_run_id = $4 WHERE guardrail_id = $1 AND version = $2", [guardrailId, version, release.released_at, release.validation_run_id]);

  });

  it("imports a Default only from an authorized source and switches the baseline explicitly", async () => {
    const parsed = parsePackage((await uat.packages.exportPackage(guardrailId, [published[0]!])).bytes);
    const versions = parsed.versions.map(item => rebuilt(parsed, item, { ...item.content, guardrailId: DEFAULT_GUARDRAIL_ID, plan: { ...item.content.plan, guardrail_id: DEFAULT_GUARDRAIL_ID } }));
    const signer = packageSigner({ ...uatConfig, packageExport: { sourceId: "bank-uat-system", sourceName: "UAT system baseline", signingKeyPath: systemPackageKey.path, signingKeyId: "system" } });
    const bytes = buildPackage({ source: { id: "bank-uat-system", name: "UAT system baseline" }, guardrail: { id: DEFAULT_GUARDRAIL_ID, name: "Default Guardrail" },
      exportedAt: new Date(), sign: signer.sign, versions });
    const preview = await prod.packages.inspectUpload(bytes, "admin");
    expect(preview.blockers).toEqual([]);
    await prod.packages.importPackage(preview.packageId, { actorId: "admin" });
    // An authorized source adds a version to the local Default; import alone never changes basic protection.
    expect((await prodDb.pool.query("SELECT origin FROM guardrail WHERE id = $1", [DEFAULT_GUARDRAIL_ID])).rows).toEqual([{ origin: "local" }]);
    expect((await prodDb.pool.query("SELECT origin FROM guardrail_version WHERE guardrail_id = $1 AND version = $2", [DEFAULT_GUARDRAIL_ID, published[0]])).rows).toEqual([{ origin: "imported" }]);
    expect(await prod.systemBaseline()).toMatchObject({ version: null });
    const before = await prod.desiredStateForPool("default");
    // Like any imported version, it serves only once released here.
    await expect(prod.setSystemBaseline({ version: published[0]!, reason: "CR-7", actorId: "admin" })).rejects.toMatchObject({ code: "baseline_version_not_ready" });
    await testHere(DEFAULT_GUARDRAIL_ID, published[0]!, "passed");
    await prod.releaseGuardrailVersion({ guardrailId: DEFAULT_GUARDRAIL_ID, version: published[0]!, actorId: "admin" });

    const baseline = await prod.setSystemBaseline({ version: published[0]!, reason: "CR-7 adopt UAT baseline", actorId: "admin" });
    expect(baseline).toEqual({ guardrailId: DEFAULT_GUARDRAIL_ID, version: published[0] });
    const after = await prod.desiredStateForPool("default");
    expect(after.artifacts.length).toBe(before.artifacts.length + 1);
    expect(after.artifacts.some(item => item.guardrailId === DEFAULT_GUARDRAIL_ID && item.guardrailVersion === published[0])).toBe(true);
    const { rows: [audit] } = await prodDb.pool.query("SELECT detail FROM audit_event WHERE kind = 'system.baseline_changed'");
    expect(audit.detail).toMatchObject({ previousVersion: null, version: published[0], reason: "CR-7 adopt UAT baseline" });
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
    const service = new ControlPlaneService(database.db, environment(prodArtifactKey.path, { CONTROLLER_PACKAGE_TRUST_PATH: trustPath, CONTROLLER_POLICY_CATALOG_DIR: dir }));
    return { database, service, cleanup: async () => { await database.drop(); rmSync(dir, { recursive: true, force: true }); } };
  }

  it("keeps a catalog version this installation no longer ships as a read-only version of that Policy", async () => {
    const next = await installationWith("next", policy => { policy.version = "2.1.0"; });
    try {
      const { bytes } = await uat.packages.exportPackage(guardrailId, [published[0]!]);
      const preview = await next.service.packages.inspectUpload(bytes, "admin");
      expect(preview.policies.find(node => node.id === "local-network-addresses")).toMatchObject({ version: "2.0.0", state: "new" });
      await next.service.packages.importPackage(preview.packageId, { actorId: "admin" });
      const { rows } = await next.database.pool.query("SELECT policy_id, version, source_id FROM policy_imported_version");
      expect(rows).toEqual([{ policy_id: "local-network-addresses", version: "2.0.0", source_id: "bank-uat" }]);
      // The Library lists the shipped version, with the imported one as a pinned, read-only version.
      const policy = (await next.service.listPolicies()).find(item => item.id === "local-network-addresses")!;
      expect(policy.version).toBe("2.1.0");
      expect(policy.published_versions?.find(item => item.version === "2.0.0")).toMatchObject({ origin: "imported", source_id: "bank-uat" });
      expect((await next.service.getPolicy("local-network-addresses")).published_versions?.some(item => item.version === "2.0.0")).toBe(true);
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
      expect(preview.policies.find(node => node.id === STUDIO)!.state).toBe("conflict");
      expect(new Set(preview.blockers.map(item => item.code))).toEqual(new Set(["policy_version_conflict", "policy_ownership_conflict"]));
      await expect(diverged.service.packages.importPackage(preview.packageId, { actorId: "admin" })).rejects.toMatchObject({ code: expect.stringMatching(/^policy_(version|ownership)_conflict$/) });
      for (const table of ["guardrail_version", "policy_version", "policy_imported_version"]) {
        expect((await diverged.database.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, table).toBe(0);
      }
    } finally {
      await diverged.cleanup();
    }
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
      // The imported 2.0.0 catalog node is usable even though this installation ships 2.1.0.
      const candidate = await service.playgroundDraftCandidate(guardrailId);
      expect(candidate.plan).toBeTruthy();
      await service.previewGuardrailPlan({ draftConfig: original.draftConfig, runtimeProfile: original.runtimeProfile });
      const run = await service.requestVersionTestRun({ guardrailId, version: chosen.version, actorId: "admin" });
      await service.completeValidation({ runId: run.id, status: "passed", metrics: emptyValidationMetrics(run.metrics.total), results: [] });
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
      await service.completeValidation({ runId: draftRun.id, status: "passed", metrics: emptyValidationMetrics(draftRun.metrics.total), results: [],
        candidateArtifact: { ...chosen.content, guardrailVersion: draftRun.guardrailVersion, plan: request.payload.plan },
        runtime: { runnerId: "prod-runner", runnerVersion: "1.0.0", nemoVersion: "0.24.0", modelRevisionId: "", compilerModelTypes: [] } });
      const publishedHere = await service.requestGuardrailPublish({ guardrailId, expectedDraftRevision: editedDraft.draftRevision, actorId: "admin" });
      expect(publishedHere).toMatchObject({ status: "ready" });
      expect((await database.pool.query("SELECT origin FROM guardrail_version WHERE guardrail_id=$1 AND version=$2", [guardrailId, publishedHere.version])).rows).toEqual([{ origin: "local" }]);
      expect(await service.getGuardrail(guardrailId)).toMatchObject({ origin: "imported", sourceId: "bank-uat", hasUnpublishedChanges: false, latestValidationRun: { id: draftRun.id, subject: "draft" } });
      expect((await database.pool.query("SELECT plan, test_suite, inspection FROM guardrail_version WHERE guardrail_id=$1 AND version=$2", [guardrailId, chosen.version])).rows).toEqual(frozen);
      const exporter = new ControlPlaneService(database.db, { ...prodConfig, packageExport: { ...uatConfig.packageExport!, sourceId: "bank-prod", sourceName: "Bank Production" } });
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

  it("applies the same report deletion and pending lifecycle to an imported version", async () => {
    const next = await installationWith("report_delete", () => {});
    try {
      const { bytes } = await uat.packages.exportPackage(guardrailId, [published[0]!]);
      const preview = await next.service.packages.inspectUpload(bytes, "admin");
      await next.service.packages.importPackage(preview.packageId, { actorId: "admin" });
      const run = await next.service.requestVersionTestRun({ guardrailId, version: published[0]!, actorId: "admin" });
      await next.service.completeValidation({ runId: run.id, status: "passed", metrics: emptyValidationMetrics(run.metrics.total), results: [] });
      await next.service.releaseGuardrailVersion({ guardrailId, version: published[0]!, actorId: "admin" });
      expect(await next.service.getGuardrail(guardrailId)).toMatchObject({ latestTestingReport: { id: run.id }, latestValidationRun: null });
      await next.service.deleteTestingReport({ runId: run.id, actorId: "admin", expectedPendingVersion: published[0]! });
      expect((await next.service.getGuardrail(guardrailId)).versions[0]).toMatchObject({ status: "pending", origin: "imported", validationRunId: null });
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
      await service.completeValidation({ runId: run.id, status: "passed", metrics: emptyValidationMetrics(run.metrics.total), results: [] });
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
        .rejects.toMatchObject({ code: "guardrail_version_test_required" });
      expect(await service.desiredGeneration()).toBe(generation + 1);
      expect((await database.pool.query("SELECT * FROM audit_event WHERE kind = 'guardrail.restored'")).rows).toHaveLength(1);
      expect((await database.pool.query("SELECT payload FROM controller_outbox WHERE payload->>'restored' = 'true'")).rows).toHaveLength(1);
      expect((await service.trafficRouting.list()).length).toBe(0);
      expect(await service.systemBaseline()).toEqual({ guardrailId: DEFAULT_GUARDRAIL_ID, version: null });
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
      await service.completeValidation({ runId: runningId, status: "passed", metrics: emptyValidationMetrics(1), results: [] });
      await service.updateValidationProgress(runningId, { phase: "executing", completedCases: 1, passedCases: 1 });
      await service.markValidationRunning(runningId);
      await service.recordRuntimeEvents([runtime("old-runtime")]);
      // Completion arrives now but belongs to a call assigned before restoration.
      await service.trafficRouting.recordEvents([call("old-call")]);
      expect(await service.listValidationRuns(guardrailId)).toEqual([]);
      for (const table of ["runtime_event", "route_assignment"]) expect((await database.pool.query(`SELECT * FROM ${table} WHERE guardrail_id=$1`, [guardrailId])).rows).toEqual([]);
      await expect(service.releaseGuardrailVersion({ guardrailId, version: published[0]!, actorId: "admin" })).rejects.toMatchObject({ code: "guardrail_version_test_required" });
      const fresh = await service.requestVersionTestRun({ guardrailId, version: published[0]!, actorId: "admin" });
      expect(fresh.id).not.toBe(runningId);
      await service.completeValidation({ runId: fresh.id, status: "passed", metrics: emptyValidationMetrics(fresh.metrics.total), results: [] });
      const released = await service.releaseGuardrailVersion({ guardrailId, version: published[0]!, actorId: "admin" });
      expect(released.validationRunId).toBe(fresh.id);
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

  it("keeps a deleted resource deleted when source ownership or version content conflicts", async () => {
    const { database, service, bytes, packageId } = await deletedInstallation();
    try {
      for (const ownership of [{ origin: "local", source: null }, { origin: "imported", source: "bank-uat-b" }]) {
        await database.pool.query("UPDATE guardrail SET origin=$2, source_id=$3 WHERE id=$1", [guardrailId, ownership.origin, ownership.source]);
        expect((await service.packages.previewPackage(packageId)).blockers.map(item => item.code)).toContain("guardrail_ownership_conflict");
        await expect(service.packages.importPackage(packageId, { actorId: "admin", restoreDeleted: true })).rejects.toMatchObject({ code: "guardrail_ownership_conflict" });
      }
      await database.pool.query("UPDATE guardrail SET origin='imported', source_id='bank-uat' WHERE id=$1", [guardrailId]);
      const parsed = parsePackage(bytes);
      const altered = buildPackage({ source: parsed.manifest.source, guardrail: parsed.manifest.guardrail, exportedAt: new Date(), sign: packageSigner(uatConfig).sign,
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
      const third = buildPackage({ source: parsed.manifest.source, guardrail: parsed.manifest.guardrail, exportedAt: new Date(), sign: packageSigner(uatConfig).sign,
        versions: [rebuilt(parsed, item, { ...item.content, guardrailVersion: thirdVersion, plan: { ...item.content.plan, guardrail_version: thirdVersion } })] });
      const other = await service.packages.inspectUpload(third, "admin");
      expect(other.blockers).toEqual([]);
      const combined = buildPackage({ source: parsed.manifest.source, guardrail: parsed.manifest.guardrail, exportedAt: new Date(), sign: packageSigner(uatConfig).sign,
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
      await service.completeValidation({ runId: run.id, status: "passed", metrics: emptyValidationMetrics(run.metrics.total), results: [] });
      await expect(service.releaseGuardrailVersion({ guardrailId, version: published[0]!, actorId: "admin" })).resolves.toBeTruthy();
      await service.deleteGuardrailVersion({ guardrailId, version: "retained-1", actorId: "admin" });
      expect((await service.packages.previewPackage(blockedId)).blockers).toEqual([]);
      await expect(service.packages.importPackage(blockedId, { actorId: "admin" })).resolves.toBeTruthy();
      expect((await database.pool.query("SELECT count(*)::int AS n FROM guardrail_version WHERE guardrail_id=$1", [guardrailId])).rows[0].n).toBe(10);
    } finally { await database.drop(); }
  });

});
