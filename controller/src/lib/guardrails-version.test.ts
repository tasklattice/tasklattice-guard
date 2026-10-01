import { describe, expect, it, vi } from "vitest";
import { getControllerGuardrail } from "./controller-api";
import { getGuardrailVersion } from "./guardrails-api";

vi.mock("./controller-api", () => ({ getControllerGuardrail: vi.fn() }));

describe("Immutable Guardrail version projection", () => {
  it("uses the released Policy bindings and delivery instead of the edited draft", async () => {
    const fixture = {
      id: "guard-1", activeVersion: "v1",
      draftConfig: { safetyLevel: "strict", outputDelivery: "interruptible", policyBindings: [{ policyId: "new-draft-policy" }] },
      versions: [{ guardrailId: "guard-1", version: "v1", sourceDraftRevision: 1, runtimeProfile: "llmrails-colang2",
        status: "ready", createdAt: "2026-09-05T00:00:00Z", failureReason: null,
        plan: { safety_level: "balanced", output_delivery: "window_buffered",
          steps: [{ id: "pii-rule", capability: "pii", phases: ["output"], on_unsafe: "transform" }],
          policy_bindings: [{ policy_id: "released-policy", policy_version: "1.0.0", enabled_rule_ids: ["pii"], enabled_rails: ["output"] }],
        },
      }],
    };
    vi.mocked(getControllerGuardrail).mockResolvedValue(fixture as unknown as Awaited<ReturnType<typeof getControllerGuardrail>>);
    const detail = await getGuardrailVersion("guard-1", "v1");
    expect(detail.safety_level).toBe("balanced");
    expect(detail.output_delivery).toBe("window_buffered");
    expect(detail.effective_output_delivery).toBe("full_buffered");
    expect(detail.policy_bindings.map((policy) => policy.policy_id)).toEqual(["released-policy"]);
    expect(detail.rails).toEqual([{ rail_type: "output", flow: "pii-rule" }]);
  });

  it("includes compiled custom Colang flows even when there are no declarative steps", async () => {
    const fixture = {
      id: "guard-1", activeVersion: "v1", draftConfig: {},
      versions: [{ guardrailId: "guard-1", version: "v1", sourceDraftRevision: 1, runtimeProfile: "llmrails-colang2",
        status: "ready", createdAt: "2026-09-05T00:00:00Z", failureReason: null,
        plan: { steps: [], output_delivery: "full_buffered" },
        artifact: { compilerVersion: "test", checksum: "test", actionBindings: [
          { action_name: "check", flow_name: "custom-output", phases: ["output"] },
          { action_name: "record", flow_name: "custom-output", phases: ["output"] },
        ] },
      }],
    };
    vi.mocked(getControllerGuardrail).mockResolvedValue(fixture as unknown as Awaited<ReturnType<typeof getControllerGuardrail>>);
    expect((await getGuardrailVersion("guard-1", "v1")).rails).toEqual([{ rail_type: "output", flow: "custom-output" }]);
  });
});
