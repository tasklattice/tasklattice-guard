import { describe, expect, it } from "vitest";

import type { ProgrammablePolicy } from "@/lib/api";
import {
  parsePolicyPackage,
  policyPackageFilename,
  serializePolicyPackage,
} from "@/lib/policy-transfer";

const policy: ProgrammablePolicy = {
  implementation: "nemo_native",
  id: "customer-identifiers",
  name: "Customer identifiers",
  description: "Redact customer identifiers.",
  source: "custom",
  owner: "security@example.com",
  draft_revision: 3,
  updated_at: "2026-08-14T00:00:00Z",
  draft: {
    guardrail_category: "pii_detection",
    colang_version: "2.x",
    sources: [{ path: "main.co", content: "flow check_request $text\n  pass\n" }],
    parameter_schema: [],
    rail_bindings: [{
      rail_type: "input",
      flow_name: "check_request",
      execution_mode: "detect",
      on_unsafe: "reject",
      parallel_group: null,
      priority: null,
      timeout_ms: 500,
      failure_mode: "fail_closed",
      required: true,
      depends_on: [],
    }],
    action_references: [],
    evaluation_contracts: [],
    prompt_dependencies: [],
    execution_contract: [],
    test_cases: [],
  },
};

describe("Policy transfer package", () => {
  it("round-trips an editable draft without carrying environment publication state", () => {
    const imported = parsePolicyPackage(serializePolicyPackage(policy));

    expect(imported.name).toBe(policy.name);
    expect(imported.owner).toBe(policy.owner);
    expect(imported.draft).toEqual(policy.draft);
    expect(imported.sourcePolicyId).toBe(policy.id);
    expect(imported.sourceDraftRevision).toBe(3);
    expect(policyPackageFilename(policy)).toBe("customer-identifiers.tasklattice-policy.json");
  });

  it("rejects incompatible Colang 1 packages instead of asking the user to choose a runtime", () => {
    const payload = JSON.parse(serializePolicyPackage(policy));
    payload.policy.draft.colang_version = "1.0";

    expect(() => parsePolicyPackage(JSON.stringify(payload))).toThrow(/Colang 2\.x/);
  });

  it("rejects unrelated JSON", () => {
    expect(() => parsePolicyPackage('{"name":"not-a-package"}')).toThrow(/not a TaskLattice Policy package/);
  });
});
