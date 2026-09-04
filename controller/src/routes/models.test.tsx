import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { toast } from "sonner";

import {
  activateModelConfiguration,
  configureModelDefinition,
  deleteModelDefinition,
  deleteModelProvider,
  discoverModelProvider,
  getModelConfiguration,
  revalidateModelDefinition,
  testModelConnection,
  saveModelAssignments,
  type ModelAssignments,
  type ModelConfigurationView,
} from "@/lib/controller-api";

import { CapabilitiesPage, ModelsPage, ProvidersPage } from "./models";
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

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
    configureModelDefinition: vi.fn(),
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
      connectionStatus: "validated",
      connectionMessage: "Actual call succeeded",
      connectionLatencyMs: 23,
      connectionCheckedAt: "2026-09-03T00:00:00Z",
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
      connectionStatus: "failed",
      connectionMessage: "Model call returned HTTP 404: model not found.",
      connectionLatencyMs: 17,
      connectionCheckedAt: "2026-09-03T00:00:00Z",
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
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(getModelConfiguration).mockReset().mockResolvedValue(view);
    vi.mocked(activateModelConfiguration).mockReset().mockResolvedValue({
      ...view,
      distribution: { desiredGeneration: 7, distributionStatus: "ready" },
    });
    vi.mocked(revalidateModelDefinition).mockReset();
    vi.mocked(testModelConnection).mockReset();
    vi.mocked(configureModelDefinition).mockReset();
    vi.mocked(deleteModelDefinition).mockReset().mockResolvedValue(undefined);
    vi.mocked(deleteModelProvider).mockReset().mockResolvedValue(undefined);
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
    fireEvent.click(within(screen.getByRole("dialog", { name: "modelSettings.activateConfirmationTitle" })).getByRole("button", { name: "modelSettings.activateConfirmationAction" }));

    await waitFor(() => expect(activateModelConfiguration).toHaveBeenCalledWith("revision-2"));
  });

  it("assigns multiple compatible Capabilities to one Qwen Guard Model", async () => {
    renderPage(<CapabilitiesPage />);

    const capabilityPicker = await screen.findByRole("combobox", { name: "modelSettings.capabilityColumn" });
    fireEvent.focus(capabilityPicker);
    fireEvent.click(await screen.findByRole("option", { name: /modelSettings\.roles\.jailbreak_evaluator\.title/ }));
    fireEvent.click(screen.getByRole("button", { name: "modelSettings.saveDraft" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "modelSettings.saveConfirmationTitle" })).getByRole("button", { name: "modelSettings.saveConfirmationAction" }));

    await waitFor(() => expect(saveModelAssignments).toHaveBeenCalledWith(expect.objectContaining({
      safety_evaluator: "safety-model",
      jailbreak_evaluator: "safety-model",
    })));
  });

  it("switches the existing jailbreak capability between a chat judge and the dedicated classifier", async () => {
    const chatJudge = { ...view.models[1]!, id: "chat-judge", name: "Chat judge", profile: "tali.openai-compatible-jailbreak.v1" as const };
    const detector = { ...view.models[1]!, id: "detector", name: "JailbreakDetect", profile: "tali.nemoguard-jailbreak-detect.v1" as const };
    vi.mocked(getModelConfiguration).mockResolvedValue({ ...view, models: [view.models[0]!, chatJudge, detector], draft: {
      ...view.draft, assignments: { ...assignments, safety_evaluator: null, jailbreak_evaluator: "chat-judge" },
    } });
    renderPage(<CapabilitiesPage />);
    const region = await screen.findByRole("region", { name: "modelSettings.capabilityAssignments" });
    fireEvent.keyDown(within(region).getByRole("combobox", { name: "modelSettings.modelColumn" }), { key: "ArrowDown" });
    expect(await screen.findByRole("option", { name: /Chat judge · Mock provider/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /JailbreakDetect · Mock provider/ }));
    fireEvent.click(screen.getByRole("button", { name: "modelSettings.saveDraft" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "modelSettings.saveConfirmationTitle" })).getByRole("button", { name: "modelSettings.saveConfirmationAction" }));
    await waitFor(() => expect(saveModelAssignments).toHaveBeenCalledWith({
      ...assignments, safety_evaluator: null, jailbreak_evaluator: "detector",
    }));
    expect(revalidateModelDefinition).not.toHaveBeenCalled();
    expect(testModelConnection).not.toHaveBeenCalled();
  });

  it("configures an unused model alias in Capabilities without validating or activating it", async () => {
    const alias = { ...view.models[0]!, id: "alias-model", name: "Guard alias", model: "my-guard", status: "pending" as const, protocolEditable: true };
    vi.mocked(getModelConfiguration).mockResolvedValue({ ...view, models: [alias] });
    vi.mocked(configureModelDefinition).mockResolvedValue({ ...alias, profile: "tali.qwen3guard.v1" });
    renderPage(<CapabilitiesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "providerRegistration.configureModel" }));
    const dialog = screen.getByRole("dialog", { name: "providerRegistration.configureModel" });
    fireEvent.keyDown(within(dialog).getByRole("combobox", { name: "modelSettings.model" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Guard alias · Mock provider" }));
    fireEvent.keyDown(within(dialog).getByRole("combobox", { name: "modelSettings.profile" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "modelSettings.profiles.tali.qwen3guard.v1" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "common.save" }));
    await waitFor(() => expect(configureModelDefinition).toHaveBeenCalledWith("alias-model", { profile: "tali.qwen3guard.v1", timeoutSeconds: 20, maxTokens: 512 }));
    expect(revalidateModelDefinition).not.toHaveBeenCalled();
    expect(activateModelConfiguration).not.toHaveBeenCalled();
  });

  it("explains why a referenced model's protocol is read-only", async () => {
    vi.mocked(getModelConfiguration).mockResolvedValue({ ...view, models: [{ ...view.models[0]!, protocolEditable: false }] });
    renderPage(<CapabilitiesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "providerRegistration.configureModel" }));
    const dialog = screen.getByRole("dialog", { name: "providerRegistration.configureModel" });
    fireEvent.keyDown(within(dialog).getByRole("combobox", { name: "modelSettings.model" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Authoring model · Mock provider" }));
    expect(within(dialog).getByText("providerRegistration.protocolInUse")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "common.save" }).hasAttribute("disabled")).toBe(true);
    expect(configureModelDefinition).not.toHaveBeenCalled();
  });

  it("keeps the Model inventory on the Models page and Provider credentials on their own page", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "modelSettings.models" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "modelSettings.addModel" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "modelSettings.providerConnection" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "modelSettings.compatibleCapabilities" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "modelSettings.capabilityProbe" })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "modelSettings.modelCall" })).toBeTruthy();
    expect(screen.getAllByText("modelSettings.connected").length).toBeGreaterThan(0);
    expect(screen.getByText("modelSettings.callPassed")).toBeTruthy();
    expect(screen.getByText("modelSettings.callFailed")).toBeTruthy();
    expect(screen.queryByText("Model call returned HTTP 404: model not found.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "modelSettings.viewCallError · Qwen Guard" }));
    expect(await screen.findByRole("dialog", { name: "modelSettings.callErrorTitle" })).toBeTruthy();
    expect(screen.getByText("Model call returned HTTP 404: model not found.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "common.close" }));
    expect(screen.queryByText("modelSettings.probePassed")).toBeNull();
    expect(screen.queryByRole("heading", { name: "modelSettings.providers" })).toBeNull();
    expect(screen.queryByRole("button", { name: /modelSettings\.validateModel/ })).toBeNull();

    cleanup();
    renderPage(<ProvidersPage />);
    expect(await screen.findByRole("heading", { name: "modelSettings.providers" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "modelSettings.addProvider" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "modelSettings.models" })).toBeNull();
  });

  it("blocks removal in the shared right drawer and highlights Topic control usage", async () => {
    vi.mocked(getModelConfiguration).mockResolvedValue({
      ...view,
      draft: { ...view.draft, assignments: { ...assignments, topic_policy_judge: "safety-model" } },
    });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "common.remove Qwen Guard" }));
    const drawer = screen.getByRole("dialog", { name: "modelSettings.removeResourceTitle" });
    expect(within(drawer).getByText("modelSettings.topicControlRemovalTitle")).toBeTruthy();
    expect(within(drawer).getByText("modelSettings.roles.topic_policy_judge.title")).toBeTruthy();
    expect(deleteModelDefinition).not.toHaveBeenCalled();

    expect(within(drawer).getByRole("button", { name: "common.remove" })).toHaveProperty("disabled", true);
    expect(deleteModelDefinition).not.toHaveBeenCalled();
  });

  it("removes an unassigned Model only after confirming in the right drawer", async () => {
    const unused = { ...view.models[1]!, id: "unused-model", name: "Unused model", model: "mock/unused" };
    vi.mocked(getModelConfiguration).mockResolvedValue({ ...view, models: [...view.models, unused] });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "common.remove Unused model" }));
    const drawer = screen.getByRole("dialog", { name: "modelSettings.removeResourceTitle" });
    fireEvent.click(within(drawer).getByRole("button", { name: "common.remove" }));
    await waitFor(() => expect(deleteModelDefinition).toHaveBeenCalledWith("unused-model"));
  });

  it("registers Models by choosing a saved Provider and discovering its catalog", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "modelSettings.addModel" }));
    const dialog = screen.getByRole("dialog", { name: "providerRegistration.registerModels" });
    expect(within(dialog).getByRole("combobox", { name: "providerRegistration.savedCredentials" })).toBeTruthy();
    expect(discoverModelProvider).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "providerRegistration.discoverModels" }));

    await waitFor(() => expect(discoverModelProvider).toHaveBeenCalledWith("provider-1"));
    expect(await within(dialog).findByRole("heading", { name: "providerRegistration.discoveredModels" })).toBeTruthy();
  });

  it("tests a model call without touching capability validation or assignments", async () => {
    let finish!: (value: ModelConfigurationView["models"][number]) => void;
    vi.mocked(testModelConnection).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "modelSettings.testCall Qwen Guard" }));
    expect(await screen.findByText("modelSettings.testingCall")).toBeTruthy();
    expect(screen.getByRole("button", { name: "modelSettings.testCall Qwen Guard" })).toHaveProperty("disabled", true);
    const updated = { ...view.models[1]!, connectionStatus: "validated" as const };
    vi.mocked(getModelConfiguration).mockResolvedValue({ ...view, models: [view.models[0]!, updated] });
    finish(updated);
    await waitFor(() => expect(screen.queryByText("modelSettings.testingCall")).toBeNull());
    expect(testModelConnection).toHaveBeenCalledWith("safety-model");
    expect(revalidateModelDefinition).not.toHaveBeenCalled();
    expect(saveModelAssignments).not.toHaveBeenCalled();
    expect(activateModelConfiguration).not.toHaveBeenCalled();
    expect(screen.queryByText("modelSettings.callFailed")).toBeNull();
  });

  it("does not reinterpret old capability results as model-call health", async () => {
    vi.mocked(getModelConfiguration).mockResolvedValue({ ...view, models: view.models.map((model) => ({ ...model, connectionStatus: "pending", connectionCheckedAt: null })) });
    renderPage();
    expect(await screen.findAllByText("modelSettings.notChecked")).toHaveLength(2);
    expect(screen.queryByText("modelSettings.callPassed")).toBeNull();
  });

  it("shows a failed actual model call as an error despite a passing capability result", async () => {
    vi.mocked(testModelConnection).mockResolvedValue(view.models[1]!);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "modelSettings.testCall Qwen Guard" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(view.models[1]!.connectionMessage));
    expect(toast.success).not.toHaveBeenCalled();
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
