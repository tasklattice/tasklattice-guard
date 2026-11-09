import type { guardrailVersions } from "../db/schema.js";
import type { GuardrailDraftChange } from "../../shared/guardrail-draft-changes.js";
import { normalizeGuardrailDraft } from "./guardrail-plan.js";

export type DraftSnapshot = NonNullable<typeof guardrailVersions.$inferSelect.sourceSnapshot>;

// Object key order and persistence timestamps are not configuration changes.
export function stableDraftValue(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

function caseContent(item: NonNullable<DraftSnapshot["testCases"]>[number]) {
  const { updatedAt: _updatedAt, guardrailId: _guardrailId, ...content } = item;
  return content;
}

export function draftConfigContent(config: DraftSnapshot["draftConfig"]) {
  const normalized = normalizeGuardrailDraft(config);
  return { ...normalized, policyBindings: normalized.policyBindings.map(binding => ({
    ...binding, enabledRuleIds: [...binding.enabledRuleIds].sort(), enabledRails: [...binding.enabledRails].sort(),
  })) };
}

export function draftContent(snapshot: DraftSnapshot) {
  return {
    draftConfig: draftConfigContent(snapshot.draftConfig),
    runtimeProfile: snapshot.runtimeProfile,
    excludedTestCaseIds: [...snapshot.excludedTestCaseIds].sort(),
    testCases: snapshot.testCases?.map(caseContent).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function sameDraftContent(before: DraftSnapshot, after: DraftSnapshot) {
  return stableDraftValue(draftContent(before)) === stableDraftValue(draftContent(after));
}

function display(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every(item => typeof item === "string")) return value.join("\n");
  return JSON.stringify(JSON.parse(stableDraftValue(value)), null, 2);
}

export function describeDraftChanges(before: DraftSnapshot | null, after: DraftSnapshot): GuardrailDraftChange[] {
  const changes: GuardrailDraftChange[] = [];
  const add = (kind: GuardrailDraftChange["kind"], subject: string, field: string, oldValue: unknown, newValue: unknown) => {
    if (stableDraftValue(oldValue) !== stableDraftValue(newValue)) changes.push({ kind, subject, field, before: display(oldValue), after: display(newValue) });
  };
  const oldConfig = before ? draftConfigContent(before.draftConfig) : null;
  const config = draftConfigContent(after.draftConfig);
  for (const field of ["safetyLevel", "outputDelivery", "topicControlMode", "allowedTopics", "restrictedTopics"] as const) {
    add("setting", "", field, oldConfig?.[field], config[field]);
  }
  add("setting", "", "runtimeProfile", before?.runtimeProfile, after.runtimeProfile);
  const previous = oldConfig?.policyBindings ?? [];
  const bindings = config.policyBindings;
  if (before) add("policyOrder", "", "policyOrder", previous.map(b => b.policyId), bindings.map(b => b.policyId));
  for (const binding of previous) {
    if (!bindings.some(b => b.policyId === binding.policyId)) add("policyRemoved", binding.policyId, "policyVersion", binding.policyVersion, null);
  }
  for (const binding of bindings) {
    const original = previous.find(b => b.policyId === binding.policyId);
    if (!original) add("policyAdded", binding.policyId, "policyVersion", null, binding.policyVersion);
    else for (const field of ["policyVersion", "action", "parameterValues", "enabledRuleIds", "enabledRails", "ruleActions", "ruleOrder", "testCaseOverrides", "reasoningPolicy"] as const) {
      add("policyUpdated", binding.policyId, field, original[field], binding[field]);
    }
  }
  const oldCases = before?.testCases ?? [];
  const cases = after.testCases ?? [];
  // Inherited cases follow pinned Policies; list custom cases separately.
  for (const item of oldCases.filter(c => c.origin !== "generated")) {
    if (!cases.some(c => c.id === item.id)) add("caseRemoved", item.name, "testCase", caseContent(item), null);
  }
  for (const item of cases.filter(c => c.origin !== "generated")) {
    const original = oldCases.find(c => c.id === item.id);
    add(original ? "caseUpdated" : "caseAdded", item.name, "testCase", original ? caseContent(original) : null, caseContent(item));
  }
  const caseNames = new Map([...oldCases, ...cases].map(c => [c.id, `${c.name} · ${c.phase} · ${c.id}`]));
  add("testScope", "", "excludedCases", before?.excludedTestCaseIds.slice().sort().map(id => caseNames.get(id) ?? id) ?? [], after.excludedTestCaseIds.slice().sort().map(id => caseNames.get(id) ?? id));
  return changes;
}
