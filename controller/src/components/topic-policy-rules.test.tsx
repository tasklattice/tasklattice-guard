import { useState } from "react";
import { resolve } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PolicyCatalog } from "../../server/policy-catalog/catalog";
import { TopicPolicyRules } from "./topic-policy-rules";
import { defaultPolicyBinding, getPolicyBindingValidation } from "./policy-binding-editor";
import { TOPIC_ALLOW_RULE as ALLOW, TOPIC_DENY_RULE as DENY } from "../../shared/topic-policy";
import * as api from "@/lib/api";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));
const available = vi.hoisted(() => ({ ready: true }));
vi.mock("./topic-control-availability", () => ({ useTopicControlAvailability: () => available, TopicControlUnavailable: () => <p>Model unavailable</p> }));
const policy = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).get("builtin-topic-safety")!;
function Harness() {
  const [binding, setBinding] = useState(defaultPolicyBinding(policy));
  return <><TopicPolicyRules policy={policy} binding={binding} onChange={patch => setBinding(current => ({ ...current, ...patch }))} /><output data-testid="binding">{JSON.stringify(binding)}</output></>;
}
function current() { return JSON.parse(screen.getByTestId("binding").textContent!); }
function setup() {
  vi.spyOn(api, "getIntentAnalysisStatus").mockResolvedValue({ available: true, document_analysis_available: true } as Awaited<ReturnType<typeof api.getIntentAnalysisStatus>>);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><Harness /></QueryClientProvider>);
}
async function helper() {
  const details = screen.getByText("protection.topicRules.helper").closest("details")!;
  details.open = true; fireEvent(details, new Event("toggle"));
  return screen.findByRole("textbox", { name: "guardrailWizard.intentInputLabel" });
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); available.ready = true; });
describe("Topic Policy configuration", () => {
  it("appends general restrictions once without changing allowlist, mode or Rule selection", () => {
    setup();
    fireEvent.click(screen.getByRole("checkbox", { name: "Model Topic Control: protection.topicRules.deny" }));
    fireEvent.change(screen.getByRole("textbox", { name: "topicControl.denied" }), { target: { value: "Existing business restriction" } });
    const before = current();
    const details = screen.getByText("protection.topicRules.commonRestrictions").closest("details")!;
    details.open = true; fireEvent(details, new Event("toggle"));
    const add = screen.getByRole("button", { name: "protection.topicRules.addCommonRestrictions" });
    fireEvent.click(add);
    expect(current()).toEqual({ ...before, parameter_values: { ...before.parameter_values, denied_topics: expect.stringMatching(/^Existing business restriction\nNews and current events/) } });
    expect(current().parameter_values.denied_topics.split("\n")).toHaveLength(10);
    expect(add.hasAttribute("disabled")).toBe(true);
    fireEvent.click(add);
    expect(current().parameter_values.denied_topics.split("\n")).toHaveLength(10);
  });
  it("toggles Rules independently and retains disabled list values", () => {
    setup();
    expect(current().enabled_rule_ids).toEqual([ALLOW]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Model Topic Control: protection.topicRules.deny" }));
    fireEvent.change(screen.getByRole("textbox", { name: "topicControl.denied" }), { target: { value: "Fraud" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Model Topic Control: protection.topicRules.allow" }));
    expect(current().enabled_rule_ids).toEqual([DENY]);
    expect(screen.queryByRole("combobox", { name: "topicControl.mode" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Model Topic Control: protection.topicRules.deny" }));
    expect(current().parameter_values.denied_topics).toBe("Fraud");
    expect(getPolicyBindingValidation(current(), policy).missingRules).toBe(true);
    expect(getPolicyBindingValidation(current(), policy).missingRequiredParameters).toEqual([]);
  });
  it("applies intent suggestions only to parameters, preserving Rule switches", async () => {
    const analyze = vi.spyOn(api, "analyzeGuardrailIntent").mockResolvedValue({ summary: "Support boundaries", allowed_topics: ["Order support"], restricted_topics: ["Fraud"], topic_control_mode: "strict", review_notes: [] } as unknown as Awaited<ReturnType<typeof api.analyzeGuardrailIntent>>);
    setup(); const before = current();
    const input=await helper();
    await waitFor(()=>expect(input.hasAttribute("disabled")).toBe(false));
    fireEvent.change(input, { target: { value: "Allow order support; deny fraud" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "guardrailWizard.intentAnalyze" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "guardrailWizard.intentAnalyze" }));
    fireEvent.click(await screen.findByRole("button", { name: "guardrailWizard.applyProposal" }));
    expect(analyze).toHaveBeenCalledWith({ purpose: "Allow order support; deny fraud", topicControlMode: "permissive", language: "en" });
    expect(current()).toEqual({ ...before, parameter_values: { ...before.parameter_values, allowed_topics: "Order support", denied_topics: "Fraud" } });
  });
  it("hides intent and document input when the runtime model is unavailable", async () => {
    available.ready = false; setup();
    const details = screen.getByText("protection.topicRules.helper").closest("details")!;
    details.open = true; fireEvent(details, new Event("toggle"));
    expect(await screen.findByText("Model unavailable")).toBeTruthy();
    expect(screen.queryByText("guardrailWizard.generateFromDocuments")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "guardrailWizard.intentInputLabel" })).toBeNull();
  });

});
