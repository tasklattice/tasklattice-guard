import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProtectionDependencies } from "./protection-dependencies";
import { protectionEn } from "../protection-i18n";
import type { GuardrailPolicyBinding, Policy } from "@/lib/api-types";

const identity = vi.hoisted(() => ({ role: "admin" }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: identity.role } }) }));
const read = vi.hoisted(() => vi.fn());
vi.mock("@/lib/controller-api", () => ({ getModelReadiness: read }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, values: Record<string, unknown> = {}) => {
  const value = key.replace(/^protection\./, "").split(".").reduce<unknown>((object, key) => (object as Record<string, unknown>)?.[key], protectionEn);
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value)), typeof value === "string" ? value : key);
} }) }));
const policy = { id: "safety", name: "Model Content Safety", protection: { execution: "model", modelCapabilities: ["content_safety"] }, rules: [{ id: "check", rails: ["input", "output"] }] } as Policy;
const binding = { policy_id: "safety", enabled_rule_ids: ["check"], enabled_rails: ["input"] } as GuardrailPolicyBinding;
const empty = { models: [], active: null, activating: null, draft: { assignments: { bindings: {} }, validationReport: null } };
function show(bindings = [binding], policies = [policy]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}><ProtectionDependencies bindings={bindings} policies={policies} /></QueryClientProvider>);
}
describe("model-dependency guidance", () => {
  beforeEach(() => { identity.role = "admin"; read.mockReset().mockResolvedValue(empty); });
  afterEach(cleanup);
  it("does not fetch model settings for local baseline Policies", () => {
    const result = show([binding], [{ ...policy, protection: { ...policy.protection!, execution: "local", modelCapabilities: [] } }]);
    expect(result.container.textContent).toBe("");
    expect(read).not.toHaveBeenCalled();
  });
  it("shows only the selected direction and opens setup without losing the draft", async () => {
    show();
    expect(await screen.findByText("Not assigned")).toBeTruthy();
    expect(screen.getByText("Content safety · Requests")).toBeTruthy();
    expect(screen.queryByText("Content safety · Responses")).toBeNull();
    expect(screen.getByRole("link").getAttribute("target")).toBe("_blank");
    expect(screen.getByText(/You can save a draft/)).toBeTruthy();
  });
  it("guides users to an administrator without linking to forbidden settings", async () => {
    identity.role = "user"; show();
    expect(await screen.findByText("Not assigned")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("auth.platformSetupRequired")).toBeTruthy();
  });
  it("shows declared custom model requirements alongside the unresolved dependency warning", async () => {
    show([binding], [{ ...policy, protection: { ...policy.protection!, execution: "custom",
      evaluationContracts: ["tali.guard.content-safety.v1", "unknown.external"] } }]);
    expect(await screen.findByText("Not assigned")).toBeTruthy();
    expect(screen.getByText("Content safety · Requests")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Do not assume these checks run locally");
    expect(screen.queryByText("Content safety · Responses")).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("shows unknown on read failure and retries instead of displaying stale success", async () => {
    read.mockRejectedValueOnce(new Error("offline"));
    show();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("Not assigned")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry assignment status" }));
    expect(await screen.findByText("Not assigned")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("retains a loading state rather than claiming missing configuration", () => {
    read.mockReturnValue(new Promise(() => {}));
    show();
    expect(screen.getByRole("status").textContent).toContain("Checking saved model assignments");
    expect(screen.queryByText("Not assigned")).toBeNull();
  });
  it("shows active assignments and failed capability evidence separately", async () => {
    read.mockResolvedValue({ ...empty, models: [{ id: "model", name: "Safety model" }],
      active: { assignments: { bindings: { "content_safety.input": "model" } }, validationReport: { checks: [{ id: "probe:content_safety.input:model", status: "failed", evidenceKind: "nemo-rail-v1" }] } } });
    show();
    expect(await screen.findByText("Activated assignment")).toBeTruthy();
    expect(screen.getByText(protectionEn.dependencies.validation.failed)).toBeTruthy();
    expect(screen.queryByText("Not assigned")).toBeNull();
  });
});
