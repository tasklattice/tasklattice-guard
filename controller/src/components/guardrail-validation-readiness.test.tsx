import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GuardrailValidationReadiness, useGuardrailValidationReadiness } from "./guardrail-validation-readiness";
import { protectionEn } from "../protection-i18n";
import type { GuardrailPolicyBinding, Policy } from "@/lib/api-types";

const read = vi.hoisted(() => vi.fn());
const identity = vi.hoisted(() => ({ role: "admin" }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: identity.role } }) }));
vi.mock("@/lib/controller-api", () => ({ getModelReadiness: read }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, values: Record<string, unknown> = {}) => {
  const value = key.replace(/^protection\./, "").split(".").reduce<unknown>((object, key) => (object as Record<string, unknown>)?.[key], protectionEn);
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value)), typeof value === "string" ? value : key);
} }) }));
const policy = { id: "topic", name: "Topic Control", protection: { execution: "model", modelCapabilities: ["topic_control"] }, rules: [{ id: "check", rails: ["input"] }] } as Policy;
const binding = { policy_id: "topic", enabled_rule_ids: ["check"], enabled_rails: ["input"] } as GuardrailPolicyBinding;
const empty = { models: [{ id: "model", name: "Topic model" }], active: null, activating: null, draft: null };
const revision = (status = "passed", evidenceKind = "nemo-rail-v1") => ({ assignments: { bindings: { "topic_control.input": "model" } }, validationReport: { checks: [{ id: "probe:topic_control.input:model", status, evidenceKind }] } });
function show(policies = [policy], onEdit = vi.fn(), bindings = [binding]) {
  function Probe() {
    const readiness = useGuardrailValidationReadiness({ bindings, policies });
    return <><GuardrailValidationReadiness readiness={readiness} onEdit={onEdit} /><button disabled={readiness.blocked}>Run tests</button></>;
  }
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}><Probe /></QueryClientProvider>);
}
beforeEach(() => { identity.role = "admin"; read.mockReset().mockResolvedValue(empty); });
afterEach(cleanup);
it("shows an actionable missing Topic dependency and blocks Validation", async () => {
  const onEdit = vi.fn(); show([policy], onEdit);
  expect((await screen.findByRole("alert")).textContent).toContain("No model is assigned");
  expect(screen.getByRole("alert").textContent).toContain("Affected Policies: Topic Control");
  expect(screen.getByRole("button", { name: "Run tests" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("link", { name: protectionEn.dependencies.configure }).getAttribute("href")).toBe("/settings/guardrail-catalog");
  fireEvent.click(screen.getByRole("button", { name: "Edit and remove Topic Control" }));
  expect(onEdit).toHaveBeenCalledOnce();
});
it.each(["unverified", "failed", "validated", "activating"])("blocks %s assignments", async state => {
  read.mockResolvedValue({ ...empty, [state === "activating" ? "activating" : "draft"]: revision(state === "failed" ? "failed" : "passed", state === "unverified" ? "model-probe" : "nemo-rail-v1") });
  show();
  expect((await screen.findByRole("alert")).textContent).toContain(protectionEn.validationReadiness.states[state as keyof typeof protectionEn.validationReadiness.states]);
  expect(screen.getByRole("button", { name: "Run tests" }).hasAttribute("disabled")).toBe(true);
});
it.each(["failed", "skipped"])("allows retesting an active model with %s capability evidence", async status => {
  read.mockResolvedValue({ ...empty, active: revision(status) }); show();
  await screen.findByText(protectionEn.dependencies.validation[status === "failed" ? "failed" : "unverified"], { exact: false });
  expect(screen.getByRole("button", { name: "Run tests" }).hasAttribute("disabled")).toBe(false);
  expect(screen.queryByRole("alert")).toBeNull();
});
it("identifies the independent missing Jailbreak binding and recovers after applying it", async () => {
  const policies = [
    { ...policy, id: "safety", name: "Model Content Safety", protection: { execution: "model", modelCapabilities: ["content_safety"] } } as Policy,
    { ...policy, id: "jailbreak", name: "Strict Jailbreak Protection", protection: { execution: "model", modelCapabilities: ["jailbreak"] } } as Policy,
  ];
  const active = { ...revision(), assignments: { bindings: { "content_safety.input": "model" } } };
  const applied = { ...active, assignments: { bindings: { ...active.assignments.bindings, "jailbreak.input": "model" } } };
  read.mockResolvedValueOnce({ ...empty, active }).mockResolvedValue({ ...empty, active: applied });
  show(policies, vi.fn(), policies.map(p => ({ ...binding, policy_id: p.id })));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Jailbreak detection · Requests");
  expect(alert.textContent).not.toContain("Content safety · Requests");
  expect(alert.textContent).toContain("Content Safety and Jailbreak need separate bindings");
  fireEvent.click(screen.getByRole("button", { name: "Recheck dependencies" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Run tests" }).hasAttribute("disabled")).toBe(false));
});
it("directs non-administrators to platform setup without an inaccessible settings link", async () => {
  identity.role = "user"; show();
  await screen.findByRole("alert");
  expect(screen.queryByRole("link", { name: protectionEn.dependencies.configure })).toBeNull();
  expect(screen.getByText("auth.platformSetupRequired")).toBeTruthy();
});
it("retains active readiness despite a failed newer draft", async () => {
  read.mockResolvedValue({ ...empty, active: revision(), draft: revision("failed") }); show();
  await waitFor(() => expect(screen.getByRole("button", { name: "Run tests" }).hasAttribute("disabled")).toBe(false));
  expect(screen.queryByRole("alert")).toBeNull();
});
it("does not fetch or block local-only Policies", () => {
  show([{ ...policy, protection: { ...policy.protection!, execution: "local", modelCapabilities: [] } }]);
  expect(read).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Run tests" }).hasAttribute("disabled")).toBe(false);
});
it("distinguishes pending and failed reads from missing models, and retries", async () => {
  read.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ...empty, active: revision() }); show();
  expect(screen.getByRole("status").textContent).toContain("Checking draft");
  await screen.findByText(protectionEn.validationReadiness.unavailable);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Run tests" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Recheck dependencies" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Run tests" }).hasAttribute("disabled")).toBe(false));
});
