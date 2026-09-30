import { describe, expect, it } from "vitest";
import { programmablePolicyProtection } from "./protection.js";
import { programmablePolicyDraftSchema, type ProgrammablePolicySnapshot } from "./model.js";
import { buildGuardrailPlan } from "../domain/guardrail-plan.js";
import { programmablePolicyPayload } from "../services/control-plane.js";
import { selectedModelDependencies } from "../../src/lib/protection-dependencies.js";
import { isModelIndependent, publishedProtectionCoverage } from "../domain/protection-readiness.js";
import { recommendationCatalog } from "../control-plane-ai/recommendation-catalog.js";
import { policyContractCoverage } from "../model-config/service.js";
import type { Policy } from "../../src/lib/api-types.js";
import type { policyRecords, policyVersions } from "../db/schema.js";
import { protectionDirectoryIds } from "../../shared/protection-map.js";

const draft = programmablePolicyDraftSchema.parse({ guardrail_category: "content_safety", colang_version: "2.x",
  sources: [{ path: "check.co", content: "flow custom_check $text\n  pass" }],
  rail_bindings: ["input", "output"].map(rail_type => ({ rail_type, flow_name: "custom_check", execution_mode: "detect", on_unsafe: "block" })),
  evaluation_contracts: ["tali.guard.content-safety.v1", "unregistered.external-service"],
});

describe("custom Policy protection facts", () => {
  it.each(protectionDirectoryIds)("persists explicit %s navigation without changing execution requirements", (directory) => {
    const selected = programmablePolicyDraftSchema.parse({ ...draft, protection_directory: directory });
    expect(selected.protection_directory).toBe(directory);
    const original = programmablePolicyProtection(draft);
    expect(programmablePolicyProtection(selected)).toEqual({ ...original, directory });
    expect(selected.rail_bindings).toEqual(draft.rail_bindings);
    expect(selected.evaluation_contracts).toEqual(draft.evaluation_contracts);
  });

  it.each(["unknown", "", null, ["privacy"]])("rejects invalid directory metadata %j", (protection_directory) => {
    expect(programmablePolicyDraftSchema.safeParse({ ...draft, protection_directory }).success).toBe(false);
  });

  it("keeps every published version's directory independent of draft and latest recategorization", () => {
    const now = new Date("2026-09-06T00:00:00Z");
    const record = { id: "custom", name: "Draft", description: "", owner: "owner", source: "custom", draftRevision: 3,
      createdAt: now, updatedAt: now, draft: { ...draft, protection_directory: "privacy" } } as typeof policyRecords.$inferSelect;
    const versions = (["content_filters", "application_injection"] as const).map((protection_directory, index) => ({
      policyId: "custom", version: index + 1, checksum: `sum-${index}`, publishedAt: now,
      snapshot: { ...draft, protection_directory, policy_id: "custom", version: String(index + 1), name: "Published",
        description: "", owner: "owner", source: "custom", checksum: `sum-${index}`, published_at: now.toISOString() },
    })) as Array<typeof policyVersions.$inferSelect>;
    const payload = programmablePolicyPayload(record, versions);
    expect(payload.protection.directory).toBe("application_injection");
    expect(payload.published_versions.map(item => item.protection.directory)).toEqual(["content_filters", "application_injection"]);
    expect(payload.implementation_detail.draft.protection_directory).toBe("privacy");
  });

  it("does not report custom contract availability as complete readiness", () => {
    const contract = "input:tali.guard.content-safety.v1";
    expect(policyContractCoverage("custom", "Custom", [], new Set(), false))
      .toMatchObject({ status: "unknown", dependenciesComplete: false, missingContracts: [] });
    expect(policyContractCoverage("custom", "Custom", [contract], new Set([contract]), false))
      .toMatchObject({ status: "unknown", dependenciesComplete: false, missingContracts: [] });
    expect(policyContractCoverage("custom", "Custom", [contract, contract], new Set(), false))
      .toMatchObject({ status: "blocked", dependenciesComplete: false, missingContracts: [contract] });
    expect(policyContractCoverage("local", "Local", [], new Set()))
      .toMatchObject({ status: "ready", dependenciesComplete: true });
  });
  it("classifies author intent without certifying arbitrary code or missing dependencies as local", () => {
    for (const [category, directory] of [["content_safety", "content_safety"], ["pii_detection", "privacy"], ["topic_control", "business_topics"],
      ["jailbreak_protection", "attacks_and_abuse"], ["hallucinations_fact_checking", "answer_reliability"], ["tool_calling", "business_rules"]] as const) {
      expect(programmablePolicyProtection({ ...draft, guardrail_category: category, evaluation_contracts: [] }))
        .toMatchObject({ directory, execution: "custom", modelCapabilities: [], evaluationContracts: [], outputStreaming: "complete_response" });
    }
  });

  it("retains known model requirements and unknowns together", () => {
    const protection = programmablePolicyProtection(draft);
    expect(protection.modelCapabilities).toEqual(["content_safety"]);
    expect(protection.evaluationContracts).toEqual(draft.evaluation_contracts);
    const recommendation = recommendationCatalog([{ id: "custom", name: "Custom", description: "Custom", source: "custom", version: "1",
      rails: ["input", "output"], protection }])[0]!;
    expect(recommendation).toMatchObject({ model_capabilities: ["content_safety"], dependencies_complete: false, execution: "custom" });
    expect(recommendation.limitations.join(" ")).toContain("lower bound");
  });

  it("keeps frontend selected bindings and published-health requirements in agreement by enabled direction", () => {
    const policy = { id: "custom", name: "Custom", version: "1", protection: programmablePolicyProtection(draft),
      rules: draft.rail_bindings.map(rail => ({ id: `flow/${rail.rail_type}/custom_check`, rails: [rail.rail_type] })) } as Policy;
    for (const phase of ["input", "output"] as const) {
      const binding = { policy_id: "custom", policy_version: "1", enabled_rule_ids: [`flow/${phase}/custom_check`], enabled_rails: [phase],
        parameter_values: {}, rule_actions: {}, action: null, rule_order: [], test_case_overrides: {}, reasoning_policy: null };
      const selected = selectedModelDependencies([binding], [policy]);
      const snapshot: ProgrammablePolicySnapshot = { ...draft, policy_id: "custom", version: "1", name: "Custom",
        description: "", source: "custom", owner: "owner", checksum: "fixture", published_at: "2026-09-06T00:00:00Z" };
      const plan = buildGuardrailPlan({ guardrailId: "custom-bound", guardrailVersion: "1", programmablePolicies: [snapshot],
        draft: { allowedTopics: [], restrictedTopics: [], safetyLevel: "balanced", outputDelivery: "full_buffered",
          policyBindings: [{ policyId: "custom", policyVersion: "1", enabledRuleIds: binding.enabled_rule_ids,
            enabledRails: [phase], parameterValues: {}, ruleActions: {}, action: null, reasoningPolicy: null }] } });
      expect(plan.policy_versions).toEqual([expect.objectContaining({ evaluation_contracts: draft.evaluation_contracts })]);
      const coverage = publishedProtectionCoverage(plan)!;
      expect(selected.required.map(item => item.id)).toEqual(coverage.requiredModelBindings);
      expect(coverage.requiredModelBindings).toEqual([`content_safety.${phase}`]);
      expect(selected.unknownPolicies).toEqual(["Custom"]);
      expect(coverage.hasUnknownDependencies).toBe(true);
      expect(isModelIndependent(coverage)).toBe(false);
    }
  });

  it("cannot infer local execution from only declared local contracts or unsupported directions", () => {
    const protection = programmablePolicyProtection({ ...draft, evaluation_contracts: ["tali.guard.pii.exact.v1"] });
    expect(protection.execution).toBe("custom");
    expect(recommendationCatalog([{ id: "custom", name: "Local claim", description: "", source: "custom", version: "1", rails: ["output"], protection }])[0])
      .toMatchObject({ model_capabilities: null, dependencies_complete: false });
    expect(programmablePolicyProtection({ ...draft, rail_bindings: draft.rail_bindings.filter(item => item.rail_type === "output"),
      evaluation_contracts: ["tali.guard.jailbreak.v1"] }).modelCapabilities).toEqual([]);
  });

  it("uses the bound published classification and contracts, never an unpublished recategorization", () => {
    const now = new Date("2026-09-06T00:00:00Z");
    const record = { id: "custom", name: "Changed", description: "", owner: "owner", source: "custom", draftRevision: 2, createdAt: now, updatedAt: now,
      draft: { ...draft, guardrail_category: "pii_detection", evaluation_contracts: [] } } as typeof policyRecords.$inferSelect;
    const version = { policyId: "custom", version: 1, checksum: "sum", publishedAt: now, snapshot: { ...draft, policy_id: "custom", version: "1",
      name: "Published safety", description: "", owner: "owner", source: "custom", checksum: "sum", published_at: now.toISOString() } } as typeof policyVersions.$inferSelect;
    const payload = programmablePolicyPayload(record, [version]);
    expect(payload.protection).toMatchObject({ directory: "content_safety", modelCapabilities: ["content_safety"] });
    expect(payload.published_versions[0]?.protection).toEqual(payload.protection);
    expect(payload.implementation_detail.draft.guardrail_category).toBe("pii_detection");
  });
});
