import { describe, expect, it } from "vitest";

import type { GuardrailVersionDetail } from "@/lib/api";

import { buildGuardrailVersionDiff } from "./guardrail-version-workspace";

function version(overrides: Partial<GuardrailVersionDetail> = {}): GuardrailVersionDetail {
  return {
    guardrail_id: "guardrail-dev",
    version: "20260814-075544.381Z",
    source_draft_version: 1,
    compiler_version: "tasklattice-nemo-config-v7",
    plan_checksum: "plan-one",
    config_checksum: "config-one",
    created_at: "2026-08-14T07:55:44.381Z",
    active: false,
    runtime_engine: "llmrails",
    execution_mode: "nemo_only",
    safety_level: "balanced",
    output_delivery: "window_buffered",
    runtime_profile: "llmrails_colang1_standard",
    colang_version: "1.0",
    rails: [{ rail_type: "input", flow: "protect input" }],
    actions: [{ name: "GuardContentFilterAction", version: "1.0.0", flow: null, phases: ["input"], timeout_ms: 2500, failure_mode: "closed" }],
    models: [],
    features: [],
    dependencies: [{ kind: "action", name: "GuardContentFilterAction", version: "1.0.0" }],
    estimated_critical_path_ms: 2500,
    policy_bindings: [{ policy_id: "content-filter", policy_version: "1", action: "block", enabled_rule_ids: ["sql"], enabled_rails: ["input"] }],
    artifacts: [{ path: "config.yml", language: "yaml", content: "rails: input" }],
    ...overrides,
  };
}

describe("Guardrail version workspace", () => {
  it("builds semantic changes instead of diffing raw JSON first", () => {
    const base = version();
    const target = version({
      version: "20260814-080000.000Z",
      safety_level: "strict",
      policy_bindings: [
        { policy_id: "content-filter", policy_version: "2", action: "block", enabled_rule_ids: ["sql", "code"], enabled_rails: ["input"] },
        { policy_id: "pii", policy_version: "1", action: "redact", enabled_rule_ids: ["email"], enabled_rails: ["input", "output"] },
      ],
      models: ["content-safety"],
    });

    const changes = buildGuardrailVersionDiff(base, target);

    expect(changes).toContainEqual(expect.objectContaining({ category: "posture", field: "safetyLevel", kind: "changed", before: "balanced", after: "strict" }));
    expect(changes).toContainEqual(expect.objectContaining({ category: "policies", field: "policy", subject: "pii", kind: "added" }));
    expect(changes).toContainEqual(expect.objectContaining({ category: "runtime", field: "model", subject: "content-safety", kind: "added" }));
  });
});
