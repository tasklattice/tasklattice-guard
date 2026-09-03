import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GuardrailPolicyBinding, Policy } from "@/lib/api";

import { CreateGuardrailWizard } from "./create-guardrail-wizard";

const apiMocks = vi.hoisted(() => ({
  analyzeIntent: vi.fn(),
  createGuardrail: vi.fn(),
  getIntentStatus: vi.fn(),
  getPolicies: vi.fn(),
  preview: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const labels: Record<string, string> = {
        "common.cancel": "Cancel",
        "common.next": "Next",
        "common.previous": "Previous",
        "guardrailWizard.title": "Create Guardrail",
        "guardrailWizard.steps.details": "Details",
        "guardrailWizard.steps.detailsDescription": "Name and description",
        "guardrailWizard.steps.policies": "Policies",
        "guardrailWizard.steps.policiesDescription": "Protections and actions",
        "guardrailWizard.steps.review": "Review",
        "guardrailWizard.steps.reviewDescription": "Confirm draft",
        "guardrailWizard.detailsTitle": "Guardrail details",
        "guardrailWizard.name": "Name",
        "guardrailWizard.namePlaceholder": "Customer data protection",
        "guardrailWizard.descriptionLabel": "Description (optional)",
        "guardrailWizard.descriptionPlaceholder": "Optional description",
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
        "guardrailWizard.boundarySources.intent": "Generated from intent",
        "guardrailWizard.outputDelivery": "Output delivery",
        "guardrailWizard.outputDeliveryOptions.window_buffered": "Window buffered",
        "guardrailWizard.nextBlocked.name": "Enter a Guardrail name to continue.",
        "guardrailWizard.nextBlocked.selectPolicy": "Select at least one published Policy to continue.",
        "guardrailWizard.nextBlocked.requiredFields": "Complete required fields for {{name}}: {{fields}}.",
        "guardrailWizard.reviewTitle": "Review Guardrail",
        "guardrailWizard.reviewDraftTitle": "No live traffic changes",
        "guardrailWizard.createDraft": "Create draft",
        "guardrailWizard.creatingDraft": "Creating draft…",
      };
      return Object.entries(values ?? {}).reduce(
        (label, [name, value]) => label.replace(`{{${name}}}`, String(value)),
        labels[key] ?? key,
      );
    },
    i18n: { language: "en" },
  }),
}));

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "admin", preferred_language: "en" } }) }));

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...original,
    analyzeGuardrailIntent: (...args: unknown[]) => apiMocks.analyzeIntent(...args),
    createGuardrail: (...args: unknown[]) => apiMocks.createGuardrail(...args),
    getIntentAnalysisStatus: (...args: unknown[]) => apiMocks.getIntentStatus(...args),
    getPolicies: (...args: unknown[]) => apiMocks.getPolicies(...args),
    previewGuardrailCandidate: (...args: unknown[]) => apiMocks.preview(...args),
  };
});

vi.mock("@/components/entity-sheet", () => ({
  EntitySheet: ({ open, title, description, children, footer }: { open: boolean; title: React.ReactNode; description: React.ReactNode; children: React.ReactNode; footer: React.ReactNode }) => (
    open ? <div data-testid="entity-sheet"><h1>{title}</h1><p>{description}</p>{children}<footer>{footer}</footer></div> : null
  ),
}));

vi.mock("@/components/creation-flow", () => ({
  CreationFlow: ({ children, steps }: { children: React.ReactNode; steps: Array<{ label: string }> }) => (
    <div><nav>{steps.map((step) => <span key={step.label}>{step.label}</span>)}</nav>{children}</div>
  ),
}));

vi.mock("@/components/policy-binding-editor", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/policy-binding-editor")>();
  return {
    ...original,
    PolicyBindingEditor: ({ onChange }: { onChange: (value: GuardrailPolicyBinding[]) => void }) => (
      <div>
        <button type="button" onClick={() => onChange([binding])}>Select Topic Policy</button>
        <button type="button" onClick={() => onChange([requiredBinding])}>Select Aviation Policy</button>
        <button type="button" onClick={() => onChange([configuredRequiredBinding])}>Complete Aviation configuration</button>
      </div>
    ),
  };
});

const policy = {
  implementation: "rules",
  id: "topic-filtering",
  name: "Topic Filtering",
  description: "Topic control",
  source: "built_in",
  version: "1",
  tags: [{ id: "capability:topic-safety", namespace: "capability", value: "topic-safety", label: "Topic safety", source: "declared" }],
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
  id: "aviation-operations-security",
  name: "Aviation Operations Security",
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
  return {
    onCreated,
    ...render(
      <QueryClientProvider client={client}>
        <CreateGuardrailWizard open onOpenChange={vi.fn()} onCreated={onCreated} />
      </QueryClientProvider>,
    ),
  };
}

describe("Create Guardrail wizard", () => {
  beforeEach(() => {
    apiMocks.analyzeIntent.mockReset().mockResolvedValue({
      summary: "Customer support only.",
      structured_purpose: { audience: "Support agents", tasks: "Answer order questions", protect: "Customer identifiers", out_of_scope: "Medical advice" },
      allowed_topics: ["Orders", "Returns"],
      restricted_topics: ["Medical advice"],
      review_notes: [],
    });
    apiMocks.getIntentStatus.mockReset().mockResolvedValue({ available: true, provider: "test", model: "test", document_analysis_available: true });
    apiMocks.getPolicies.mockReset().mockResolvedValue({ items: [policy, requiredPolicy], count: 2 });
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

  afterEach(cleanup);

  it("uses three steps and only requires a name before Policies", async () => {
    renderWizard();
    expect(screen.getByText("Details")).toBeTruthy();
    expect(screen.getByText("Policies")).toBeTruthy();
    expect(screen.getByText("Review")).toBeTruthy();
    expect(screen.queryByText("Runtime")).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("Customer data protection"), { target: { value: "Support Guardrail" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByText("Start with existing Policies or generate a proposal")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Generate from intent/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Generate from documents/ })).toBeTruthy();
  });

  it("keeps intent generation inside Policies and applies only after review", async () => {
    renderWizard();
    fireEvent.change(screen.getByPlaceholderText("Customer data protection"), { target: { value: "Support Guardrail" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Start with existing Policies or generate a proposal");
    fireEvent.click(await screen.findByRole("button", { name: "Select Topic Policy" }));

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
    expect(screen.getByText("Output delivery")).toBeTruthy();
  });

  it("saves an editable draft with an optional description and hidden balanced runtime default", async () => {
    const { onCreated } = renderWizard();
    fireEvent.change(screen.getByPlaceholderText("Customer data protection"), { target: { value: "Support Guardrail" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Start with existing Policies or generate a proposal");
    fireEvent.click(await screen.findByRole("button", { name: "Select Topic Policy" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(apiMocks.preview).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Create draft" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));

    await waitFor(() => expect(apiMocks.createGuardrail).toHaveBeenCalledWith(expect.objectContaining({
      name: "Support Guardrail",
      purpose: "",
      safety_level: "balanced",
      policy_bindings: [binding],
    })));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("guardrail-1"));
  });

  it("keeps structured purpose and custom phrase rules in preview and saved drafts", async () => {
    renderWizard();
    fireEvent.change(screen.getByPlaceholderText("Customer data protection"), { target: { value: "Support Guardrail" } });
    fireEvent.change(screen.getByPlaceholderText("Optional description"), { target: { value: "Support account operations" } });
    fireEvent.click(screen.getByText("guardrailWizard.purposeStructuredTitle"));
    for (const [field, value] of Object.entries({ Audience: "Support agents", Tasks: "Summarize requests", Protect: "Customer identifiers", OutOfScope: "Medical advice" })) {
      fireEvent.change(screen.getByPlaceholderText(`guardrailWizard.purpose${field}Placeholder`), { target: { value } });
    }
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Select Topic Policy" }));
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    fireEvent.change(screen.getByPlaceholderText("mama"), { target: { value: "internal-name" } });
    fireEvent.change(screen.getByPlaceholderText("niulai"), { target: { value: "[PRIVATE]" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    const expected = expect.objectContaining({
      purpose: "Support account operations",
      purpose_details: { audience: "Support agents", tasks: "Summarize requests", protect: "Customer identifiers", out_of_scope: "Medical advice" },
      custom_content_rules: [{ id: "custom-rule-1", phases: ["input"], detector: "keyword", keywords: ["internal-name"], action: "redact", replacement: "[PRIVATE]" }],
      policy_bindings: [binding],
    });
    await waitFor(() => expect(apiMocks.preview).toHaveBeenCalledWith(expected));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create draft" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(apiMocks.createGuardrail).toHaveBeenCalledWith(expected));
  });

  it("does not overwrite structured purpose until the generated proposal is explicitly applied", async () => {
    renderWizard();
    fireEvent.change(screen.getByPlaceholderText("Customer data protection"), { target: { value: "Support Guardrail" } });
    fireEvent.click(screen.getByText("guardrailWizard.purposeStructuredTitle"));
    fireEvent.change(screen.getByPlaceholderText("guardrailWizard.purposeAudiencePlaceholder"), { target: { value: "Manual audience" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Generate from intent/ }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(await screen.findByRole("button", { name: /Generate from intent/ }));
    fireEvent.change(screen.getByPlaceholderText("Describe intent"), { target: { value: "Support agents may answer order questions but not medical advice." } });
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    await screen.findByText("Topic Control proposal");
    fireEvent.click(screen.getByRole("button", { name: "Back to Policies" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect((screen.getByPlaceholderText("guardrailWizard.purposeAudiencePlaceholder") as HTMLInputElement).value).toBe("Manual audience");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: /Generate from intent/ }));
    fireEvent.click(screen.getByRole("button", { name: "Apply proposal" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect((screen.getByPlaceholderText("guardrailWizard.purposeAudiencePlaceholder") as HTMLInputElement).value).toBe("Support agents");
  });

  it("explains hidden required Policy configuration and enables Next after it is completed", async () => {
    renderWizard();
    fireEvent.change(screen.getByPlaceholderText("Customer data protection"), { target: { value: "Aviation Guardrail" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Start with existing Policies or generate a proposal");

    fireEvent.click(await screen.findByRole("button", { name: "Select Aviation Policy" }));

    const next = screen.getByRole("button", { name: "Next" });
    expect(next.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Complete required fields for Aviation Operations Security: Your Airline / Brand Name, Competitors.")).toBeTruthy();
    expect(next.getAttribute("aria-describedby")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Complete Aviation configuration" }));

    expect(next.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText("Complete required fields for Aviation Operations Security: Your Airline / Brand Name, Competitors.")).toBeNull();
    fireEvent.click(next);
    expect(await screen.findByText("Review Guardrail")).toBeTruthy();
  });
});
