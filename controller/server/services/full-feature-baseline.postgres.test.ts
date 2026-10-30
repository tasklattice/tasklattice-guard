// @vitest-environment node
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { ControlPlaneService } from "./control-plane.js";
import { profileDraft } from "../policy-catalog/presets.js";
import { fullFeatureBaseline } from "../../shared/full-feature-baseline.js";
import { publishedProtectionCoverage } from "../domain/protection-readiness.js";
import { buildGuardrailPlan } from "../domain/guardrail-plan.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Full-feature Profile creation and deletion", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let service: ControlPlaneService;
  beforeAll(async () => {
    database = await createTestDatabase(url!, "full_profile");
    await database.pool.query("INSERT INTO auth_user (id, name, email, role) VALUES ('admin', 'Admin', 'admin@example.test', 'admin')");
    service = new ControlPlaneService(database.db, loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: url!,
      CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"),
      CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/unused-profile-test-key.pem", CONTROLLER_RUNNER_TOKEN: "profile-test-runner-token-32-characters",
      BETTER_AUTH_SECRET: "profile-test-auth-secret-32-characters" }));
  });
  afterAll(async () => { await database?.drop(); });
  const draft = async () => profileDraft(fullFeatureBaseline, await service.listPolicies());
  it("creates a complete draft without model assignments, preserving the source version", async () => {
    expect((await service.listGuardrailProfiles()).find(profile => profile.id === fullFeatureBaseline.id)?.availability.available).toBe(true);
    const strictPolicy = (await service.listPolicies()).find(policy => policy.id === "builtin-jailbreak-strict")!;
    expect(strictPolicy.protection.modelCapabilities).toEqual(["jailbreak"]);
    expect(strictPolicy.definition?.rules[0]!.detector.parameters.on_unknown).toBe("{{on_unknown}}");
    const config = await draft();
    const preview = await service.previewGuardrailPlan({ draftConfig: config, runtimeProfile: "auto" });
    expect(preview.actions.some(action => action.name === "jailbreak")).toBe(true);
    const created = await service.createGuardrail({ name: "Full feature", draftConfig: config, runtimeProfile: "auto", actorId: "admin" });
    const stored = await service.getGuardrail(created.id);
    expect(stored.draftConfig).toEqual(config);
    expect(stored.draftConfig.profileOrigin?.version).toBe("1.0.0");
    expect(stored.draftConfig.policyBindings).toHaveLength(14);
    expect((await service.listTestCases(created.id)).length).toBeGreaterThan(500);
    const reduced = structuredClone(stored.draftConfig);
    reduced.policyBindings = reduced.policyBindings.filter(binding => binding.policyId !== "local-government-identifiers");
    await service.updateGuardrail({ id: created.id, actorId: "admin", draftConfig: reduced, expectedDraftRevision: stored.draftRevision });
    const saved = await service.getGuardrail(created.id);
    expect(saved.draftConfig.profileOrigin).toEqual(config.profileOrigin);
    expect(Object.keys(saved.draftConfig.policyBindings.find(binding => binding.policyId === "local-contact-data")!.testCaseOverrides!)).toHaveLength(25);
    const tests = await service.listTestCases(created.id);
    expect(tests.some(test => test.sourcePolicyId === "local-government-identifiers")).toBe(false);
    expect(tests.some(test => test.sourcePolicyId === "local-contact-data")).toBe(true);
  });
  it("removes model Policies and cross-policy references before creation without losing boundary tests", async () => {
    const config = await draft();
    const removed = ["builtin-pii", "builtin-topic-safety", "builtin-content-safety", "builtin-jailbreak-strict", "local-government-identifiers"];
    config.policyBindings = config.policyBindings.filter(binding => !removed.includes(binding.policyId));
    await service.previewGuardrailPlan({ draftConfig: config, runtimeProfile: "auto" });
    const created = await service.createGuardrail({ name: "Local subset", draftConfig: config, runtimeProfile: "auto", actorId: "admin" });
    const saved = await service.getGuardrail(created.id);
    const plan = buildGuardrailPlan({ guardrailId: created.id, guardrailVersion: "test", draft: saved.draftConfig, policies: await service.listPolicies() });
    expect(publishedProtectionCoverage(plan)?.requiredModelBindings).toEqual([]);
    const tests = await service.listTestCases(created.id);
    expect(tests.some(test => removed.includes(test.sourcePolicyId!))).toBe(false);
    expect(tests.some(test => test.sourcePolicyId === "builtin-memory-poisoning" && test.targetSource === "tool_output")).toBe(true);
    expect(tests.some(test => test.sourcePolicyId === "builtin-indirect-prompt-injection" && test.targetSource === "retrieved_content")).toBe(true);
    expect(Object.keys(saved.draftConfig.policyBindings.find(binding => binding.policyId === "local-contact-data")!.testCaseOverrides!)).toHaveLength(25);
  });
  it("reconciles deletion before first save and isolates an unavailable Profile", async () => {
    const config = await draft();
    config.policyBindings = config.policyBindings.filter(binding => binding.policyId !== "local-government-identifiers");
    await service.previewGuardrailPlan({ draftConfig: config, runtimeProfile: "auto" });
    const created = await service.createGuardrail({ name: "Reduced baseline", draftConfig: config, runtimeProfile: "auto", actorId: "admin" });
    expect(Object.keys((await service.getGuardrail(created.id)).draftConfig.policyBindings.find(binding => binding.policyId === "local-contact-data")!.testCaseOverrides!)).toHaveLength(25);
    await database.pool.query("UPDATE guardrail_profile SET definition=jsonb_set(definition, '{policies,0,policyVersion}', '\"unavailable\"') WHERE id='full-feature-baseline'");
    const profiles = await service.listGuardrailProfiles();
    expect(profiles.find(profile => profile.id === fullFeatureBaseline.id)?.availability.available).toBe(false);
    expect(profiles.find(profile => profile.id === "local-baseline")?.availability.available).toBe(true);
  });
});
