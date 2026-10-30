vi.mock("./testing-report-retention.js", async importOriginal => ({ ...await importOriginal<typeof import("./testing-report-retention.js")>(), pruneTestingReports: vi.fn() }));
import { resolve } from "node:path";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { getTableName } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ControllerConfig } from "../config.js";
import type { ControllerDatabase } from "../db/client.js";
import { defaultGuardrailDraft } from "../domain/defaults.js";
import { buildGuardrailPlan, normalizeGuardrailDraft } from "../domain/guardrail-plan.js";
import { emptyValidationMetrics, generatedTestCases } from "../domain/validation.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { ControlPlaneService } from "./control-plane.js";
import { artifactContentDigest } from "../domain/artifact-content.js";
import { canonicalArtifactContent } from "../control-channel/artifact-codec.js";
import { freezeTestSuite, testSuiteDigest } from "../domain/test-suite.js";

const policyCatalogDir = resolve("../runner/toolkit/policy_library/assets");
const policies = PolicyCatalog.load(policyCatalogDir).list();
const baseline = () => ({
  id: "guardrail-default", draftRevision: 2, draftConfig: normalizeGuardrailDraft(defaultGuardrailDraft(policies)),
  status: "draft", excludedTestCaseIds: [],
  runtimeProfile: "auto", deletedAt: null,
});

const keyDirectory = mkdtempSync(resolve(tmpdir(), "guard-baseline-signing-test-"));
const keyPath = resolve(keyDirectory, "key.pem");
const keyPair = generateKeyPairSync("ed25519");
const publicKey = keyPair.publicKey;
writeFileSync(keyPath, keyPair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
afterAll(() => rmSync(keyDirectory, { recursive: true, force: true }));

/** The frozen suite a passed run executed. */
const suite = freezeTestSuite(generatedTestCases("guardrail-default", baseline().draftConfig, policies).slice(0, 1) as never);

/** A compiled candidate exactly as a Runner returns it with a passed run. */
function candidate() {
  const guardrailVersion = "20260906-010000.001Z";
  return { guardrailId: "guardrail-default", guardrailVersion, compilerVersion: "tasklattice-nemo-config-v29-single-contract", nemoVersion: "0.24.0",
    runtimeProfile: "llmrails_colang1_standard",
    plan: buildGuardrailPlan({ guardrailId: "guardrail-default", guardrailVersion, draft: baseline().draftConfig, policies }),
    configYaml: "", colangContent: "", prompts: [] as unknown[], actionBindings: [] as unknown[], dependencyManifest: [] as unknown[] };
}

function harness(reads: unknown[][], config: Partial<ControllerConfig> = {}, updateRows: Record<string, unknown[]> = {}, versionCount = 0) {
  const inserts: Array<{ table: string; value: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; value: Record<string, unknown> }> = [];
  const builder = (rows: () => unknown[]) => {
    const query: Record<string, unknown> = {};
    for (const method of ["from", "innerJoin", "where", "orderBy", "limit", "for", "returning", "onConflictDoNothing"]) query[method] = () => query;
    query.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(rows()).then(resolve, reject);
    return query;
  };
  const tx = {
    select: vi.fn((fields?: Record<string, unknown>) => {
      let tableName = "";
      const query = builder(() => {
        if (["policy_imported_version", "policy_resource", "policy_resource_version"].includes(tableName)) return [];
        if (fields && Object.keys(fields).length === 1 && "count" in fields) return [{ count: versionCount }];
        const next = reads.shift();
        if (!next) throw new Error("Unexpected database read in preconfigured Guardrail initialization.");
        return next;
      });
      query.from = (table: Parameters<typeof getTableName>[0]) => { tableName = getTableName(table); return query; };
      return query;
    }),
    insert: vi.fn((table) => {
      let stored: Record<string, unknown>;
      const query = builder(() => getTableName(table) === "guardrail_artifact" ? [stored] : []);
      query.values = (value: Record<string, unknown>) => { stored = value; inserts.push({ table: getTableName(table), value }); return query; };
      return query;
    }),
    update: vi.fn((table) => {
      const query = builder(() => updateRows[getTableName(table)] ?? [{ desiredGeneration: 10 }]);
      query.set = (value: Record<string, unknown>) => { updates.push({ table: getTableName(table), value }); return query; };
      return query;
    }),
    delete: vi.fn(() => builder(() => [])),
    execute: vi.fn(async () => []),
  };
  const db = { ...tx, transaction: vi.fn(async (callback) => callback(tx)) } as unknown as ControllerDatabase;
  const service = new ControlPlaneService(db, { policyCatalogDir, protoPath: resolve("../proto/tasklattice/guard/control/v1/runner_control.proto"), ...config } as ControllerConfig);
  return { service, inserts, updates, reads };
}

describe("Preconfigured Guardrail initialization", () => {
  it.each(["draft", "active", "disabled", "deleted"])("never changes an existing %s Guardrail on startup", async status => {
    const stored = { ...baseline(), name: "My edited Default", status: status === "deleted" ? "disabled" : status,
      deletedAt: status === "deleted" ? new Date() : null };
    const test = harness([[stored]]);
    await test.service.initialize();
    expect(test.reads).toEqual([]);
    expect(test.updates).toEqual([]);
    expect(test.inserts.map(item => item.table)).toEqual(["controller_state", "runner_pool"]);
  });

  it.each([null, "user"])("does not auto-publish a completed test (actor %s)", async createdBy => {
    const content = candidate();
    const run = { id: "validation-1", guardrailId: "guardrail-default", guardrailVersion: content.guardrailVersion, createdBy, status: "running", subject: "draft" };
    const test = harness([[], [{ guardrailId: run.guardrailId }], [{ id: run.guardrailId }], [run], [{ plan: content.plan, runtimeProfile: "auto" }]]);
    const initialize = vi.spyOn(test.service, "initialize");
    await test.service.completeValidation({ runId: run.id, status: "passed", metrics: emptyValidationMetrics(), results: [], candidateArtifact: content });
    expect(initialize).not.toHaveBeenCalled();
    expect(test.inserts.some(item => item.table === "guardrail_version")).toBe(false);
  });
});

describe("Validated candidate gate", () => {
  const run = { id: "validation-1", guardrailId: "guardrail-default", guardrailVersion: "20260906-010000.001Z", createdBy: "admin", status: "running", subject: "draft" };
  const request = (plan: Record<string, unknown>, runtimeProfile = "auto") => [{ plan, runtimeProfile }];
  const complete = (test: ReturnType<typeof harness>, candidateArtifact?: ReturnType<typeof candidate>) => test.service.completeValidation({
    runId: run.id, status: "passed", metrics: emptyValidationMetrics(), results: [], candidateArtifact,
    runtime: { runnerId: "runner-0", runnerVersion: "1.0.0", nemoVersion: "0.24.0", modelRevisionId: "", compilerModelTypes: [] },
  });
  const stored = (test: ReturnType<typeof harness>) => test.updates.find((item) => item.table === "guardrail_validation_run")!.value;

  it("stores the exact tested candidate and its digest", async () => {
    const content = candidate();
    const test = harness([[], [{ guardrailId: run.guardrailId }], [{ id: run.guardrailId }], [run], request(content.plan)]);
    await complete(test, content);
    // Stored exactly as a Runner decodes it from the wire.
    const decoded = canonicalArtifactContent(content, resolve("../proto/tasklattice/guard/control/v1/runner_control.proto"));
    expect(stored(test)).toMatchObject({ status: "passed", candidateArtifact: decoded, candidateDigest: artifactContentDigest(decoded),
      runtimeFingerprint: expect.objectContaining({ nemoVersion: "0.24.0" }) });
  });

  it("retains a compiled failed candidate without changing its test outcome", async () => {
    const content = candidate();
    const test = harness([[], [{ guardrailId: run.guardrailId }], [{ id: run.guardrailId }], [run], request(content.plan)]);
    const results = [{ caseId: "limited", passed: false, reason: "http_429" }];
    await test.service.completeValidation({ runId: run.id, status: "failed", metrics: emptyValidationMetrics(), results: results as never, candidateArtifact: content });
    expect(stored(test)).toMatchObject({ status: "failed", results, candidateDigest: expect.any(String), candidateArtifact: expect.any(Object) });
    expect(test.updates.some(item => item.table === "controller_state")).toBe(false);
  });

  it.each([
    ["missing", undefined, undefined],
    ["changed Rule action", (plan: Record<string, unknown>) => { (plan.steps as Array<{ on_unsafe: string }>)[0]!.on_unsafe = "allow"; }, undefined],
    ["other version", undefined, "20260906-020000.000Z"],
  ] as const)("fails a passed run whose candidate is %s", async (name, mutate, otherVersion) => {
    const content = candidate();
    if (mutate) mutate(content.plan);
    if (otherVersion) content.guardrailVersion = otherVersion;
    const test = harness([[], [{ guardrailId: run.guardrailId }], [{ id: run.guardrailId }], [run], request(candidate().plan)]);
    await complete(test, name === "missing" ? undefined : content);
    expect(stored(test)).toMatchObject({ status: "failed", failureReason: expect.any(String) });
    expect(stored(test)).not.toHaveProperty("candidateArtifact");
  });

  it("fails a candidate compiled for a different runtime profile than requested", async () => {
    const test = harness([[], [{ guardrailId: run.guardrailId }], [{ id: run.guardrailId }], [run], request(candidate().plan, "iorails_native")]);
    await complete(test, candidate());
    expect(stored(test)).toMatchObject({ status: "failed" });
  });
});

describe("Publishing the validated candidate", () => {
  const stored = { ...baseline(), id: "guardrail-custom" };
  const content = { ...candidate(), guardrailId: stored.id };
  content.plan.guardrail_id = stored.id;
  const validation = { id: "validation-1", status: "passed", guardrailVersion: content.guardrailVersion, sourceDraftRevision: 2,
    candidateArtifact: content, candidateDigest: artifactContentDigest(content), candidateInspection: { testSuite: { total: 1, digest: testSuiteDigest(suite) } }, candidatePolicies: [], testSuite: suite };

  it("signs and publishes the tested content without rebuilding it from the draft or Library", async () => {
    const test = harness([[stored], [], [validation], [stored], [], []], { artifactSigningKeyPath: keyPath, policyCatalogDir: "/nonexistent-policy-library" });
    await expect(test.service.requestGuardrailPublish({ guardrailId: stored.id, actorId: "user" }))
      .resolves.toMatchObject({ status: "ready", version: content.guardrailVersion });
    const artifact = test.inserts.find((item) => item.table === "guardrail_artifact")!.value;
    expect(artifact).toMatchObject({ ...content, checksum: validation.candidateDigest });
    expect(verify(null, Buffer.from(String(artifact.checksum)), publicKey, Buffer.from(String(artifact.signature), "base64"))).toBe(true);
    expect(test.inserts).toContainEqual({ table: "guardrail_version", value: expect.objectContaining({ plan: content.plan, status: "ready", validationRunId: validation.id, inspection: validation.candidateInspection, policies: validation.candidatePolicies, testSuite: suite }) });
    expect(test.inserts.some((item) => item.value.kind === "guardrail.compile_requested")).toBe(false);
    expect(test.reads).toEqual([]);
  });

  it.each(["passed", "failed"])("compiles independently when a %s run has no candidate", async status => {
    const test = harness([[stored], [], [{ ...validation, status, candidateArtifact: null }], generatedTestCases(stored.id, stored.draftConfig, policies), [stored], [], []], { artifactSigningKeyPath: keyPath });
    const compiler = vi.fn(async input => ({ ...content, guardrailVersion: input.guardrailVersion, plan: input.plan }));
    test.service.setArtifactCompiler(compiler);
    await expect(test.service.requestGuardrailPublish({ guardrailId: stored.id, actorId: "user" })).resolves.toMatchObject({ status: "ready" });
    expect(compiler).toHaveBeenCalledOnce();
    expect(test.inserts.find(item => item.table === "guardrail_version")!.value.validationRunId).toBeNull();
    expect(test.inserts.some(item => item.table === "guardrail_validation_run")).toBe(false);
  });

  it("rejects a candidate whose frozen suite no longer matches its inspection", async () => {
    const test = harness([[stored], [], [{ ...validation, testSuite: [{ ...suite[0]!, content: "changed" }] }], [stored], []]);
    await expect(test.service.requestGuardrailPublish({ guardrailId: stored.id, actorId: "user" }))
      .rejects.toMatchObject({ code: "guardrail_compilation_failed" });
    expect(test.inserts).toEqual([]);
  });

  it("refuses a stored candidate that no longer matches its digest", async () => {
    const test = harness([[stored], [], [{ ...validation, candidateDigest: "0".repeat(64) }], [stored], []], { artifactSigningKeyPath: keyPath });
    await expect(test.service.requestGuardrailPublish({ guardrailId: stored.id, actorId: "user" }))
      .rejects.toMatchObject({ code: "guardrail_candidate_corrupt" });
    expect(test.inserts).toEqual([]);
  });
});
