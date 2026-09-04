import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { toast } from "sonner";

import {
  activateModelConfiguration,
  deleteModelDefinition,
  deleteModelProvider,
  discoverModelProvider,
  getModelConfiguration,
  revalidateModelDefinition,
  saveModelAssignments,
  testModelConnection,
  validateModelConfiguration,
  type ModelAssignments,
  type ModelConfigurationView,
} from "@/lib/controller-api";

import { GuardrailCatalogPage, ModelsPage, ProvidersPage } from "./models";

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "admin-1", role: "admin" } }) }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) => select({ location: { pathname: "/settings/guardrail-catalog" } }),
}));
vi.mock("@/lib/controller-api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/controller-api")>();
  return {
    ...original,
    getModelConfiguration: vi.fn(),
    activateModelConfiguration: vi.fn(),
    deleteModelDefinition: vi.fn(),
    deleteModelProvider: vi.fn(),
    validateModelConfiguration: vi.fn(),
    saveModelAssignments: vi.fn(),
    revalidateModelDefinition: vi.fn(),
    testModelConnection: vi.fn(),
    discoverModelProvider: vi.fn(),
  };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => values?.revision ? `${key} ${values.revision}` : key,
    i18n: { exists: () => false },
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const assignments: ModelAssignments = {
  controlPlane: "chat-model",
  detectors: {
    content_safety: "safety-model",
    jailbreak_detection: null,
    topic_control: null,
    pii_detection: null,
    contextual_grounding: null,
    automated_reasoning: null,
  },
};

const provider = {
  id: "provider-1",
  name: "Mock provider",
  kind: "custom-openai-compatible" as const,
  baseUrl: "http://models.mock/v1",
  credentialHint: "mock…cret",
  credentialConfigured: true,
  status: "validated" as const,
  validationMessage: "Connected",
  validationLatencyMs: 4,
  validatedAt: "2026-09-01T00:00:00Z",
};
const chatModel = {
  id: "chat-model", providerId: provider.id, providerName: provider.name, providerKind: provider.kind,
  name: "Authoring model", model: "mock/chat", profile: "generic-chat" as const, timeoutSeconds: 20, maxTokens: 512,
  connectionStatus: "validated" as const, connectionMessage: "Actual call succeeded", connectionLatencyMs: 23, connectionCheckedAt: "2026-09-03T00:00:00Z",
  status: "validated" as const, validationMessage: "Passed", validationLatencyMs: 5, validatedAt: "2026-09-01T00:00:00Z",
};
const safetyModel = {
  ...chatModel,
  id: "safety-model", name: "Qwen Guard", model: "mock/qwen-guard", profile: "tali.qwen3guard.v1" as const, maxTokens: 128,
  connectionStatus: "failed" as const, connectionMessage: "Model call returned HTTP 404: model not found.", connectionLatencyMs: 17,
};
const now = "2026-09-01T00:00:00Z";
const view: ModelConfigurationView = {
  providers: [provider], models: [chatModel, safetyModel],
  draft: {
    id: "revision-2", revision: 2, state: "validated", generation: null, assignments,
    validationReport: {
      valid: true, checkedAt: now,
      checks: [{ id: "probe:content_safety:safety-model", scope: "detector", status: "passed", message: "Content safety detector passed.", latencyMs: 6 }],
      contractCoverage: [
        { contract: "tali.guard.secrets.exact.v1", source: "local", modelId: null, detectorType: null },
        { contract: "tali.guard.content-safety.v1", source: "model", modelId: "safety-model", detectorType: "content_safety" },
      ],
      policies: [],
    },
    failureReason: null, validatedAt: now, activatedAt: null, createdAt: now, updatedAt: now,
  },
  active: null, activating: null, failed: null,
};

let client: QueryClient | null = null;
function renderPage(node: ReactNode) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe("Models and Guardrail Catalog", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(getModelConfiguration).mockReset().mockResolvedValue(view);
    vi.mocked(activateModelConfiguration).mockReset().mockResolvedValue({ ...view, distribution: { desiredGeneration: 7, distributionStatus: "ready" } });
    vi.mocked(validateModelConfiguration).mockReset().mockResolvedValue(view.draft);
    vi.mocked(revalidateModelDefinition).mockReset().mockResolvedValue(safetyModel);
    vi.mocked(testModelConnection).mockReset().mockResolvedValue(safetyModel);
    vi.mocked(deleteModelDefinition).mockReset().mockResolvedValue(undefined);
    vi.mocked(deleteModelProvider).mockReset().mockResolvedValue(undefined);
    vi.mocked(saveModelAssignments).mockReset().mockResolvedValue(view.draft);
    vi.mocked(discoverModelProvider).mockReset().mockResolvedValue({ providerId: provider.id, providerName: provider.name, models: [] });
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  afterEach(() => { cleanup(); client?.clear(); client = null; });

  it("uses one dense assignment table for all nine NeMo business categories", async () => {
    renderPage(<GuardrailCatalogPage />);
    expect(await screen.findByRole("heading", { name: "modelSettings.catalogConfiguration" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "modelSettings.categoryColumn" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "modelSettings.detectorColumn" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "modelSettings.modelColumn" })).toBeTruthy();
    for (const category of ["content_safety", "jailbreak_protection", "topic_control", "pii_detection", "agentic_security", "tool_calling", "hallucinations_fact_checking", "llm_self_check", "third_party_apis"]) {
      expect(screen.getAllByRole("row", { name: `modelSettings.categories.${category}.title` }).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByText("modelSettings.detectors.content_safety.title").length).toBeGreaterThan(0);
    expect(screen.getAllByText("modelSettings.detectors.jailbreak_detection.title").length).toBeGreaterThan(0);
    expect(screen.getAllByText("modelSettings.categoryStates.service.title").length).toBeGreaterThan(0);
  });

  it("binds the same compatible Model independently to another detector and confirms the draft update in the right drawer", async () => {
    renderPage(<GuardrailCatalogPage />);
    const jailbreak = await screen.findByRole("row", { name: "modelSettings.categories.jailbreak_protection.title" });
    fireEvent.keyDown(within(jailbreak).getByRole("combobox", { name: "modelSettings.modelColumn" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: /Qwen Guard · Mock provider/ }));
    fireEvent.click(screen.getByRole("button", { name: "modelSettings.saveDraft" }));
    const drawer = screen.getByRole("dialog", { name: "modelSettings.saveConfirmationTitle" });
    fireEvent.click(within(drawer).getByRole("button", { name: "modelSettings.saveConfirmationAction" }));
    await waitFor(() => expect(saveModelAssignments).toHaveBeenCalledWith({
      ...assignments,
      detectors: { ...assignments.detectors, jailbreak_detection: "safety-model" },
    }));
  });

  it("activates only after confirming the validated clean catalog revision", async () => {
    renderPage(<GuardrailCatalogPage />);
    fireEvent.click(await screen.findByRole("button", { name: "modelSettings.activate" }));
    const drawer = screen.getByRole("dialog", { name: "modelSettings.activateConfirmationTitle" });
    fireEvent.click(within(drawer).getByRole("button", { name: "modelSettings.activateConfirmationAction" }));
    await waitFor(() => expect(activateModelConfiguration).toHaveBeenCalledWith("revision-2"));
  });

  it("blocks removal in the shared right drawer and clearly identifies Topic Control use", async () => {
    vi.mocked(getModelConfiguration).mockResolvedValue({
      ...view,
      draft: { ...view.draft, assignments: { ...assignments, detectors: { ...assignments.detectors, topic_control: "safety-model" } } },
    });
    renderPage(<ModelsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "common.remove Qwen Guard" }));
    const drawer = screen.getByRole("dialog", { name: "modelSettings.removeResourceTitle" });
    expect(within(drawer).getByText("modelSettings.topicControlRemovalTitle")).toBeTruthy();
    expect(within(drawer).getByText("modelSettings.detectors.topic_control.title")).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: "common.remove" })).toHaveProperty("disabled", true);
  });

  it("keeps Provider credentials and Model inventory on separate pages", async () => {
    renderPage(<ModelsPage />);
    expect(await screen.findByRole("heading", { name: "modelSettings.models" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "modelSettings.addModel" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "modelSettings.modelCall" })).toBeTruthy();
    cleanup();
    renderPage(<ProvidersPage />);
    expect(await screen.findByRole("heading", { name: "modelSettings.providers" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "modelSettings.addProvider" })).toBeTruthy();
  });

  it("removes an unassigned Model only after drawer confirmation", async () => {
    const unused = { ...safetyModel, id: "unused-model", name: "Unused model", model: "mock/unused" };
    vi.mocked(getModelConfiguration).mockResolvedValue({ ...view, models: [...view.models, unused] });
    renderPage(<ModelsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "common.remove Unused model" }));
    const drawer = screen.getByRole("dialog", { name: "modelSettings.removeResourceTitle" });
    fireEvent.click(within(drawer).getByRole("button", { name: "common.remove" }));
    await waitFor(() => expect(deleteModelDefinition).toHaveBeenCalledWith("unused-model"));
  });

  it("tests Model callability without changing catalog assignments", async () => {
    renderPage(<ModelsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "modelSettings.testCall Qwen Guard" }));
    await waitFor(() => expect(testModelConnection).toHaveBeenCalledWith("safety-model"));
    expect(saveModelAssignments).not.toHaveBeenCalled();
    expect(activateModelConfiguration).not.toHaveBeenCalled();
  });
});
