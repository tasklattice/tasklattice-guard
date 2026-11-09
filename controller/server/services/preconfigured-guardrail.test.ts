import { describe, expect, it, vi } from "vitest";
import type { ControllerConfig } from "../config.js";
import type { ControllerDatabase } from "../db/client.js";
import { ControlPlaneService } from "./control-plane.js";

const id = "guardrail-default";
const actorId = "user";
const operations: Array<[string, (service: ControlPlaneService) => Promise<unknown>]> = [
  ["rename", service => service.updateGuardrail({ id, actorId, name: "Changed" })],
  ["change runtime", service => service.updateGuardrail({ id, actorId, runtimeProfile: "iorails_native" })],
  ["discard draft", service => service.discardGuardrailDraft({ id, actorId, expectedDraftRevision: 5, expectedBaselineVersion: "published" })],
  ["add test", service => service.createTestCase({
    guardrailId: id, actorId, name: "Custom", policyId: "custom", phase: "input",
    content: "hello", expectedDecision: "allow", trustedInstruction: "", targetSource: "user_input",
    query: "", groundingSources: [], expectedReasoningResult: null,
  })],
  ["delete test", service => service.deleteTestCase({ guardrailId: id, actorId, caseId: "custom" })],
  ["exclude test", service => service.setTestCaseExcluded({ guardrailId: id, actorId, caseId: "inherited", excluded: true })],
  ["restore test", service => service.setTestCaseExcluded({ guardrailId: id, actorId, caseId: "inherited", excluded: false })],
];

describe("Preconfigured Guardrail uses ordinary mutation paths", () => {
  it.each(operations)("reaches the same transaction for %s", async (_name, operation) => {
    const reached = new Error("ordinary transaction");
    const transaction = vi.fn().mockRejectedValue(reached);
    const service = new ControlPlaneService({ transaction } as unknown as ControllerDatabase, {} as ControllerConfig);
    await expect(operation(service)).rejects.toBe(reached);
    expect(transaction).toHaveBeenCalledOnce();
  });
});
