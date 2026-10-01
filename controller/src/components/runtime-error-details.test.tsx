import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import i18n from "@/i18n";
import { runtimeLogInteractions } from "@/lib/api";
import type { RuntimeEvent } from "@/lib/controller-api";
import { RuntimeCheckpoint } from "./runtime-log-sheet";

afterEach(cleanup);
const event: RuntimeEvent = { id: "event", requestId: "call-123", occurredAt: "2026-09-19T10:00:00Z", runnerId: "runner", guardrailId: "guard", guardrailVersion: "v1", endpointId: null, routerId: null, direction: "incoming", decision: "block", durationMs: 42, metadata: {} };
async function mount(overrides: Partial<RuntimeEvent>) {
  await i18n.changeLanguage("en");
  const entry = runtimeLogInteractions([{ ...event, ...overrides }], { includeUncaptured: true })[0]!.entries[0]!;
  return render(<RuntimeCheckpoint entry={entry} admin />);
}
it("shows recorded error evidence immediately while leaving execution trace collapsed", async () => {
  await mount({ metadata: { trace: [{ id: "failed-span", name: "Judge action", outcome: "error", errorType: "AuthenticationError", providerName: "openai", modelName: "judge-model" }] } });
  expect(screen.getByText("AuthenticationError")).toBeTruthy();
  expect(screen.getByText("failed-span")).toBeTruthy();
  expect(screen.getByText("judge-model")).toBeTruthy();
  expect(screen.getByText("Error")).toBeTruthy();
  expect(screen.getByText("Block")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Execution trace/ }).getAttribute("aria-expanded")).toBe("false");
});
it("explains inferred completion without inventing an exception or request body", async () => {
  await mount({ id:"call:decision", direction:"completion", decision:"timeout", durationMs:300000, metadata:{ logKind:"call_completion",completionInferred:true,decisionId:"decision",completedAt:"2026-09-19T10:05:00Z" } });
  expect(screen.getByText("Completion not reported · inferred timeout")).toBeTruthy();
  expect(screen.getByText(/within 300 seconds/).textContent).toContain("does not confirm a model error");
  expect(screen.getByText("decision")).toBeTruthy();
  expect(screen.queryByText("Request content")).toBeNull();
  expect(screen.queryByRole("button", { name:/Execution trace/ })).toBeNull();
});
it("renders a reported failure reason as text", async () => {
  await mount({ direction:"completion",decision:"error",metadata:{logKind:"call_completion",failureReason:"upstream_unavailable"} });
  expect(screen.getByText("upstream_unavailable")).toBeTruthy();
  expect(screen.queryByText(/does not confirm a model error/)).toBeNull();
});
