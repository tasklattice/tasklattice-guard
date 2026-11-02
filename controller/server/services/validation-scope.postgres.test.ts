import { completeReport, getReport } from "../db/report-test-utils.js";
// @vitest-environment node
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, it, expect } from "vitest";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { user, guardrails, controllerState, testCases, outboxEvents } from "../db/schema.js";
import { loadConfig } from "../config.js";
import { defaultGuardrailDraft, DEFAULT_GUARDRAIL_ID } from "../domain/defaults.js";
import { generatedTestCases } from "../domain/validation.js";
import { PolicyCatalog } from "../policy-catalog/catalog.js";
import { ControlPlaneService } from "./control-plane.js";
import type { ValidationCaseResult } from "../domain/models.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Historical model-enabled Default publication uses the ordinary publication rules", () => {
  it("freezes scope, preserves a local failure, publishes full model protection for ordinary users", async () => {
    const database = await createTestDatabase(url!, "scope");
    const directory = mkdtempSync(join(tmpdir(), "guard-scope-"));
    const key = join(directory, "signing.pem");
    writeFileSync(key, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
    try {
      const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!, CONTROLLER_RUNNER_TOKEN: "test-runner-token-that-is-at-least-32-chars",
        CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: key, CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"),
        CONTROLLER_PROTO_PATH: resolve("../proto/tasklattice/guard/control/v1/runner_control.proto"), BETTER_AUTH_SECRET: "test-auth-secret-that-is-at-least-32-chars" });
      const service = new ControlPlaneService(database.db, config);
      await database.db.insert(user).values(["admin", "user"].map(role => ({ id: role, name: role, email: `${role}@example.test`, role, emailVerified: true })));
      await database.db.insert(controllerState).values({ id: "singleton", desiredGeneration: 0 });
      const catalog = PolicyCatalog.load(config.policyCatalogDir).list();
      const draft = defaultGuardrailDraft(catalog);
      // Explicit opt-in, also used to verify retained historical model-enabled releases.
      const jailbreak = catalog.find(p => p.id === "builtin-jailbreak")!;
      draft.policyBindings.splice(2, 0, { policyId: jailbreak.id, policyVersion: jailbreak.version,
        action: null, parameterValues: {}, enabledRuleIds: ["model/jailbreak"], ruleOrder: ["model/jailbreak"],
        ruleActions: {}, enabledRails: ["input"], reasoningPolicy: null, testCaseOverrides: {} });
      draft.policyBindings = draft.policyBindings.map(binding => ({ ...binding, testCaseOverrides: {} }));
      await database.db.insert(guardrails).values({ id: DEFAULT_GUARDRAIL_ID, name: "Default", draftConfig: draft, status: "draft", draftRevision: 1 });
      const cases = generatedTestCases(DEFAULT_GUARDRAIL_ID, draft, catalog);
      const local = cases.find(c => c.policyId === "local-credentials")!;
      const model = cases.find(c => c.policyId === "builtin-jailbreak")!;
      await database.db.insert(testCases).values([local, model]);
      for (const passes of [false, true]) {
        const run = await service.requestValidation({ guardrailId: DEFAULT_GUARDRAIL_ID, actorId: "user", compilerAvailable: true, testModelRules: false });
        expect(run.testModelRules).toBe(false);
        const [event] = await database.db.select().from(outboxEvents).where(eq(outboxEvents.id, run.id));
        expect(event!.payload.testModelRules).toBe(false);
        const plan = event!.payload.plan as Record<string, unknown>;
        expect(JSON.stringify(plan)).toContain("tali.guard.jailbreak.v1");
        const result = (c: typeof local, skipped: boolean): ValidationCaseResult => ({ caseId: c.id, name: c.name, policyId: c.policyId, expectedDecision: c.expectedDecision, actualDecision: skipped ? "" : c.expectedDecision,
          passed: !skipped && passes, skipped, skipReason: skipped ? "Model-dependent tests skipped" : "", evaluatorIds: [], latencyMs: 1, reason: "", phase: c.phase, inputContent: c.content,
          action: "", outputContent: "", findings: [], trace: [], trustedInstruction: "", targetSource: c.targetSource, query: "", groundingSources: [], expectedReasoningResult: null, actualReasoningResult: null,
          caseType: c.caseType, required: true, expectedFailure: null, actualFailure: null, concurrencyGroup: null, sourcePolicyId: c.sourcePolicyId, sourcePolicyVersion: c.sourcePolicyVersion, sourceCaseId: c.sourceCaseId,
          evidenceStatus: skipped ? "not_reached" : "not_required", evidenceDetail: "", verifiedRuleIds: [], supersededBy: [], ruleContractSatisfied: !skipped,
          coveredRuleIds: c.coveredRuleIds, matchedRuleIds: [], evaluationContracts: [], escalated: false, modelInvocations: 0 });
        await completeReport(service, { runId: run.id, status: passes ? "passed" : "failed",
          metrics: { total: 2, executed: 1, skipped: 1, passed: Number(passes), complianceRate: passes ? 100 : 0, falsePositiveRate: 0, falseNegativeRate: 0, escalationRate: 0, p95LatencyMs: 1 },
          results: [result(local, false), result(model, true)],
          testScope: { testModelRules: false, skippedRules: model.coveredRuleIds.map(ruleId => ({ policyId: model.policyId, ruleId, reason: "model" })), modelInvocations: 0, executionDigest: "a".repeat(64), fullArtifactLoaded: true },
          candidateArtifact: { guardrailId: DEFAULT_GUARDRAIL_ID, guardrailVersion: run.guardrailVersion, compilerVersion: "tasklattice-nemo-config-v1", nemoVersion: "0.24.0", runtimeProfile: "llmrails_colang1_standard",
            plan, configYaml: "", colangContent: "", prompts: [], actionBindings: [], dependencyManifest: [] } });
        {
          const published = await service.requestGuardrailPublish({ guardrailId: DEFAULT_GUARDRAIL_ID, actorId: "user" });
          expect(published.status).toBe("ready");
          expect(await getReport(service, run.id)).toMatchObject({ status: passes ? "passed" : "failed" });
          const detail = await service.getGuardrail(DEFAULT_GUARDRAIL_ID);
          expect(JSON.stringify(detail.versions[0]!.plan)).toContain("tali.guard.jailbreak.v1");
          expect(detail.versions[0]!.testWaiver).toBeNull();
          expect((await getReport(service, run.id)).testScope?.modelInvocations).toBe(0);
        }
      }
    } finally { await database.drop(); rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);
});
