import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { toast } from "sonner";

import {
  activateModelConfiguration,
  discoverModelProvider,
  getModelConfiguration,
  revalidateModelDefinition,
  saveModelAssignments,
  type ModelAssignments,
  type ModelConfigurationView,
} from "@/lib/controller-api";

import { CapabilitiesPage, ModelsPage, ProvidersPage } from "./models";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "admin-1", role: "admin" } }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) => select({ location: { pathname: "/settings/models" } }),
}));

vi.mock("@/lib/controller-api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/controller-api")>();
  return {
    ...original,
    getModelConfiguration: vi.fn(),
    activateModelConfiguration: vi.fn(),
    validateModelConfiguration: vi.fn(),
    saveModelAssignments: vi.fn(),
    revalidateModelDefinition: vi.fn(),
    discoverModelProvider: vi.fn(),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      values?.revision ? `${key} ${values.revision}` : key,
    i18n: { exists: () => false },
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const assignments: ModelAssignments = {
  control_plane: "chat-model",
  safety_evaluator: "safety-model",
  jailbreak_evaluator: null,
  topic_policy_judge: null,
  grounding_judge: null,
  automated_reasoning: null,
};

const view: ModelConfigurationView = {
  providers: [{
    id: "provider-1",
    name: "Mock provider",
    kind: "custom-openai-compatible",
    baseUrl: "http://models.mock/v1",
    credentialHint: "mock…cret",
    credentialConfigured: true,
    status: "validated",
    validationMessage: "Connected",
    validationLatencyMs: 4,
    validatedAt: "2026-09-01T00:00:00Z",
  }],
  models: [
    {
      id: "chat-model",
      providerId: "provider-1",
      providerName: "Mock provider",
      providerKind: "custom-openai-compatible",
      name: "Authoring model",
      model: "mock/chat",
      profile: "generic-chat",
      timeoutSeconds: 20,
      maxTokens: 512,
      status: "validated",
      validationMessage: "Passed",
      validationLatencyMs: 5,
      validatedAt: "2026-09-01T00:00:00Z",
    },
    {
      id: "safety-model",
      providerId: "provider-1",
      providerName: "Mock provider",
      providerKind: "custom-openai-compatible",
      name: "Qwen Guard",
      model: "mock/qwen-guard",
      profile: "tali.qwen3guard.v1",
      timeoutSeconds: 20,
      maxTokens: 128,
      status: "validated",
      validationMessage: "Passed",
      validationLatencyMs: 6,
      validatedAt: "2026-09-01T00:00:00Z",
    },
  ],
  draft: {
    id: "revision-2",
    revision: 2,
    state: "validated",
    generation: null,
    assignments,
    validationReport: {
      valid: true,
      checkedAt: "2026-09-01T00:00:00Z",
      checks: [{
        id: "probe:safety",
        scope: "capability",
        status: "passed",
        message: "Safety model passed its mock capability probe.",
        latencyMs: 6,
      }],
      capabilities: [
        { contract: "tali.guard.secrets.exact.v1", source: "local", modelId: null },
        { contract: "tali.guard.content-safety.v1", source: "model", modelId: "safety-model" },
      ],
      policies: [
        { id: "builtin-secrets", name: "Secrets", status: "ready", missingContracts: [] },
        { id: "grounding", name: "Grounding", status: "blocked", missingContracts: ["tali.guard.contextual-grounding.v1"] },
      ],
    },
    failureReason: null,
    validatedAt: "2026-09-01T00:00:00Z",
    activatedAt: null,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  },
  active: null,
  activating: null,
  failed: null,
};

let client: QueryClient | null = null;

function renderPage(node: ReactNode = <ModelsPage />) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      {node}
    </QueryClientProvider>,
  );
}

describe("ModelsPage", () => {
  beforeEach(() => {
    vi.mocked(getModelConfiguration).mockReset().mockResolvedValue(view);
    vi.mocked(activateModelConfiguration).mockReset().mockResolvedValue({
      ...view,
      distribution: { desiredGeneration: 7, distributionStatus: "ready" },
    });
    vi.mocked(revalidateModelDefinition).mockReset();
    vi.mocked(discoverModelProvider).mockReset().mockResolvedValue({
      providerId: "provider-1",
      providerName: "Mock provider",
      models: [{ id: "mock/chat", name: "mock/chat" }, { id: "mock/qwen-guard", name: "mock/qwen-guard" }],
    });
    vi.mocked(saveModelAssignments).mockReset().mockResolvedValue(view.draft);
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  afterEach(() => {
    cleanup();
    client?.clear();
    client = null;
  });

  it("separates the Control Plane from multi-capability runtime assignments", async () => {
    renderPage(<CapabilitiesPage />);

    expect(await screen.findByText("modelSettings.controlPlane")).toBeTruthy();
    expect(screen.getByText("modelSettings.capabilityAssignments")).toBeTruthy();
    expect(screen.getAllByText("modelSettings.roles.control_plane.title").length).toBeGreaterThan(0);
    expect(screen.queryByText("modelSettings.roles.policy_authoring.title")).toBeNull();
    expect(screen.getAllByText("modelSettings.roles.safety_evaluator.title").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "modelSettings.capabilityCatalog" })).toBeTruthy();
    expect(screen.getByText("modelSettings.localCapabilities.secretsExact")).toBeTruthy();
    expect(screen.getByText("modelSettings.localCapabilities.systemPromptLeakage")).toBeTruthy();
    expect(screen.getAllByText("modelSettings.semanticPii").length).toBeGreaterThan(0);
    expect(screen.queryByText("modelSettings.validatorTitle")).toBeNull();
    expect(screen.queryByText("Safety model passed its mock capability probe.")).toBeNull();
  });

  it("activates only a validated clean revision", async () => {
    renderPage(<CapabilitiesPage />);

    const activate = await screen.findByRole("button", { name: "modelSettings.activate" });
    expect(activate.hasAttribute("disabled")).toBe(false);
    fireEvent.click(activate);

    await waitFor(() => expect(activateModelConfiguration).toHaveBeenCalledWith("revision-2"));
  });

  it("assigns multiple compatible Capabilities to one Qwen Guard Model", async () => {
    renderPage(<CapabilitiesPage />);

    const capabilityPicker = await screen.findByRole("combobox", { name: "modelSettings.capabilityColumn" });
    fireEvent.focus(capabilityPicker);
    fireEvent.click(await screen.findByRole("option", { name: /modelSettings\.roles\.jailbreak_evaluator\.title/ }));
    fireEvent.click(screen.getByRole("button", { name: "modelSettings.saveDraft" }));

    await waitFor(() => expect(saveModelAssignments).toHaveBeenCalledWith(expect.objectContaining({
      safety_evaluator: "safety-model",
      jailbreak_evaluator: "safety-model",
    })));
  });

  it("keeps the Model inventory on the Models page and Provider credentials on their own page", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "modelSettings.models" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "modelSettings.addModel" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "modelSettings.providerConnection" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "modelSettings.compatibleCapabilities" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "modelSettings.capabilityProbe" })).toBeTruthy();
    expect(screen.getAllByText("modelSettings.connected").length).toBeGreaterThan(0);
    expect(screen.getAllByText("modelSettings.probePassed").length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { name: "modelSettings.providers" })).toBeNull();
    expect(screen.queryByRole("button", { name: /modelSettings\.validateModel/ })).toBeNull();

    cleanup();
    renderPage(<ProvidersPage />);
    expect(await screen.findByRole("heading", { name: "modelSettings.providers" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "modelSettings.addProvider" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "modelSettings.models" })).toBeNull();
  });

  it("registers Models by choosing a saved Provider and discovering its catalog", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "modelSettings.addModel" }));
    const dialog = screen.getByRole("dialog", { name: "modelSettings.addModel" });
    fireEvent.click(within(dialog).getByRole("button", { name: "modelSettings.provider" }));
    fireEvent.click(await screen.findByRole("option", { name: /Mock provider/ }));

    await waitFor(() => expect(discoverModelProvider).toHaveBeenCalledWith("provider-1"));
    expect(await within(dialog).findByRole("combobox", { name: "modelSettings.modelId" })).toBeTruthy();
  });

  it("surfaces a failed capability Validate as an error with the provider reason", async () => {
    vi.mocked(revalidateModelDefinition).mockResolvedValue({
      ...view.models[1]!,
      status: "failed",
      validationMessage: "Supplier endpoint returned HTTP 410.",
    });
    renderPage(<CapabilitiesPage />);

    const capabilities = await screen.findByRole("region", { name: "modelSettings.capabilityAssignments" });
    fireEvent.click(within(capabilities).getByRole("button", { name: "modelSettings.validateModel Qwen Guard" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Supplier endpoint returned HTTP 410."));
    expect(toast.success).not.toHaveBeenCalled();
  });
});
