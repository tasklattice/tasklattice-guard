import { describe, expect, it } from "vitest";
import type { Policy } from "./api-types";
import { policyCorrectnessCapabilities, policyRequiresTopicAllowlist } from "./protection-requirements";

describe("Business classification is not runtime configuration", () => {
  it("does not force financial local rules to configure a topic model or allowlist", () => {
    const financial = {
      id: "banking-customer-protection",
      tags: [{ namespace: "guardrail_category", value: "topic_control" }],
      protection: { directory: "business_rules", execution: "local", requiredContext: [] },
    } as unknown as Policy;
    expect(policyRequiresTopicAllowlist(financial)).toBe(false);
    expect(policyRequiresTopicAllowlist({ ...financial, id: "builtin-topic-safety", protection: { ...financial.protection!, requiredContext: ["allowed_topics"] } })).toBe(true);
    expect(policyRequiresTopicAllowlist(undefined)).toBe(false);
  });
});

it("detects correctness dependencies from metadata or builtin identity, never the directory alone", () => {
  const local = { id: "local", protection: { directory: "answer_reliability", modelCapabilities: [], evaluationContracts: [] } } as unknown as Policy;
  expect(policyCorrectnessCapabilities(local)).toEqual([]);
  expect(policyCorrectnessCapabilities({ ...local, id: "builtin-contextual-grounding" })).toEqual(["contextual_grounding"]);
  expect(policyCorrectnessCapabilities({ ...local, protection: { ...local.protection!, evaluationContracts: ["tali.guard.automated-reasoning.v1"] } })).toEqual(["automated_reasoning"]);
  expect(policyCorrectnessCapabilities({ ...local, protection: { ...local.protection!, modelCapabilities: ["contextual_grounding", "automated_reasoning"] } })).toEqual(["contextual_grounding", "automated_reasoning"]);
});
