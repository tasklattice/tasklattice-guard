import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GuardrailPolicyBinding, Policy } from "@/lib/api";
import { queryKeys } from "@/features/query-keys";

import { CreateGuardrailWizard } from "./create-guardrail-wizard";
import { protectionEn } from "../protection-i18n";

const apiMocks = vi.hoisted(() => ({
  analyzeIntent: vi.fn(),
  createGuardrail: vi.fn(),
  getIntentStatus: vi.fn(),
  getPolicies: vi.fn(),
  getPresets: vi.fn(),
  preview: vi.fn(),
}));
const identity = vi.hoisted(() => ({ role: 'admin' }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const labels: Record<string, string> = {
        "common.cancel": "Cancel",
        "common.next": "Next",
        "common.previous": "Previous",
        "guardrailWizard.title": "Create Guardrail",
        "guardrailWizard.steps.details": "Details",
        "guardrailWizard.steps.detailsDescription": "Name your Guardrail",
        "guardrailWizard.steps.policies": "Policies",
        "guardrailWizard.steps.policiesDescription": "Protections and actions",
        "guardrailWizard.steps.review": "Review",
        "guardrailWizard.steps.reviewDescription": "Confirm draft",
        "guardrailWizard.detailsTitle": "Guardrail details",
        "guardrailWizard.name": "Name",
        "guardrailWizard.namePlaceholder": "Customer data protection",
        "guardrailWizard.policiesTitle": "Bind Policies",
        "guardrailWizard.policyAssistantTitle": "Start with existing Policies or generate a proposal",
        "guardrailWizard.generateFromIntent": "Generate from intent",
        "guardrailWizard.generateFromIntentDescription": "Generate Topic Control",
        "guardrailWizard.generateFromDocuments": "Generate from documents",
        "guardrailWizard.generateFromDocumentsDescription": "Analyze compliance documents",
        "guardrailWizard.intentWorkspaceTitle": "Generate Topic Control from intent",
        "guardrailWizard.intentInputLabel": "Your intent",
        "guardrailWizard.intentInputPlaceholder": "Describe intent",
        "guardrailWizard.intentAnalyze": "Generate proposal",
        "guardrailWizard.intentAnalyzing": "Generating proposal…",
        "guardrailWizard.intentProposalTitle": "Topic Control proposal",
        "guardrailWizard.aiProposal": "AI proposal",
        "guardrailWizard.applyProposal": "Apply proposal",
        "guardrailWizard.backToPolicies": "Back to Policies",
        "guardrailWizard.topicControl": "Topic Control",
        "guardrailWizard.allowedDomains": "Allowed business domains",
        "guardrailWizard.restrictedDomains": "Restricted domains",
        "guardrailWizard.addBoundaries": "Add topic allowlist",
        "guardrailWizard.topicAllowlistHint": "Anything not listed is off-topic.",
        "guardrailWizard.boundarySources.intent": "Generated from intent",
        "guardrailWizard.outputDelivery": "Output delivery",
        "guardrailWizard.outputDeliveryOptions.window_buffered": "Window buffered",
        "guardrailWizard.nextBlocked.name": "Enter a Guardrail name to continue.",
        "guardrailWizard.nextBlocked.allowedTopics": "Add at least one allowed topic.",
        "guardrailWizard.nextBlocked.selectPolicy": "Select at least one published Policy to continue.",
        "guardrailWizard.nextBlocked.requiredFields": "Complete required fields for {{name}}: {{fields}}.",
        "guardrailWizard.reviewTitle": "Review Guardrail",
        "guardrailWizard.reviewDraftTitle": "No live traffic changes",
        "guardrailWizard.createDraft": "Create draft",
        "guardrailWizard.creatingDraft": "Creating draft…",
      };
      return Object.entries(values ?? {}).reduce(
        (label, [name, value]) => label.replace(`{{${name}}}`, String(value)),
        labels[key] ?? (key.startsWith("protection.") ? key.slice(11).split(".").reduce((value: unknown, part) => (value as Record<string, unknown>)?.[part], protectionEn) as string : undefined) ?? key,
      );
    },
    i18n: { language: "en" },
  }),
}));

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: identity.role, preferred_language: "en" } }) }));

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...original,
    analyzeGuardrailIntent: (...args: unknown[]) => apiMocks.analyzeIntent(...args),
    createGuardrail: (...args: unknown[]) => apiMocks.createGuardrail(...args),
    getIntentAnalysisStatus: (...args: unknown[]) => apiMocks.getIntentStatus(...args),
    getPolicies: (...args: unknown[]) => apiMocks.getPolicies(...args),
    getProtectionPresets: (...args: unknown[]) => apiMocks.getPresets(...args),
    previewGuardrailCandidate: (...args: unknown[]) => apiMocks.preview(...args),
  };
});

vi.mock("@/components/entity-sheet", () => ({
  EntitySheet: ({ open, title, description, children, footer }: { open: boolean; title: React.ReactNode; description: React.ReactNode; children: React.ReactNode; footer: React.ReactNode }) => (
    open ? <div data-testid="entity-sheet"><h1>{title}</h1><p>{description}</p>{children}<footer>{footer}</footer></div> : null
  ),
}));

vi.mock("@/components/creation-flow", () => ({
  CreationFlow: ({ children, steps, onStepChange }: { children: React.ReactNode; steps: Array<{ label: string }>; onStepChange: (step: number) => void }) => (
    <div><nav>{steps.map((step, index) => <button key={step.label} onClick={() => onStepChange(index)}>{step.label}</button>)}</nav>{children}</div>
  ),
}));

vi.mock("@/components/policy-binding-editor", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/policy-binding-editor")>();
  return {
    ...original,
    PolicyBindingEditor: (props: { policies: Policy[]; value: GuardrailPolicyBinding[]; onChange: (value: GuardrailPolicyBinding[]) => void }) => props.value.some(item => item.policy_id === "configured-phrase-filter") ? <original.PolicyBindingEditor {...props} /> : (
      <div>
        <button type="button" onClick={() => props.onChange([binding])}>Select Topic Policy</button>
        <button type="button" onClick={() => props.onChange([requiredBinding])}>Select Aviation Policy</button>
        <button type="button" onClick={() => props.onChange([configuredRequiredBinding])}>Complete Aviation configuration</button>
      </div>
    ),
  };
});

const policy = {
  protection: { directory: "business_topics", execution: "local", modelCapabilities: [], requiredContext: [], outputStreaming: "complete_response", limitations: [] },
  implementation: "rules",
  id: "topic-filtering",
  name: "Topic Filtering",
  description: "Topic control",
  source: "built_in",
  version: "1",
  tags: [{ id: "guardrail_category:topic_control", namespace: "guardrail_category", value: "topic_control", label: "Topic Control", source: "declared" }],
  parameters: [],
  rails: ["input", "output"],
  effects: ["block"],
  forms: ["keyword"],
  rules: [{ id: "topic-rule" }],
  test_cases: [],
  test_count: 1,
  safety_level: "balanced",
  output_delivery: "window_buffered",
} as Policy;

const binding = {
  policy_id: policy.id,
  policy_version: policy.version,
  action: null,
  parameter_values: {},
  enabled_rule_ids: ["topic-rule"],
  rule_actions: {},
  enabled_rails: ["input", "output"],
  reasoning_policy: null,
} satisfies GuardrailPolicyBinding;

const requiredPolicy = {
  ...policy,
  protection: { ...policy.protection!, directory: "business_rules" },
  id: "aviation-operations-security",
  name: "Aviation Operations Security",
  tags: [],
  parameters: [
    { name: "brand_name", label: "Your Airline / Brand Name", kind: "text", required: true, placeholder: "e.g. Acme Airlines", description: "" },
    { name: "competitors", label: "Competitors", kind: "textarea", required: true, placeholder: "One competitor per line", description: "Reviewed competitors." },
  ],
} satisfies Policy;

const requiredBinding = {
  ...binding,
  policy_id: requiredPolicy.id,
  policy_version: requiredPolicy.version,
  parameter_values: {},
} satisfies GuardrailPolicyBinding;

const configuredRequiredBinding = {
  ...requiredBinding,
  parameter_values: { brand_name: "TaskLattice Air", competitors: "Example Air" },
} satisfies GuardrailPolicyBinding;

function renderWizard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onCreated = vi.fn();
  const tree = () => (
      <QueryClientProvider client={client}>
        <CreateGuardrailWizard open onOpenChange={vi.fn()} onCreated={onCreated} />
      </QueryClientProvider>
  );
  const view = render(tree());
  return { client, onCreated, ...view, refreshIdentity: () => view.rerender(tree()) };
}

describe("Create Guardrail wizard", () => {
  beforeEach(() => {
    identity.role = 'admin';
    apiMocks.analyzeIntent.mockReset().mockResolvedValue({
      summary: "Customer support only.",
      structured_purpose: { audience: "Support agents", tasks: "Answer order questions", protect: "Customer identifiers", out_of_scope: "Medical advice" },
      allowed_topics: ["Orders", "Returns"],
      review_notes: [],
    });
    apiMocks.getIntentStatus.mockReset().mockResolvedValue({ available: true, provider: "test", model: "test", document_analysis_available: true });
    apiMocks.getPolicies.mockReset().mockResolvedValue({ items: [policy, requiredPolicy], count: 2 });
    apiMocks.getPresets.mockReset().mockResolvedValue({ items: [], count: 0 });
    apiMocks.preview.mockReset().mockResolvedValue({
      engine: "GuardRails 0 · NeMo",
      colang_version: "2.x",
      checksum: "draft-checksum",
      rails: [],
      actions: [],
      estimated_critical_path_ms: 0,
    });
    apiMocks.createGuardrail.mockReset().mockResolvedValue({ id: "guardrail-1", name: "Support Guardrail" });
  });

  afterEach(() => { cleanup(); onlineManager.setOnline(true); });

  it("applies the first preset immediately, resolves later changes explicitly, and supports undo", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    apiMocks.getPresets.mockResolvedValue({ items: [
      { id: "banking", name: "Banking preset", description: "Banking", bindings: [binding], limitations: [] },
      { id: "internet", name: "Internet preset", description: "Internet", bindings: [configuredRequiredBinding], limitations: [] },
    ] });
    renderWizard();
    fireEvent.change(screen.getByPlaceholderText("Customer data protection"), { target: { value: "Preset feedback" } });
    const picker = await screen.findByRole("combobox");
    async function choose(name: string) {
      fireEvent.keyDown(picker, { key: "ArrowDown" });
      fireEvent.click(await screen.findByRole("option", { name }));
    }
    await choose("Banking preset");
    expect(screen.getByText("Preset applied · 1 Policies selected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply preset" })).toBeNull();
    await choose("Internet preset");
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: protectionEn.wizard.addPreset }));
    expect(screen.getByText("Preset applied · 2 Policies selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: protectionEn.wizard.undoPreset }));
    expect(picker.textContent).toBe("Banking preset");
    await choose("Internet preset");
    fireEvent.click(screen.getByRole("button", { name: protectionEn.wizard.replacePreset }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "All protections" }));
    expect(screen.getByRole("checkbox", { name: "Topic Filtering" })).toHaveProperty("ariaChecked", "false");
    fireEvent.click(screen.getByRole("button", { name: "Review draft" }));
    await waitFor(() => expect(apiMocks.preview).toHaveBeenCalledWith(expect.objectContaining({ policy_bindings: [configuredRequiredBinding] })));
  });

  it("shows exactly three steps and collects all protections without category navigation", async () => {
    renderWizard();
    expect(screen.getByRole("navigation").querySelectorAll("button")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Content safety" })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Customer data protection"), { target: { value: "Support Guardrail" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("checkbox", { name: "Topic Filtering" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Aviation Operations Security" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review draft" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Leave unselected & continue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Complete Aviation configuration" })).toBeNull();
  });

  it("searches and filters without changing bindings, then returns from review to configuration", async () => {
    renderWizard();
    fireEvent.change(screen.getByPlaceholderText("Customer data protection"), { target: { value: "Filtered draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Configure protections" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Aviation Operations Security" }));
    fireEvent.click(screen.getByRole("button", { name: "Configure Aviation Operations Security", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Complete Aviation configuration" }));
    fireEvent.click(screen.getByRole("button", { name: "Configure Aviation Operations Security", exact: true }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search protections" }), { target: { value: "Topic Filtering" } });
    expect(screen.queryByRole("checkbox", { name: "Aviation Operations Security" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Topic Filtering" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review draft" }));
    await waitFor(() => expect(apiMocks.preview).toHaveBeenCalledWith(expect.objectContaining({ policy_bindings: [configuredRequiredBinding] })));
    fireEvent.click(screen.getByRole("button", { name: "Edit protections" }));
    expect(screen.getByRole("checkbox", { name: "Aviation Operations Security" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("textbox", { name: "Search protections" }).getAttribute("value")).toBe("");
  });

  it("keeps intent generation inside Policies and applies only after review", async () => {
    renderWizard();
    fireEvent.change(screen.getByPlaceholderText("Customer data protection"), { target: { value: "Support Guardrail" } });
    fireEvent.click(screen.getByRole("button", { name: "Configure protections" }));
    if (screen.queryByRole("button", { name: "All protections" })) fireEvent.click(screen.getByRole("button", { name: "All protections" }));
    await screen.findByText(protectionEn.wizard.businessAssistant);
    fireEvent.click(screen.getByText(protectionEn.wizard.businessAssistant));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Topic Filtering" }));

    fireEvent.click(screen.getByRole("button", { name: /Generate from intent/ }));
    expect(screen.getByText("Generate Topic Control from intent")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to Policies" })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Describe intent"), { target: { value: "Support agents may answer order questions but not medical advice." } });
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));

    expect(await screen.findByText("Topic Control proposal")).toBeTruthy();
    expect(screen.getAllByText("Medical advice").length).toBeGreaterThan(0);
    expect(screen.queryByText("Generated from intent")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply proposal" }));

    expect(await screen.findByText("Generated from intent")).toBeTruthy();
    fireEvent.click(screen.getByText(protectionEn.wizard.advanced));
    expect(screen.getByText("Output delivery")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Output delivery" }).hasAttribute("disabled")).toBe(true);
  });

  it("saves a Policy-based draft without a purpose or description", async () => {
    const { onCreated } = renderWizard();
    fireEvent.change(screen.getByPlaceholderText("Customer data protection"), { target: { value: "Support Guardrail" } });
    fireEvent.click(screen.getByRole("button", { name: "Configure protections" }));
    if (screen.queryByRole("button", { name: "All protections" })) fireEvent.click(screen.getByRole("button", { name: "All protections" }));
    await screen.findByText(protectionEn.wizard.businessAssistant);
    fireEvent.click(screen.getByText(protectionEn.wizard.businessAssistant));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Topic Filtering" }));
    fireEvent.click(screen.getByRole("button", { name: "Add topic allowlist" }));
    fireEvent.change(screen.getByPlaceholderText("guardrailWizard.onePerLine"), { target: { value: "Orders\nReturns" } });
    fireEvent.click(screen.getByRole("button", { name: "Review & create" }));

    await waitFor(() => expect(apiMocks.preview).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Create draft" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));

    await waitFor(() => expect(apiMocks.createGuardrail).toHaveBeenCalledWith(expect.objectContaining({
      name: "Support Guardrail",
      allowed_topics: ["Orders", "Returns"],
      safety_level: "balanced",
      policy_bindings: [binding],
    })));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("guardrail-1"));
    const saved = apiMocks.createGuardrail.mock.calls[0]![0];
    expect(saved).not.toHaveProperty("purpose");
    expect(saved).not.toHaveProperty("purpose_details");
    expect(saved).not.toHaveProperty("description");
  });

  it("saves phrases inside an ordinary Policy alongside a model Policy", async () => {
    const phrasePolicy = {
      ...policy, id: "configured-phrase-filter", name: "Phrase filters", version: "1.0.0",
      protection: { ...policy.protection!, directory: "content_filters" },
      parameters: [{ name: "phrase_entries", label: "Phrases and actions", kind: "phrase_entries", required: true, description: "" }],
      rules: [{ id: "configured/phrases", name: "Configured phrase sequence", form: "keyword", effect: "reject", rails: ["input", "output"], implementation: { detector: "configured_phrases" } }],
    } as Policy;
    apiMocks.getPolicies.mockResolvedValue({ items: [policy, phrasePolicy] });
    renderWizard();
    fireEvent.change(screen.getByPlaceholderText("Customer data protection"), { target: { value: "Support Guardrail" } });
    fireEvent.click(screen.getByRole("button", { name: "Configure protections" }));
    if (screen.queryByRole("button", { name: "All protections" })) fireEvent.click(screen.getByRole("button", { name: "All protections" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Topic Filtering" }));
    fireEvent.click(screen.getByRole("button", { name: "Add topic allowlist" }));
    fireEvent.change(screen.getByPlaceholderText("guardrailWizard.onePerLine"), { target: { value: "Orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Configure protections" }));
    if (screen.queryByRole("button", { name: "All protections" })) fireEvent.click(screen.getByRole("button", { name: "All protections" }));
    expect(screen.queryByRole("button", { name: "Add rule" })).toBeNull();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Phrase filters" }));
    expect(screen.queryByRole("button", { name: "Add phrase" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Configure Phrase filters", exact: true }));
    expect(screen.getByRole("combobox", { name: "Action for Configured phrase sequence" }).textContent).toBe("Phrase actions");
    expect(screen.getByRole("button", { name: "Review draft" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Add phrase" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Phrase 1" }), { target: { value: "internal-name" } });
    expect(screen.getByRole("button", { name: "Review draft" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByText(protectionEn.wizard.advanced));
    const delivery = screen.getByRole("combobox", { name: "Output delivery" });
    expect(delivery.hasAttribute("disabled")).toBe(true);
    const description = document.getElementById(delivery.getAttribute("aria-describedby")!);
    expect(description?.textContent).toContain("Phrase filters");
    expect(description?.textContent).toContain("no response text is released before these checks finish");
    expect(description?.getAttribute("aria-live")).toBe("polite");
    fireEvent.click(screen.getByRole("button", { name: "Review & create" }));
    await waitFor(() => expect(apiMocks.preview).toHaveBeenCalled());
    const preview = apiMocks.preview.mock.calls.at(-1)![0];
    expect(preview).not.toHaveProperty("custom_content_rules");
    expect(preview.policy_bindings.map((item: GuardrailPolicyBinding) => item.policy_id)).toEqual([binding.policy_id, phrasePolicy.id]);
    expect(JSON.parse(preview.policy_bindings[1].parameter_values.phrase_entries)).toEqual([
      expect.objectContaining({ phrase: "internal-name", action: "reject" }),
    ]);
    expect(preview.output_delivery).toBe("full_buffered");
    await waitFor(() => expect(screen.getByRole("button", { name: "Create draft" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(apiMocks.createGuardrail).toHaveBeenCalledWith(preview));
  });


  it("explains hidden required Policy configuration and enables Next after it is completed", async () => {
    renderWizard();
    fireEvent.change(screen.getByPlaceholderText("Customer data protection"), { target: { value: "Aviation Guardrail" } });
    fireEvent.click(screen.getByRole("button", { name: "Configure protections" }));
    if (screen.queryByRole("button", { name: "All protections" })) fireEvent.click(screen.getByRole("button", { name: "All protections" }));

    fireEvent.click(await screen.findByRole("checkbox", { name: "Aviation Operations Security" }));

    const next = screen.getByRole("button", { name: "Review draft" });
    expect(next.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Complete required fields for Aviation Operations Security: Your Airline / Brand Name, Competitors.")).toBeTruthy();
    expect(next.getAttribute("aria-describedby")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Configure Aviation Operations Security", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Complete Aviation configuration" }));

    expect(next.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText("Complete required fields for Aviation Operations Security: Your Airline / Brand Name, Competitors.")).toBeNull();
    fireEvent.click(next);
    expect(screen.getByText("Review Guardrail")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review & create" }));
    expect(await screen.findByText("Review Guardrail")).toBeTruthy();
  });

  it("does not preview or create an empty protection map when Review is visited directly", async () => {
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: "Review & create" }));
    expect(await screen.findByText("Add a name on the first step before creating the draft.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create draft" }).hasAttribute("disabled")).toBe(true);
    expect(apiMocks.preview).not.toHaveBeenCalled();
  });

  it("lets a Company Policy configure its required topics in its own business-rules step", async () => {
    const company: Policy = { ...policy, id: "builtin-company-policy", name: "Company boundaries",
      protection: { ...policy.protection!, directory: "business_rules", execution: "model", requiredContext: ["allowed_topics"] },
    };
    apiMocks.getPolicies.mockResolvedValue({ items: [company], count: 1 });
    renderWizard();
    fireEvent.change(screen.getByPlaceholderText("Customer data protection"), { target: { value: "Company protection" } });
    fireEvent.click(screen.getByRole("button", { name: "Configure protections" }));
    if (screen.queryByRole("button", { name: "All protections" })) fireEvent.click(screen.getByRole("button", { name: "All protections" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Company boundaries" }));
    expect(screen.getByRole("button", { name: "Review draft" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Add at least one allowed topic.")).toBeTruthy();
    // No navigation to an unrelated step is necessary to recover.
    fireEvent.change(screen.getByPlaceholderText("guardrailWizard.onePerLine"), { target: { value: "Bank account support" } });
    expect(screen.getByRole("button", { name: "Review draft" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Review & create" }));
    await waitFor(() => expect(apiMocks.preview).toHaveBeenCalledWith(expect.objectContaining({
      allowed_topics: ["Bank account support"], policy_bindings: [expect.objectContaining({ policy_id: company.id })],
    })));
  });

  it("preserves another directory's selection when a Policy is removed", async () => {
    renderWizard();
    fireEvent.change(screen.getByPlaceholderText("Customer data protection"), { target: { value: "Scoped changes" } });
    fireEvent.click(screen.getByRole("button", { name: "Configure protections" }));
    if (screen.queryByRole("button", { name: "All protections" })) fireEvent.click(screen.getByRole("button", { name: "All protections" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Topic Filtering" }));
    fireEvent.click(screen.getByRole("button", { name: "Configure protections" }));
    if (screen.queryByRole("button", { name: "All protections" })) fireEvent.click(screen.getByRole("button", { name: "All protections" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Aviation Operations Security" }));
    fireEvent.click(screen.getByRole("button", { name: "Configure Aviation Operations Security", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Complete Aviation configuration" }));
    fireEvent.click(screen.getByRole("button", { name: "Configure protections" }));
    if (screen.queryByRole("button", { name: "All protections" })) fireEvent.click(screen.getByRole("button", { name: "All protections" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Topic Filtering" }));
    fireEvent.click(screen.getByRole("button", { name: "Review & create" }));
    await waitFor(() => expect(apiMocks.preview).toHaveBeenCalledWith(expect.objectContaining({ policy_bindings: [configuredRequiredBinding] })));
  });

  it("preserves selections but prevents writes after administrator access is lost", async () => {
    const { refreshIdentity } = renderWizard();
    fireEvent.change(screen.getByPlaceholderText("Customer data protection"), { target: { value: "Preserved access draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Configure protections" }));
    if (screen.queryByRole("button", { name: "All protections" })) fireEvent.click(screen.getByRole("button", { name: "All protections" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Topic Filtering" }));
    fireEvent.click(screen.getByRole("button", { name: "Review & create" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create draft" }).hasAttribute("disabled")).toBe(false));

    identity.role = 'member';
    refreshIdentity();
    expect(screen.getByRole("button", { name: "Create draft" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(protectionEn.adminAccessRequired)).toBeTruthy();
    expect(screen.getByText("Preserved access draft")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(apiMocks.createGuardrail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Configure protections" }));
    if (screen.queryByRole("button", { name: "All protections" })) fireEvent.click(screen.getByRole("button", { name: "All protections" }));
    fireEvent.click(screen.getByText(protectionEn.wizard.businessAssistant));
    expect(screen.getByRole("button", { name: /Generate from intent/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /Generate from documents/ }).hasAttribute("disabled")).toBe(true);

    identity.role = 'admin';
    refreshIdentity();
    fireEvent.click(screen.getByRole("button", { name: "Review & create" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create draft" }).hasAttribute("disabled")).toBe(false));
    expect(apiMocks.createGuardrail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(apiMocks.createGuardrail).toHaveBeenCalledOnce());
    expect(apiMocks.createGuardrail).toHaveBeenCalledWith(expect.objectContaining({ name: 'Preserved access draft', policy_bindings: [binding] }));
  });

  it.each(["success", "error", "missing"])("distinguishes catalog reset from missing Policies, then handles %s without losing bindings", async (result) => {
    const { client } = renderWizard();
    fireEvent.change(screen.getByPlaceholderText("Customer data protection"), { target: { value: "Catalog recovery draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Configure protections" }));
    if (screen.queryByRole("button", { name: "All protections" })) fireEvent.click(screen.getByRole("button", { name: "All protections" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Topic Filtering" }));
    fireEvent.click(screen.getByRole("button", { name: "Review & create" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create draft" }).hasAttribute("disabled")).toBe(false));
    const previewCalls = apiMocks.preview.mock.calls.length;
    let resolveCatalog!: (value: { items: Policy[]; count: number }) => void;
    let rejectCatalog!: (error: Error) => void;
    apiMocks.getPolicies.mockImplementationOnce(() => new Promise((resolve, reject) => { resolveCatalog = resolve; rejectCatalog = reject; }));
    act(() => { void client.resetQueries({ queryKey: queryKeys.policies }); });
    expect((await screen.findAllByText(protectionEn.catalogLoading)).length).toBeGreaterThan(0);
    expect(screen.getByText("Catalog recovery draft")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create draft" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText("guardrailWizard.nextBlocked.policyUnavailable")).toBeNull();
    expect(screen.queryByText(/Dependencies require review for custom Policies/)).toBeNull();
    expect(screen.queryByText(protectionEn.unset)).toBeNull();
    expect(apiMocks.preview).toHaveBeenCalledTimes(previewCalls);
    expect(apiMocks.createGuardrail).not.toHaveBeenCalled();

    if (result === "error") {
      act(() => rejectCatalog(new Error("Catalog connection lost")));
      expect((await screen.findAllByText(protectionEn.catalogUnavailable)).length).toBeGreaterThan(0);
      expect(screen.queryByText("guardrailWizard.nextBlocked.policyUnavailable")).toBeNull();
      expect(screen.getByRole("button", { name: "Create draft" }).hasAttribute("disabled")).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: protectionEn.retryCatalog }));
    } else {
      act(() => resolveCatalog(result === "missing" ? { items: [], count: 0 } : { items: [policy, requiredPolicy], count: 2 }));
    }
    if (result === "missing") {
      expect(await screen.findByText("guardrailWizard.nextBlocked.policyUnavailable")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Create draft" }).hasAttribute("disabled")).toBe(true);
      expect(apiMocks.createGuardrail).not.toHaveBeenCalled();
      return;
    }
    await waitFor(() => expect(screen.getByRole("button", { name: "Create draft" }).hasAttribute("disabled")).toBe(false));
    expect(apiMocks.createGuardrail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(apiMocks.createGuardrail).toHaveBeenCalledOnce());
    expect(apiMocks.createGuardrail).toHaveBeenCalledWith(expect.objectContaining({ name: "Catalog recovery draft", policy_bindings: [binding], output_delivery: "full_buffered" }));
  });

  it("keeps a failed plan preview visible and supports a scoped retry", async () => {
    apiMocks.preview.mockRejectedValueOnce(new Error("Model assignment is unavailable"));
    renderWizard();
    fireEvent.change(screen.getByPlaceholderText("Customer data protection"), { target: { value: "Retry draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Configure protections" }));
    if (screen.queryByRole("button", { name: "All protections" })) fireEvent.click(screen.getByRole("button", { name: "All protections" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Topic Filtering" }));
    fireEvent.click(screen.getByRole("button", { name: "Review & create" }));
    const retry = await screen.findByRole("button", { name: "Retry plan preview" });
    expect(screen.getByRole("button", { name: "Create draft" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole("button", { name: "Create draft" }).hasAttribute("disabled")).toBe(false));
    expect(apiMocks.preview).toHaveBeenCalledTimes(2);
  });

  it("reports offline creation without queuing a later write and preserves selections for explicit retry", async () => {
    apiMocks.createGuardrail.mockRejectedValueOnce(new Error("Connection lost"));
    const { onCreated } = renderWizard();
    fireEvent.change(screen.getByPlaceholderText("Customer data protection"), { target: { value: "Offline draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Configure protections" }));
    if (screen.queryByRole("button", { name: "All protections" })) fireEvent.click(screen.getByRole("button", { name: "All protections" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Topic Filtering" }));
    fireEvent.click(screen.getByRole("button", { name: "Review & create" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create draft" }).hasAttribute("disabled")).toBe(false));
    onlineManager.setOnline(false);
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText("Connection lost")).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
    onlineManager.setOnline(true);
    await waitFor(() => expect(screen.getByRole("button", { name: "Create draft" }).hasAttribute("disabled")).toBe(false));
    expect(apiMocks.createGuardrail).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("guardrail-1"));
    expect(apiMocks.createGuardrail.mock.calls[1]).toEqual(apiMocks.createGuardrail.mock.calls[0]);
    expect(screen.queryByText("Connection lost")).toBeNull();
  });
});
