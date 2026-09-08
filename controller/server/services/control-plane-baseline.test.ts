import { resolve } from "node:path";
import { generateKeyPairSync } from "node:crypto";
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

const policyCatalogDir = resolve("../runner/toolkit/policy_library/assets");
const policies = PolicyCatalog.load(policyCatalogDir).list();
const baseline = () => ({
  id: "guardrail-default", draftRevision: 2, draftConfig: normalizeGuardrailDraft(defaultGuardrailDraft(policies)),
  status: "draft", activeVersion: null, activeArtifactId: null, excludedTestCaseIds: [],
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
  const service = new ControlPlaneService(db, { policyCatalogDir, ...config } as ControllerConfig);
  return { service, inserts, updates, reads };
}

describe("Default baseline validation gate", () => {
  it.each(["missing", "failed"])("migrates the system-owned mixed Default through validation, retaining the old release (%s validation)", async (validationStatus) => {
    const stored = { ...legacyBaseline(), status: "active", activeVersion: "legacy", activeArtifactId: "legacy-artifact" };
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
    expect(test.updates.some((item) => "activeArtifactId" in item.value || "activeVersion" in item.value)).toBe(false);
    expect(test.inserts.some((item) => ["guardrail_version", "deployment"].includes(item.table))).toBe(false);
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
      metrics: { total: 321, passed: 0 },
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

  it("compiles precisely the validated revision and preserves the old active artifact until acceptance", async () => {
    const stored = { ...baseline(), status: "active", activeVersion: "old", activeArtifactId: "old-artifact" };
    const validation = { id: "validation-new", status: "passed", createdAt: new Date("2026-09-06T01:00:00.001Z") };
    const plan = buildGuardrailPlan({ guardrailId: stored.id, guardrailVersion: "20260906-010000.001Z", draft: stored.draftConfig, policies });
    const test = harness([[stored], [], [{ sourceDraftRevision: 1 }], [validation], [], [{ payload: { plan, runtimeProfile: "auto" } }]]);
    await test.service.initialize();
    expect(test.reads).toEqual([]);
    expect(test.inserts).toContainEqual({ table: "guardrail_version", value: expect.objectContaining({
      version: "20260906-010000.001Z", sourceDraftRevision: 2, status: "compiling", createdBy: null,
    }) });
    expect(test.inserts).toContainEqual({ table: "audit_event", value: expect.objectContaining({
      kind: "guardrail.default.compile_requested", detail: expect.objectContaining({ validationRunId: validation.id }),
    }) });
    expect(test.updates.filter((item) => item.table === "guardrail")).toEqual([
      { table: "guardrail", value: expect.objectContaining({ status: "active" }) },
    ]);
    expect(test.updates.some((item) => "activeArtifactId" in item.value || "activeVersion" in item.value)).toBe(false);
  });

  it("does not queue duplicate compilation when the validated version already exists", async () => {
    const test = harness([[baseline()], [], [{ status: "passed", createdAt: new Date("2026-09-06T01:00:00.001Z") }], [{ version: "20260906-010000.001Z" }]]);
    await test.service.initialize();
    expect(test.reads).toEqual([]);
    expect(test.updates).toEqual([]);
    expect(test.inserts.map((item) => item.table)).toEqual(["controller_state", "runner_pool"]);
  });

  it("leaves user-authored Default changes to explicit Validate and Publish", async () => {
    const stored = legacyBaseline();
    stored.draftConfig.policyBindings[0]!.ruleActions = { "category/denied_insults": "pass" };
    const original = structuredClone(stored);
    const test = harness([[stored], [{ id: "user-edit" }]]);
    await test.service.initialize();
    expect(test.reads).toEqual([]);
    expect(test.updates).toEqual([]);
    expect(test.inserts.map((item) => item.table)).toEqual(["controller_state", "runner_pool"]);
    expect(stored).toEqual(original);
  });

  it.each([null, "admin-user"])("only resumes automatic publication for system validation (actor %s)", async (createdBy) => {
    const test = harness([[], [{ id: "validation-1", guardrailId: "guardrail-default", createdBy, status: "running" }]]);
    const reconcile = vi.spyOn(test.service, "initialize").mockResolvedValue();
    await test.service.completeValidation({ runId: "validation-1", status: "passed", metrics: emptyValidationMetrics(), results: [] });
    expect(reconcile).toHaveBeenCalledTimes(createdBy === null ? 1 : 0);
    expect(test.reads).toEqual([]);
  });
});

describe("Compiled artifact publication gate", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "guard-baseline-signing-test-"));
  const keyPath = resolve(directory, "key.pem");
  writeFileSync(keyPath, generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  const plan = buildGuardrailPlan({ guardrailId: "guardrail-default", guardrailVersion: "20260906-010000.001Z", draft: baseline().draftConfig, policies });
  const version = { status: "compiling", sourceDraftRevision: 2, plan };
  const input = { compileId: "compile-1", guardrailId: "guardrail-default", guardrailVersion: "20260906-010000.001Z", generation: 1,
    compilerVersion: "compiler", nemoVersion: "0.24.0", runtimeProfile: "llmrails_colang1_standard", plan,
    configYaml: "", colangContent: "", prompts: [], actionBindings: [], dependencyManifest: [] };

  it("refuses old bootstrap artifacts that have never passed validation", async () => {
    const test = harness([[baseline()], [version], []], { artifactSigningKeyPath: keyPath });
    await expect(test.service.acceptCompiledArtifact(input)).rejects.toMatchObject({ code: "guardrail_validation_required" });
    expect(test.inserts).toEqual([]);
    expect(test.updates).toEqual([]);
    expect(test.reads).toEqual([]);
  });

  it("refuses a compiler response that changes an executable Rule action", async () => {
    const altered = structuredClone(plan);
    (altered.steps as Array<{ on_unsafe: string }>)[0]!.on_unsafe = "pass";
    const test = harness([[baseline()], [version]], { artifactSigningKeyPath: keyPath });
    await expect(test.service.acceptCompiledArtifact({ ...input, plan: altered })).rejects.toMatchObject({ code: "compile_plan_mismatch" });
    expect(test.inserts).toEqual([]);
    expect(test.updates).toEqual([]);
  });

  it("retains a late approved artifact without overwriting a newer publish or explicit rollback", async () => {
    const test = harness([[{ ...baseline(), desiredGeneration: 2, activeArtifactId: "newer-artifact" }], [version], [{ id: "passed-validation" }]], { artifactSigningKeyPath: keyPath });
    await test.service.acceptCompiledArtifact(input);
    expect(test.reads).toEqual([]);
    expect(test.updates).toContainEqual({ table: "guardrail_version", value: expect.objectContaining({ status: "ready" }) });
    expect(test.updates.some((item) => item.table === "guardrail" || item.table === "deployment")).toBe(false);
    expect(test.inserts).toContainEqual({ table: "audit_event", value: expect.objectContaining({
      kind: "guardrail.compiled", detail: expect.objectContaining({ activated: false }),
    }) });
    expect(test.inserts).toContainEqual({ table: "controller_outbox", value: expect.objectContaining({
      kind: "runner.desired_state_changed", payload: expect.objectContaining({ generation: 10 }),
    }) });
  });

  it("advances delivery generation when compilation finishes after the request generation was sent", async () => {
    const test = harness([[{ ...baseline(), id: 'test-rail', desiredGeneration: 1 }], [version], [{ id: 'passed-validation' }]],
      { artifactSigningKeyPath: keyPath });
    await test.service.acceptCompiledArtifact({ ...input, guardrailId: 'test-rail' });
    expect(test.updates).toContainEqual({ table: 'controller_state', value: expect.objectContaining({ desiredGeneration: expect.anything() }) });
    expect(test.inserts).toContainEqual({ table: 'controller_outbox', value: expect.objectContaining({
      kind: 'runner.desired_state_changed', payload: expect.objectContaining({ generation: 10 }),
    }) });
    expect(test.inserts).toContainEqual({ table: 'guardrail_artifact', value: expect.objectContaining({ generation: 1 }) });
    expect(test.updates).toContainEqual({ table: 'guardrail', value: expect.objectContaining({ desiredGeneration: 1 }) });
  });
});

describe("Validated executable snapshot", () => {
  const createdAt = new Date("2026-09-06T01:00:00.001Z");
  const validation = { id: "validation-1", status: "passed", sourceDraftRevision: 2, createdAt };
  const plan = buildGuardrailPlan({ guardrailId: "guardrail-default", guardrailVersion: "20260906-010000.001Z", draft: baseline().draftConfig, policies });

  it.each(["missing", "catalog-action", "runtime-profile"])("requires new validation when the validated snapshot differs: %s", async (change) => {
    const snapshot = { payload: { plan: structuredClone(plan), runtimeProfile: "auto" } };
    if (change === "catalog-action") (snapshot.payload.plan.steps as Array<{ on_unsafe: string }>)[0]!.on_unsafe = "pass";
    if (change === "runtime-profile") snapshot.payload.runtimeProfile = "iorails_native";
    const test = harness([[baseline()], [validation], [], change === "missing" ? [] : [snapshot]]);
    await expect(test.service.requestGuardrailPublish({ guardrailId: "guardrail-default", actorId: "admin", compilerAvailable: true }))
      .rejects.toMatchObject({ code: "guardrail_validation_plan_changed" });
    expect(test.inserts).toEqual([]);
    expect(test.reads).toEqual([]);
  });

  it("publishes when the saved executable contract exactly matches what passed validation", async () => {
    const test = harness([[baseline()], [validation], [], [{ payload: { plan, runtimeProfile: "auto" } }]]);
    await expect(test.service.requestGuardrailPublish({ guardrailId: "guardrail-default", actorId: "admin", compilerAvailable: true }))
      .resolves.toMatchObject({ status: "compiling", version: "20260906-010000.001Z" });
    expect(test.inserts).toContainEqual({ table: "guardrail_version", value: expect.objectContaining({ plan }) });
    expect(test.reads).toEqual([]);
  });
});
