import { resolve } from "node:path";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
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

const policyCatalogDir = resolve("../runner/toolkit/policy_library/assets");
const policies = PolicyCatalog.load(policyCatalogDir).list();
const baseline = () => ({
  id: "guardrail-default", draftRevision: 2, draftConfig: normalizeGuardrailDraft(defaultGuardrailDraft(policies)),
  status: "draft", latestVersion: null, latestArtifactId: null, excludedTestCaseIds: [],
  runtimeProfile: "auto", deletedAt: null,
});

function legacyBaseline() {
  const { policyIds } = JSON.parse(readFileSync(resolve("../tests/fixtures/default-policy-migration.json"), "utf8")) as { policyIds: string[] };
  return { ...baseline(), draftConfig: normalizeGuardrailDraft({
    ...baseline().draftConfig,
    policyBindings: policyIds.map((id) => {
      const policy = policies.find((item) => item.id === id)!;
      return { policyId: id, policyVersion: policy.version, action: null, parameterValues: {},
        enabledRuleIds: policy.rules.map((rule) => rule.id), ruleOrder: [], ruleActions: {},
        enabledRails: policy.rails, reasoningPolicy: null };
    }),
  }) };
}

const keyDirectory = mkdtempSync(resolve(tmpdir(), "guard-baseline-signing-test-"));
const keyPath = resolve(keyDirectory, "key.pem");
const keyPair = generateKeyPairSync("ed25519");
const publicKey = keyPair.publicKey;
writeFileSync(keyPath, keyPair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
afterAll(() => rmSync(keyDirectory, { recursive: true, force: true }));

/** A compiled candidate exactly as a Runner returns it with a passed run. */
function candidate() {
  const guardrailVersion = "20260906-010000.001Z";
  return { guardrailId: "guardrail-default", guardrailVersion, compilerVersion: "compiler", nemoVersion: "0.24.0",
    runtimeProfile: "llmrails_colang1_standard",
    plan: buildGuardrailPlan({ guardrailId: "guardrail-default", guardrailVersion, draft: baseline().draftConfig, policies }),
    configYaml: "", colangContent: "", prompts: [] as unknown[], actionBindings: [] as unknown[], dependencyManifest: [] as unknown[] };
}

function harness(reads: unknown[][], config: Partial<ControllerConfig> = {}, updateRows: Record<string, unknown[]> = {}) {
  const inserts: Array<{ table: string; value: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; value: Record<string, unknown> }> = [];
  const builder = (rows: () => unknown[]) => {
    const query: Record<string, unknown> = {};
    for (const method of ["from", "where", "orderBy", "limit", "for", "returning", "onConflictDoNothing"]) query[method] = () => query;
    query.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(rows()).then(resolve, reject);
    return query;
  };
  const tx = {
    select: vi.fn(() => builder(() => {
      const next = reads.shift();
      if (!next) throw new Error("Unexpected database read in baseline reconciliation.");
      return next;
    })),
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

describe("Default baseline validation gate", () => {
  it.each(["missing", "failed"])("migrates the system-owned mixed Default through validation, retaining the old release (%s validation)", async (validationStatus) => {
    const stored = { ...legacyBaseline(), status: "active", latestVersion: "legacy", latestArtifactId: "legacy-artifact" };
    const upgraded = { ...stored, draftRevision: 3, draftConfig: baseline().draftConfig };
    const cases = generatedTestCases(stored.id, upgraded.draftConfig, policies);
    const reads: unknown[][] = [[stored], [], [{ sourceDraftRevision: 2 }], validationStatus === "failed" ? [{ status: "failed" }] : []];
    if (validationStatus === "missing") reads.push(cases, [{ id: "new-validation" }]);
    const test = harness(reads, {}, { guardrail: [upgraded] });
    await test.service.initialize();
    expect(test.reads).toEqual([]);
    expect(test.updates).toEqual([{ table: "guardrail", value: expect.objectContaining({
      draftConfig: defaultGuardrailDraft(policies), excludedTestCaseIds: [],
    }) }]);
    expect(test.updates.some((item) => "latestArtifactId" in item.value || "latestVersion" in item.value)).toBe(false);
    expect(test.inserts.some((item) => ["guardrail_version", "router"].includes(item.table))).toBe(false);
    expect(test.inserts).toContainEqual({ table: "guardrail_test_case", value: cases });
    expect(test.inserts).toContainEqual({ table: "audit_event", value: expect.objectContaining({
      kind: "guardrail.default.baseline_upgraded", detail: expect.objectContaining({
        draftRevision: 3, policies: upgraded.draftConfig.policyBindings.map((item) => item.policyId),
      }),
    }) });
    const validation = test.inserts.filter((item) => item.table === "guardrail_validation_run");
    expect(validation).toHaveLength(validationStatus === "missing" ? 1 : 0);
    if (validationStatus === "missing") expect(validation[0]!.value).toMatchObject({
      sourceDraftRevision: 3, status: "queued", excludedCaseIds: [], createdBy: null,
      metrics: { total: cases.length, passed: 0 },
    });
    expect(test.inserts.some((item) => item.value.kind === "guardrail.compile_requested" || item.value.kind === "runner.desired_state_changed")).toBe(false);
  });

  it("queues real inherited tests before compiling and does not invent a new draft revision on restart", async () => {
    const stored = baseline();
    const cases = generatedTestCases(stored.id, stored.draftConfig, policies);
    const test = harness([[stored], [], [], cases, [{ id: "stored-validation" }]]);
    await test.service.initialize();
    expect(test.reads).toEqual([]);
    expect(test.updates).toEqual([]);
    expect(test.inserts).toContainEqual({ table: "guardrail_validation_run", value: expect.objectContaining({
      id: expect.stringMatching(/^testing-report-[0-9a-f-]{36}$/),
      guardrailId: stored.id, sourceDraftRevision: 2, status: "queued", createdBy: null,
      excludedCaseIds: [], metrics: expect.objectContaining({ total: cases.length, passed: 0 }),
    }) });
    expect(test.inserts).toContainEqual({ table: "controller_outbox", value: expect.objectContaining({
      kind: "guardrail.validation_requested", payload: expect.objectContaining({ testCases: expect.arrayContaining([expect.objectContaining({ sourcePolicyId: cases[0]!.sourcePolicyId })]) }),
    }) });
    expect(test.inserts.some((item) => item.table === "guardrail_version")).toBe(false);
  });

  it.each(["queued", "running", "failed"])("never compiles around a %s validation or retries it on restart", async (status) => {
    const test = harness([[baseline()], [], [{ status }]]);
    await test.service.initialize();
    expect(test.reads).toEqual([]);
    expect(test.updates).toEqual([]);
    expect(test.inserts.map((item) => item.table)).toEqual(["controller_state", "runner_pool"]);
  });

  it("publishes precisely the validated candidate for the system-owned Default", async () => {
    const stored = { ...baseline(), status: "active", latestVersion: "old", latestArtifactId: "old-artifact" };
    const content = candidate();
    const validation = { id: "validation-new", status: "passed", guardrailVersion: content.guardrailVersion, sourceDraftRevision: 2,
      candidateArtifact: content, candidateDigest: artifactContentDigest(content), candidateInspection: { testSuite: { total: 1, digest: "d" } } };
    const test = harness([[stored], [], [{ sourceDraftRevision: 1 }], [validation], [], []], { artifactSigningKeyPath: keyPath });
    await test.service.initialize();
    expect(test.reads).toEqual([]);
    expect(test.inserts).toContainEqual({ table: "guardrail_artifact", value: expect.objectContaining({
      checksum: validation.candidateDigest, plan: content.plan, generation: 10,
    }) });
    expect(test.inserts).toContainEqual({ table: "guardrail_version", value: expect.objectContaining({
      version: content.guardrailVersion, sourceDraftRevision: 2, status: "ready", createdBy: null, validationRunId: validation.id,
    }) });
    expect(test.inserts).toContainEqual({ table: "audit_event", value: expect.objectContaining({
      kind: "guardrail.published", detail: expect.objectContaining({ validationRunId: validation.id, contentDigest: validation.candidateDigest }),
    }) });
    expect(test.updates).toContainEqual({ table: "guardrail", value: expect.objectContaining({ latestVersion: content.guardrailVersion, status: "active" }) });
    expect(test.inserts.some((item) => item.value.kind === "guardrail.compile_requested")).toBe(false);
  });

  it("does not publish twice when the validated version already exists", async () => {
    const test = harness([[baseline()], [], [{ status: "passed", guardrailVersion: "20260906-010000.001Z" }], [{ version: "20260906-010000.001Z" }]]);
    await test.service.initialize();
    expect(test.reads).toEqual([]);
    expect(test.updates).toEqual([]);
    expect(test.inserts.map((item) => item.table)).toEqual(["controller_state", "runner_pool"]);
  });

  it("tests again instead of publishing a run that passed before candidates were retained", async () => {
    const stored = baseline();
    const cases = generatedTestCases(stored.id, stored.draftConfig, policies);
    const test = harness([[stored], [], [{ status: "passed", guardrailVersion: "20260906-010000.001Z", candidateArtifact: null }], [], cases, [{ id: "retest" }]]);
    await test.service.initialize();
    expect(test.reads).toEqual([]);
    expect(test.inserts.some((item) => item.table === "guardrail_version")).toBe(false);
    expect(test.inserts).toContainEqual({ table: "guardrail_validation_run", value: expect.objectContaining({ status: "queued", createdBy: null }) });
  });

  it("leaves user-authored Default changes to explicit Validate and Publish", async () => {
    const stored = legacyBaseline();
    stored.draftConfig.policyBindings[0]!.ruleActions = { "category/denied_insults": "allow" };
    const original = structuredClone(stored);
    const test = harness([[stored], [{ id: "user-edit" }]]);
    await test.service.initialize();
    expect(test.reads).toEqual([]);
    expect(test.updates).toEqual([]);
    expect(test.inserts.map((item) => item.table)).toEqual(["controller_state", "runner_pool"]);
    expect(stored).toEqual(original);
  });

  it.each([null, "admin-user"])("only resumes automatic publication for system validation (actor %s)", async (createdBy) => {
    const content = candidate();
    const run = { id: "validation-1", guardrailId: "guardrail-default", guardrailVersion: content.guardrailVersion, createdBy, status: "running" };
    const test = harness([[], [run], [{ payload: { plan: content.plan, runtimeProfile: "auto" } }]]);
    const reconcile = vi.spyOn(test.service, "initialize").mockResolvedValue();
    await test.service.completeValidation({ runId: "validation-1", status: "passed", metrics: emptyValidationMetrics(), results: [], candidateArtifact: content });
    expect(reconcile).toHaveBeenCalledTimes(createdBy === null ? 1 : 0);
    expect(test.reads).toEqual([]);
  });
});

describe("Validated candidate gate", () => {
  const run = { id: "validation-1", guardrailId: "guardrail-default", guardrailVersion: "20260906-010000.001Z", createdBy: "admin", status: "running" };
  const request = (plan: Record<string, unknown>, runtimeProfile = "auto") => [{ payload: { plan, runtimeProfile } }];
  const complete = (test: ReturnType<typeof harness>, candidateArtifact?: ReturnType<typeof candidate>) => test.service.completeValidation({
    runId: run.id, status: "passed", metrics: emptyValidationMetrics(), results: [], candidateArtifact,
    runtime: { runnerId: "runner-0", runnerVersion: "1.0.0", nemoVersion: "0.24.0", modelRevisionId: "", compilerModelTypes: [] },
  });
  const stored = (test: ReturnType<typeof harness>) => test.updates.find((item) => item.table === "guardrail_validation_run")!.value;

  it("stores the exact tested candidate and its digest", async () => {
    const content = candidate();
    const test = harness([[], [run], request(content.plan)]);
    await complete(test, content);
    // Stored exactly as a Runner decodes it from the wire.
    const decoded = canonicalArtifactContent(content, resolve("../proto/tasklattice/guard/control/v1/runner_control.proto"));
    expect(stored(test)).toMatchObject({ status: "passed", candidateArtifact: decoded, candidateDigest: artifactContentDigest(decoded),
      runtimeFingerprint: expect.objectContaining({ nemoVersion: "0.24.0" }) });
  });

  it.each([
    ["missing", undefined, undefined],
    ["changed Rule action", (plan: Record<string, unknown>) => { (plan.steps as Array<{ on_unsafe: string }>)[0]!.on_unsafe = "allow"; }, undefined],
    ["other version", undefined, "20260906-020000.000Z"],
  ] as const)("fails a passed run whose candidate is %s", async (name, mutate, otherVersion) => {
    const content = candidate();
    if (mutate) mutate(content.plan);
    if (otherVersion) content.guardrailVersion = otherVersion;
    const test = harness([[], [run], request(candidate().plan)]);
    await complete(test, name === "missing" ? undefined : content);
    expect(stored(test)).toMatchObject({ status: "failed", failureReason: expect.any(String) });
    expect(stored(test)).not.toHaveProperty("candidateArtifact");
  });

  it("fails a candidate compiled for a different runtime profile than requested", async () => {
    const test = harness([[], [run], request(candidate().plan, "iorails_native")]);
    await complete(test, candidate());
    expect(stored(test)).toMatchObject({ status: "failed" });
  });
});

describe("Publishing the validated candidate", () => {
  const content = candidate();
  const validation = { id: "validation-1", status: "passed", guardrailVersion: content.guardrailVersion, sourceDraftRevision: 2,
    candidateArtifact: content, candidateDigest: artifactContentDigest(content), candidateInspection: { testSuite: { total: 1, digest: "d" } } };

  it("signs and publishes the tested content without rebuilding it from the draft or Library", async () => {
    const test = harness([[baseline()], [validation], [], []], { artifactSigningKeyPath: keyPath, policyCatalogDir: "/nonexistent-policy-library" });
    await expect(test.service.requestGuardrailPublish({ guardrailId: "guardrail-default", actorId: "admin" }))
      .resolves.toMatchObject({ status: "ready", version: content.guardrailVersion });
    const artifact = test.inserts.find((item) => item.table === "guardrail_artifact")!.value;
    expect(artifact).toMatchObject({ ...content, checksum: validation.candidateDigest });
    expect(verify(null, Buffer.from(String(artifact.checksum)), publicKey, Buffer.from(String(artifact.signature), "base64"))).toBe(true);
    expect(test.inserts).toContainEqual({ table: "guardrail_version", value: expect.objectContaining({ plan: content.plan, status: "ready", validationRunId: validation.id, inspection: validation.candidateInspection }) });
    expect(test.inserts.some((item) => item.value.kind === "guardrail.compile_requested")).toBe(false);
    expect(test.reads).toEqual([]);
  });

  it("requires a new test run when the passed run kept no candidate", async () => {
    const test = harness([[baseline()], [{ ...validation, candidateArtifact: null }], []]);
    await expect(test.service.requestGuardrailPublish({ guardrailId: "guardrail-default", actorId: "admin" }))
      .rejects.toMatchObject({ code: "guardrail_validation_required" });
    expect(test.inserts).toEqual([]);
  });

  it("refuses a stored candidate that no longer matches its digest", async () => {
    const test = harness([[baseline()], [{ ...validation, candidateDigest: "0".repeat(64) }], []], { artifactSigningKeyPath: keyPath });
    await expect(test.service.requestGuardrailPublish({ guardrailId: "guardrail-default", actorId: "admin" }))
      .rejects.toMatchObject({ code: "guardrail_candidate_corrupt" });
    expect(test.inserts).toEqual([]);
  });
});
