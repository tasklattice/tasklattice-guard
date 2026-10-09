// @vitest-environment node
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { artifactContentDigest, verifyArtifactDigest, type ArtifactContent } from "../domain/artifact-content.js";
import { DEFAULT_GUARDRAIL_ID, defaultGuardrailDraft } from "../domain/defaults.js";
import { buildPackage, parsePackage } from "../domain/guardrail-package.js";
import { emptyValidationMetrics } from "../domain/validation.js";
import { readZip, writeZip } from "../domain/zip.js";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { ControlPlaneService } from "./control-plane.js";
import { packageSigner } from "./package-trust.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
const catalogDir = resolve("../runner/toolkit/policy_library/assets");
const protoPath = resolve("../proto/tasklattice/guard/control/v1/runner_control.proto");

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
    const draft = defaultGuardrailDraft(policies);
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

  it("exports byte-identical version files and a deterministic layout", async () => {
    const first = await uat.packages.exportPackage(guardrailId, published);
    const second = await uat.packages.exportPackage(guardrailId, published);
    const filesOf = (bytes: Buffer) => [...readZip(bytes, { maxEntries: 64, maxEntryBytes: 1 << 24, maxTotalBytes: 1 << 26 })].filter(([path]) => path.startsWith("versions/"));
    expect(filesOf(first.bytes)).toEqual(filesOf(second.bytes));
    expect(filesOf(first.bytes).map(([path]) => path)).toEqual(published.flatMap(version => ["artifact", "inspection", "requirements", "uat-evidence"].map(file => `versions/${version}/${file}.json`)));
    const parsed = parsePackage(first.bytes);
    expect(parsed.manifest).toMatchObject({ source: { id: "bank-uat" }, guardrail: { id: guardrailId, name: "Bank assistant" } });
    expect(parsed.manifest).not.toHaveProperty("recommendedVersion");
    expect(parsed.versions[0]!.evidence).toMatchObject({ status: "passed", source: { id: "bank-uat" }, runtime: { runnerId: "uat-runner-0" } });
  });

  it("refuses to export versions that cannot prove what was tested", async () => {
    await uatDb.pool.query("UPDATE guardrail_validation_run SET candidate_digest = NULL WHERE guardrail_version = $1", [published[0]]);
    await expect(uat.packages.exportPackage(guardrailId, published)).rejects.toMatchObject({
      code: "guardrail_package_incomplete", detail: { versions: [{ version: published[0], missing: ["tested_candidate_evidence"] }] },
    });
    await uatDb.pool.query("UPDATE guardrail_validation_run r SET candidate_digest = a.checksum FROM guardrail_version v JOIN guardrail_artifact a ON a.id = v.artifact_id WHERE r.id = v.validation_run_id");
  });

  it("imports released versions as they are, preserving digests but signing locally", async () => {
    const { bytes } = await uat.packages.exportPackage(guardrailId, published);
    const preview = await prod.packages.inspectUpload(bytes, "admin");
    expect(preview).toMatchObject({ source: { id: "bank-uat" }, keyId: "uat-2026", guardrail: { id: guardrailId, exists: false }, blockers: [] });
    expect(preview.versions.map(item => [item.version, item.state, item.environment?.status])).toEqual(published.map(version => [version, "new", "pending"]));

    const result = await prod.packages.importPackage(preview.packageId, { actorId: "admin" });
    expect(result).toEqual({ guardrailId, imported: published, existing: [] });

    const uatArtifacts = (await uatDb.pool.query("SELECT guardrail_version, checksum, signature, generation FROM guardrail_artifact ORDER BY guardrail_version")).rows;
    const prodArtifacts = (await prodDb.pool.query("SELECT guardrail_version, checksum, signature, generation, content_digest_version FROM guardrail_artifact ORDER BY guardrail_version")).rows;
    expect(prodArtifacts.map(row => row.checksum)).toEqual(uatArtifacts.map(row => row.checksum));
    for (const [index, row] of prodArtifacts.entries()) {
      expect(row.signature).not.toBe(uatArtifacts[index].signature);
      expect(verifyArtifactDigest(row.checksum, row.signature, prodArtifactKey.publicKeyPem)).toBe(true);
      expect(row.content_digest_version).toBe(2);
    }
    const { rows: [guardrail] } = await prodDb.pool.query("SELECT origin, source_id, status FROM guardrail WHERE id = $1", [guardrailId]);
    expect(guardrail).toEqual({ origin: "imported", source_id: "bank-uat", status: "active" });
    const { rows: provenance } = await prodDb.pool.query("SELECT version, source_id, source_key_id, uat_evidence->>'status' AS status FROM guardrail_version_provenance ORDER BY version");
    expect(provenance).toEqual(published.map(version => ({ version, source_id: "bank-uat", source_key_id: "uat-2026", status: "passed" })));
    // Import neither distributes nor routes anything, and creates no test or compile work.
    expect((await prodDb.pool.query("SELECT kind FROM controller_outbox WHERE aggregate_id = $1", [guardrailId])).rows).toEqual([]);
    expect((await prodDb.pool.query("SELECT count(*)::int AS n FROM guardrail_validation_run WHERE guardrail_id = $1", [guardrailId])).rows[0].n).toBe(0);
    expect((await prodDb.pool.query("SELECT count(*)::int AS n FROM policy_record")).rows[0].n).toBe(0);
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
      versions: altered.map(item => ({ content: item.content, inspection: item.inspection, evidence: { ...item.evidence, contentDigest: artifactContentDigest(item.content) } })),
    });
    const before = (await prodDb.pool.query("SELECT count(*)::int AS n FROM guardrail_version")).rows[0].n;
    const preview = await prod.packages.inspectUpload(bytes, "admin");
    expect(preview.versions.map(item => item.state)).toEqual(["existing", "conflict"]);
    expect(preview.blockers.map(item => item.code)).toEqual(["guardrail_version_conflict"]);
    await expect(prod.packages.importPackage(preview.packageId, { actorId: "admin" })).rejects.toMatchObject({ code: "guardrail_version_conflict" });
    expect((await prodDb.pool.query("SELECT count(*)::int AS n FROM guardrail_version")).rows[0].n).toBe(before);
  });

  it.each([
    ["a tampered byte", (bytes: Buffer) => { const files = readZip(bytes, { maxEntries: 64, maxEntryBytes: 1 << 24, maxTotalBytes: 1 << 26 }); const path = [...files.keys()].find(item => item.endsWith("artifact.json"))!; files.set(path, Buffer.from(files.get(path)!.toString().replace("models: []", "models: [ ]"))); return writeZip(files); }, "guardrail_package_digest_mismatch"],
    ["an undeclared file", (bytes: Buffer) => { const files = readZip(bytes, { maxEntries: 64, maxEntryBytes: 1 << 24, maxTotalBytes: 1 << 26 }); files.set("versions/extra.json", Buffer.from("{}\n")); return writeZip(files); }, "guardrail_package_undeclared_content"],
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
    const reserved = (id: string) => parsed.versions.map(item => {
      const plan = { ...item.content.plan, guardrail_id: id };
      const content = { ...item.content, guardrailId: id, plan };
      return { content, inspection: item.inspection, evidence: { ...item.evidence, guardrailId: id, contentDigest: artifactContentDigest(content) } };
    });
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

    // Without a Policy Library, the Policies come from the imported versions.
    const { items } = await prod.releasedPolicies();
    const removed = items.find(policy => policy.versions.some(item => item.usage.some(use => use.guardrailVersion === published[0]) && !item.usage.some(use => use.guardrailVersion === version)));
    expect(removed, "The first Policy only v1 still uses is listed, not serving.").toBeDefined();
    expect(removed!.serving).toBe(false);
    const serving = items.filter(policy => policy.serving);
    expect(serving.length).toBeGreaterThan(0);
    for (const policy of serving) {
      expect(policy.versions[0]!.usage[0]).toMatchObject({ guardrailId, guardrailVersion: version, origin: "imported", sourceId: "bank-uat", serving: true });
      expect(policy.versions[0]!.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("imports a Default only from an authorized source and switches the baseline explicitly", async () => {
    const parsed = parsePackage((await uat.packages.exportPackage(guardrailId, [published[0]!])).bytes);
    const versions = parsed.versions.map(item => {
      const content = { ...item.content, guardrailId: DEFAULT_GUARDRAIL_ID, plan: { ...item.content.plan, guardrail_id: DEFAULT_GUARDRAIL_ID } };
      return { content, inspection: item.inspection, evidence: { ...item.evidence, guardrailId: DEFAULT_GUARDRAIL_ID, source: { id: "bank-uat-system", name: "UAT system baseline" }, contentDigest: artifactContentDigest(content) } };
    });
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

    const baseline = await prod.setSystemBaseline({ version: published[0]!, reason: "CR-7 adopt UAT baseline", actorId: "admin" });
    expect(baseline).toEqual({ guardrailId: DEFAULT_GUARDRAIL_ID, version: published[0] });
    const after = await prod.desiredStateForPool("default");
    expect(after.artifacts.length).toBe(before.artifacts.length + 1);
    expect(after.artifacts.some(item => item.guardrailId === DEFAULT_GUARDRAIL_ID && item.guardrailVersion === published[0])).toBe(true);
    const { rows: [audit] } = await prodDb.pool.query("SELECT detail FROM audit_event WHERE kind = 'system.baseline_changed'");
    expect(audit.detail).toMatchObject({ previousVersion: null, version: published[0], reason: "CR-7 adopt UAT baseline" });
  });
});

