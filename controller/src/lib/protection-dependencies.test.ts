import { describe, expect, it } from "vitest";
import { dependencyAssignment, selectedModelDependencies } from "./protection-dependencies";
import type { ModelConfigurationRevision, ModelConfigurationView } from "./controller-api";
import type { GuardrailPolicyBinding, Policy } from "./api-types";

const policy = { id: "safety", name: "Safety", protection: { execution: "model", modelCapabilities: ["content_safety"] },
  rules: [{ id: "check", rails: ["input", "output"] }] } as Policy;
const binding = { policy_id: "safety", enabled_rule_ids: ["check"], enabled_rails: ["input", "output"] } as GuardrailPolicyBinding;
const revision = (state = "draft", evidenceKind = "nemo-rail-v1", status = "passed") => ({ state, revision: 1,
  assignments: { bindings: { "content_safety.input": "model" } },
  validationReport: { checkedAt: "2026-09-06T08:00:00Z", checks: [{ id: "probe:content_safety.input:model", status, evidenceKind }] },
} as ModelConfigurationRevision);
const view = { models: [{ id: "model", name: "Safety model" }], draft: revision(), active: null, activating: null } as ModelConfigurationView;

describe("selected runtime dependencies", () => {
  it("resolves only enabled Rules and directions, and deduplicates shared bindings", () => {
    expect(selectedModelDependencies([{ ...binding, enabled_rails: ["output"] }], [policy]).required.map(item => item.id)).toEqual(["content_safety.output"]);
    expect(selectedModelDependencies([{ ...binding, enabled_rule_ids: [] }], [policy]).required).toEqual([]);
    expect(selectedModelDependencies([binding, { ...binding, policy_id: "other" }], [policy, { ...policy, id: "other", name: "Other" }]).required[0]?.policyNames).toEqual(["Safety", "Other"]);
  });
  it("does not assign models to local banking rules or unselected model Policies", () => {
    expect(selectedModelDependencies([], [policy]).required).toEqual([]);
    expect(selectedModelDependencies([binding], [{ ...policy, protection: { ...policy.protection!, execution: "local", modelCapabilities: [] } }]).required).toEqual([]);
  });
  it("reports unknown custom dependencies instead of calling them model-free", () => {
    expect(selectedModelDependencies([binding], [{ ...policy, protection: undefined }]).unknownPolicies).toEqual(["Safety"]);
  });
  it("retains unknown for incomplete Rule direction metadata instead of throwing or inferring a binding", () => {
    const result = selectedModelDependencies([binding], [{ ...policy, rules: [{ id: "check" }] } as Policy]);
    expect(result).toEqual({ required: [], unknownPolicies: ["Safety"] });
  });
  it("distinguishes missing output from validated but inactive input", () => {
    expect(dependencyAssignment("content_safety.output", view).state).toBe("missing");
    expect(dependencyAssignment("content_safety.input", view).state).toBe("validated");
  });
  it("does not use model-call probes as Rail validation", () => {
    expect(dependencyAssignment("content_safety.input", { ...view, draft: revision("draft", "model-probe") }).state).toBe("unverified");
  });
  it("keeps active evidence despite a newer failing draft", () => {
    expect(dependencyAssignment("content_safety.input", { ...view, active: revision("active"), draft: revision("draft", "nemo-rail-v1", "failed") }).state).toBe("active");
  });
  it.each(["failed", "skipped"])("retains active assignments with %s evidence for retesting", status => {
    expect(dependencyAssignment("content_safety.input", { ...view, active: revision("active", "nemo-rail-v1", status) }))
      .toMatchObject({ state: "active", validation: status === "failed" ? "failed" : "unverified" });
  });
  it("does not substitute an output assignment or infer another capability from the same model", () => {
    const active = { ...revision("active"), assignments: { ...revision().assignments, bindings: { "content_safety.output": "model" } } };
    expect(dependencyAssignment("content_safety.input", { ...view, draft: null, active }).state).toBe("missing");
    expect(dependencyAssignment("jailbreak.input", { ...view, active: revision("active") }).state).toBe("missing");
  });
  it("distinguishes activation, failure and missing registered models", () => {
    expect(dependencyAssignment("content_safety.input", { ...view, activating: revision("activating") }).state).toBe("activating");
    expect(dependencyAssignment("content_safety.input", { ...view, draft: revision("draft", "nemo-rail-v1", "failed") }).state).toBe("failed");
    expect(dependencyAssignment("content_safety.input", { ...view, models: [] }).state).toBe("unverified");
  });
});
