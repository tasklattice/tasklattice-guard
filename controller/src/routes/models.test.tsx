import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { toast } from "@/components/ui/notifications";

import {
  applyModelConfiguration as activateModelConfiguration,
  deleteModelDefinition,
  deleteModelProvider,
  discoverModelProvider,
  getModelConfiguration,
  revalidateModelProvider,
  saveModelAssignment,
  testModelConnection,
  updateModelProviderCredential,
  validateModelAssignment,
  validateSavedModelAssignment,
  type ModelAssignments,
  type ModelConfigurationView,
} from "@/lib/controller-api";

import { GuardrailCatalogPage, ModelsPage, ProvidersPage } from "./models";

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
const identity = vi.hoisted(() => ({ role: "admin", project_id: "projectA" }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "identity-1", role: identity.role, project_id: identity.project_id } }) }));
vi.mock("@tanstack/react-router", () => ({
  useSearch: () => ({}),
  useNavigate: () => vi.fn(),
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) => select({ location: { pathname: "/settings/protection-capabilities" } }),
}));
vi.mock("@/lib/controller-api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/controller-api")>();
  return {
    ...original,
    getModelConfiguration: vi.fn(),
    applyModelConfiguration: vi.fn(),
    deleteModelDefinition: vi.fn(),
    deleteModelProvider: vi.fn(),
    validateModelAssignment: vi.fn(),
    validateSavedModelAssignment: vi.fn(),
    saveModelAssignment: vi.fn(),
    revalidateModelProvider: vi.fn(),
    testModelConnection: vi.fn(),
    updateModelProviderCredential: vi.fn(),
    discoverModelProvider: vi.fn(),
  };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => values?.revision ? `${key} ${values.revision}` : values?.message ? `${key} ${values.message}` : key,
    i18n: { exists: () => false },
  }),
}));
vi.mock("@/components/ui/notifications", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const assignments: ModelAssignments = {
  controlPlane: "chat-model",
  bindings: {
    "classifier_review.input": null,
    "classifier_review.output": null,
    "content_safety.input": "safety-model",
    "content_safety.output": "safety-model",
    "jailbreak.input": null,
    "topic_control.input": null,
    "pii_semantic.input": null,
    "pii_semantic.output": null,
    "contextual_grounding.output": null,
    "automated_reasoning.output": null,
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
    id: "revision-2", reviewToken: "review-token", revision: 2, state: "validated", generation: null, assignments,
    validationReport: {
      valid: true, checkedAt: now,
      checks: [
        { id: "probe:content_safety.input:safety-model", scope: "capability", status: "passed", evidenceKind: "nemo-rail-v1", message: "Input Rail samples passed.", latencyMs: 6 },
        { id: "probe:content_safety.output:safety-model", scope: "capability", status: "passed", evidenceKind: "nemo-rail-v1", message: "Output Rail samples passed.", latencyMs: 6 },
      ],
      contractCoverage: [
        { contract: "tali.guard.secrets.exact.v1", source: "local", modelId: null, bindingId: null, railType: "input" },
        { contract: "tali.guard.content-safety.v1", source: "model", modelId: "safety-model", bindingId: "content_safety.input", railType: "input" },
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

// Use the existing labels for rows/triggers and query only the opened menu.
// Repeated document-wide role searches are expensive in the Carbon catalog.
async function actionItem(trigger: HTMLElement, name: string) {
  await waitFor(() => expect(trigger).toHaveProperty("disabled", false));
  if (trigger.getAttribute("aria-expanded") !== "true") {
    const openMenu = screen.queryByRole("menu");
    if (openMenu) fireEvent.keyDown(openMenu, { key: "Escape" });
    fireEvent.click(trigger);
  }
  const menu = await screen.findByRole("menu");
  return within(menu).findByRole("menuitem", { name });
}

async function catalogAction(row: HTMLElement, name: string) {
  return within(row).findByRole("button", { name });
}

async function modelAction(modelName: string, name: string) {
  return actionItem(await screen.findByLabelText(`modelSettings.actions ${modelName}`, { selector: "button" }), name);
}

// These multi-step Carbon integration workflows reached 11.6s on a slow CI
// worker. Keep a bounded integration budget for interactions and save/reload.
describe("Models and Protection Capabilities", { timeout: 30_000 }, () => {
  beforeEach(() => {
    identity.role = "admin"; identity.project_id = "projectA";
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(getModelConfiguration).mockReset().mockResolvedValue(view);
    vi.mocked(activateModelConfiguration).mockReset().mockResolvedValue({ ...view, distribution: { desiredGeneration: 7, distributionStatus: "ready" } });
    vi.mocked(validateModelAssignment).mockReset().mockResolvedValue({ ...view.draft!, validationId: "candidate-validation" });
    vi.mocked(validateSavedModelAssignment).mockReset().mockResolvedValue(view.draft!);
    vi.mocked(revalidateModelProvider).mockReset().mockResolvedValue(provider);
    vi.mocked(testModelConnection).mockReset().mockResolvedValue(safetyModel);
    vi.mocked(updateModelProviderCredential).mockReset().mockResolvedValue(provider);
    vi.mocked(deleteModelDefinition).mockReset().mockResolvedValue(undefined);
    vi.mocked(deleteModelProvider).mockReset().mockResolvedValue(undefined);
    vi.mocked(saveModelAssignment).mockReset().mockResolvedValue({ ...view.draft!, validationId: "candidate-validation" });
    vi.mocked(discoverModelProvider).mockReset().mockResolvedValue({ providerId: provider.id, providerName: provider.name, models: [] });
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  afterEach(() => { cleanup(); client?.clear(); client = null; });

  it("lets platform administrators manage global models without mutating project models", async () => {
    vi.mocked(getModelConfiguration).mockResolvedValue({ ...view, models: [
      { ...chatModel, projectId: null },
      { ...safetyModel, name: "Project A model", projectId: "projectA" },
    ] });
    renderPage(<ModelsPage />);
    expect(await modelAction("Authoring model", "common.remove")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("button", { name: "modelSettings.actions Project A model" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "providerRegistration.configureModel" }));
    fireEvent.click(screen.getByRole("combobox", { name: "modelSettings.model" }));
    expect(await screen.findByRole("option", { name: /Authoring model/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Project A model/ })).toBeNull();
  });

  it("offers only platform models in global Protection Capabilities bindings", async () => {
    vi.mocked(getModelConfiguration).mockResolvedValue({ ...view, models: [
      ...view.models,
      { ...safetyModel, id: "project-model", name: "Project A private model", projectId: "projectA" },
    ] });
    renderPage(<GuardrailCatalogPage />);
    const jailbreak = await screen.findByLabelText("modelSettings.detectors.jailbreak_detection.title", { selector: "tr" });
    fireEvent.keyDown(within(jailbreak).getByRole("combobox", { name: "modelSettings.modelColumn" }), { key: "ArrowDown" });
    expect(await screen.findByRole("option", { name: /Qwen Guard · Mock provider/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Project A private model/ })).toBeNull();
  });

  it("shows one row per capability with shared models and separate stage results, without Rail tabs", async () => {
    renderPage(<GuardrailCatalogPage />);
    const runner = (await screen.findByRole("heading", { name: "modelSettings.catalogConfiguration" })).closest("section")!;
    expect(within(runner).queryByRole("tab")).toBeNull();
    expect(within(runner).getAllByRole("row")).toHaveLength(8);
    const safety = within(runner).getByLabelText("modelSettings.detectors.content_safety.title", { selector: "tr" });
    expect(within(safety).getAllByRole("combobox")).toHaveLength(1);
    expect(await catalogAction(safety, "modelSettings.saveAssignment")).toHaveProperty("disabled", true);
    for (const stage of ["input", "output"]) {
      const result = within(safety).getByRole("group", { name: `modelSettings.detectors.content_safety.title · modelSettings.stage.${stage}` });
      expect(within(result).getByText("modelSettings.evidence.passedEvidence")).toBeTruthy();
    }
    const jailbreak = within(runner).getByLabelText("modelSettings.detectors.jailbreak_detection.title", { selector: "tr" });
    expect(within(jailbreak).queryByText("modelSettings.stage.output")).toBeNull();
    const grounding = within(runner).getByLabelText("modelSettings.detectors.contextual_grounding.title", { selector: "tr" });
    expect(within(grounding).queryByText("modelSettings.stage.input")).toBeNull();
  });

  it("selects one shared model, validates both stages, and saves their separate receipts", async () => {
    const current = structuredClone(view);
    current.models.push({ ...safetyModel, id: "replacement", name: "Replacement Guard" });
    vi.mocked(getModelConfiguration).mockImplementation(async () => structuredClone(current));
    vi.mocked(validateModelAssignment).mockImplementation(async (target, modelId) => ({
      ...current.draft!, validationId: `receipt-${target}`, validationReport: {
        ...current.draft!.validationReport!, checks: [{ id: `probe:${target}:${modelId}`, scope: "capability", status: "passed", evidenceKind: "nemo-rail-v1", message: "Passed" }],
      },
    }));
    vi.mocked(saveModelAssignment).mockImplementation(async (target, modelId) => {
      if (target !== "control_plane") current.draft!.assignments.bindings[target] = modelId;
      return structuredClone(current.draft!);
    });
    renderPage(<GuardrailCatalogPage />);
    const row = await screen.findByLabelText("modelSettings.detectors.content_safety.title", { selector: "tr" });
    fireEvent.keyDown(within(row).getByRole("combobox"), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: /Replacement Guard/ }));
    expect(await catalogAction(row, "modelSettings.saveAssignment")).toHaveProperty("disabled", false);
    fireEvent.keyDown(within(row).getByRole("combobox"), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: /Qwen Guard/ }));
    expect(await catalogAction(row, "modelSettings.saveAssignment")).toHaveProperty("disabled", true);
    fireEvent.keyDown(within(row).getByRole("combobox"), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: /Replacement Guard/ }));
    expect(within(row).getAllByText("modelSettings.notChecked")).toHaveLength(2);
    fireEvent.click(await catalogAction(row, "modelSettings.validateAssignment"));
    await waitFor(() => expect(validateModelAssignment).toHaveBeenCalledTimes(2));
    expect(validateModelAssignment).toHaveBeenNthCalledWith(1, "content_safety.input", "replacement");
    expect(validateModelAssignment).toHaveBeenNthCalledWith(2, "content_safety.output", "replacement");
    await waitFor(() => expect(within(row).getAllByText("modelSettings.evidence.passedEvidence")).toHaveLength(2));
    fireEvent.click(await catalogAction(row, "modelSettings.saveAssignment"));
    await waitFor(() => expect(saveModelAssignment).toHaveBeenCalledTimes(2));
    expect(saveModelAssignment).toHaveBeenNthCalledWith(1, "content_safety.input", "replacement", "receipt-content_safety.input");
    expect(saveModelAssignment).toHaveBeenNthCalledWith(2, "content_safety.output", "replacement", "receipt-content_safety.output");
    await waitFor(() => expect(within(row).queryByText("modelSettings.unsaved")).toBeNull());
    expect(await catalogAction(row, "modelSettings.saveAssignment")).toHaveProperty("disabled", true);
    expect(activateModelConfiguration).not.toHaveBeenCalled();
  });

  it("saves and applies a shared model without running validation", async () => {
    const current = structuredClone(view);
    current.active = { ...structuredClone(view.draft!), id: "active-config", state: "active" };
    current.models.push({ ...safetyModel, id: "untested-model", name: "Untested Guard", status: "registered" });
    vi.mocked(getModelConfiguration).mockImplementation(async () => structuredClone(current));
    vi.mocked(saveModelAssignment).mockImplementation(async (target, modelId) => {
      if (target !== "control_plane") current.draft!.assignments.bindings[target] = modelId;
      current.draft!.state = "draft";
      current.draft!.validationReport = null;
      current.draft!.reviewToken = `saved-${target}`;
      return structuredClone(current.draft!);
    });
    renderPage(<GuardrailCatalogPage />);
    const row = await screen.findByLabelText("modelSettings.detectors.content_safety.title", { selector: "tr" });
    expect(within(row).getByRole("button", { name: "modelSettings.validateAssignment" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "modelSettings.saveAssignment" })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: /^modelSettings.actionsColumn/ })).toBeNull();
    fireEvent.keyDown(within(row).getByRole("combobox"), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: /Untested Guard/ }));
    fireEvent.click(await catalogAction(row, "modelSettings.saveAssignment"));
    await waitFor(() => expect(within(row).queryByText("modelSettings.unsaved")).toBeNull());
    expect(saveModelAssignment).toHaveBeenNthCalledWith(1, "content_safety.input", "untested-model", undefined);
    expect(saveModelAssignment).toHaveBeenNthCalledWith(2, "content_safety.output", "untested-model", undefined);
    fireEvent.click(screen.getByRole("button", { name: "modelSettings.reviewActivation" }));
    const review = await screen.findByRole("dialog");
    const apply = within(review).getByRole("button", { name: "modelSettings.activateRevisionAction" });
    expect(apply).toHaveProperty("disabled", false);
    fireEvent.click(apply);
    await waitFor(() => expect(activateModelConfiguration).toHaveBeenCalledWith({
      bindingIds: ["content_safety.input", "content_safety.output"], expectedDraftToken: "saved-content_safety.output", expectedActiveId: "active-config",
    }));
    expect(validateModelAssignment).not.toHaveBeenCalled();
    expect(within(row).queryByText("modelSettings.evidence.passedEvidence")).toBeNull();
  });

  it("preserves unequal saved assignments and requires an explicit choice when returning to shared mode", async () => {
    const configured = structuredClone(view);
    configured.models.push({ ...safetyModel, id: "output-model", name: "Output Guard" });
    configured.draft!.assignments.bindings["content_safety.output"] = "output-model";
    vi.mocked(getModelConfiguration).mockResolvedValue(configured);
    renderPage(<GuardrailCatalogPage />);
    const row = await screen.findByLabelText("modelSettings.detectors.content_safety.title", { selector: "tr" });
    expect(within(row).getByRole("combobox", { name: "modelSettings.stage.input" }).textContent).toContain("Qwen Guard");
    expect(within(row).getByRole("combobox", { name: "modelSettings.stage.output" }).textContent).toContain("Output Guard");
    fireEvent.click(within(row).getByRole("button", { name: "modelSettings.useSharedModel" }));
    expect(within(row).getByRole("combobox").textContent).toContain("modelSettings.chooseSharedModel");
    expect(await catalogAction(row, "modelSettings.saveAssignment")).toHaveProperty("disabled", true);
    expect(saveModelAssignment).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByRole("button", { name: "modelSettings.configureByStage" }));
    expect(within(row).getByRole("combobox", { name: "modelSettings.stage.output" }).textContent).toContain("Output Guard");
    expect(within(row).queryByText("modelSettings.unsaved")).toBeNull();
  });

  it("offers JEV in shared and per-stage content safety configuration", async () => {
    vi.mocked(getModelConfiguration).mockResolvedValue({ ...view, models: [...view.models,
      { ...chatModel, id: "jev", name: "JEV", providerKind: "typesafe", profile: "tali.typesafe-jev.v1" },
    ] });
    renderPage(<GuardrailCatalogPage />);
    const row = await screen.findByLabelText("modelSettings.detectors.content_safety.title", { selector: "tr" });
    fireEvent.keyDown(within(row).getByRole("combobox"), { key: "ArrowDown" });
    expect(await screen.findByRole("option", { name: /JEV/ })).toBeTruthy();
    fireEvent.keyDown(within(row).getByRole("combobox"), { key: "Escape" });
    fireEvent.click(within(row).getByRole("button", { name: "modelSettings.configureByStage" }));
    fireEvent.keyDown(within(row).getByRole("combobox", { name: "modelSettings.stage.input" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: /JEV/ }));
    const output = within(row).getByRole("combobox", { name: "modelSettings.stage.output" });
    expect(output.textContent).toContain("Qwen Guard");
    fireEvent.keyDown(output, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: /JEV/ }));
    fireEvent.click(await catalogAction(row, "modelSettings.validateAssignment"));
    await waitFor(() => expect(validateModelAssignment).toHaveBeenCalledWith("content_safety.output", "jev"));
    expect(validateModelAssignment).toHaveBeenCalledWith("content_safety.input", "jev");
  });

  it("replaces a stale pass after an input request failure and still validates output", async () => {
    vi.mocked(validateSavedModelAssignment).mockRejectedValueOnce(new Error("Input service unavailable"));
    renderPage(<GuardrailCatalogPage />);
    const row = await screen.findByLabelText("modelSettings.detectors.content_safety.title", { selector: "tr" });
    fireEvent.click(await catalogAction(row, "modelSettings.validateAssignment"));
    await waitFor(() => expect(validateSavedModelAssignment).toHaveBeenCalledTimes(2));
    const input = within(row).getByRole("group", { name: "modelSettings.detectors.content_safety.title · modelSettings.stage.input" });
    const output = within(row).getByRole("group", { name: "modelSettings.detectors.content_safety.title · modelSettings.stage.output" });
    expect(within(input).queryByText("modelSettings.evidence.passedEvidence")).toBeNull();
    expect(within(output).getByText("modelSettings.evidence.passedEvidence")).toBeTruthy();
    expect(await catalogAction(row, "modelSettings.saveAssignment")).toHaveProperty("disabled", true);
    expect(saveModelAssignment).not.toHaveBeenCalled();
    fireEvent.click(within(input).getByRole("button", { name: /modelSettings.evidence.failedEvidence/ }));
    expect(within(screen.getByRole("dialog")).getByText("Input service unavailable")).toBeTruthy();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("retains a failed stage save for retry even when the other stage saves successfully", async () => {
    const current = structuredClone(view);
    current.models.push({ ...safetyModel, id: "replacement", name: "Replacement Guard" });
    vi.mocked(getModelConfiguration).mockImplementation(async () => structuredClone(current));
    let failInput = true;
    vi.mocked(saveModelAssignment).mockImplementation(async (target, modelId) => {
      if (target === "content_safety.input" && failInput) throw new Error("Input save rejected");
      if (target !== "control_plane") current.draft!.assignments.bindings[target] = modelId;
      return structuredClone(current.draft!);
    });
    renderPage(<GuardrailCatalogPage />);
    const row = await screen.findByLabelText("modelSettings.detectors.content_safety.title", { selector: "tr" });
    fireEvent.keyDown(within(row).getByRole("combobox"), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: /Replacement Guard/ }));
    fireEvent.click(await catalogAction(row, "modelSettings.saveAssignment"));
    await waitFor(() => expect(saveModelAssignment).toHaveBeenCalledTimes(2));
    expect(current.draft!.assignments.bindings["content_safety.input"]).toBe("safety-model");
    expect(current.draft!.assignments.bindings["content_safety.output"]).toBe("replacement");
    expect(within(row).getByRole("combobox").textContent).toContain("Replacement Guard");
    expect(within(row).getByRole("alert")).toBeTruthy();
    expect(within(row).getByText("modelSettings.unsaved")).toBeTruthy();
    expect(toast.success).not.toHaveBeenCalled();
    failInput = false;
    fireEvent.click(await catalogAction(row, "modelSettings.saveAssignment"));
    await waitFor(() => expect(within(row).queryByText("modelSettings.unsaved")).toBeNull());
    expect(within(row).queryByRole("alert")).toBeNull();
    expect(current.draft!.assignments.bindings["content_safety.input"]).toBe("replacement");
    expect(saveModelAssignment).toHaveBeenCalledTimes(3);
    expect(saveModelAssignment).toHaveBeenLastCalledWith("content_safety.input", "replacement", undefined);
    expect(activateModelConfiguration).not.toHaveBeenCalled();
  });

  it("clears both shared bindings without issuing validation calls", async () => {
    renderPage(<GuardrailCatalogPage />);
    const row = await screen.findByLabelText("modelSettings.detectors.content_safety.title", { selector: "tr" });
    fireEvent.keyDown(within(row).getByRole("combobox"), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "modelSettings.notAssigned" }));
    expect(await catalogAction(row, "modelSettings.validateAssignment")).toHaveProperty("disabled", true);
    fireEvent.click(await catalogAction(row, "modelSettings.saveAssignment"));
    await waitFor(() => expect(saveModelAssignment).toHaveBeenCalledTimes(2));
    expect(saveModelAssignment).toHaveBeenCalledWith("content_safety.input", null, undefined);
    expect(saveModelAssignment).toHaveBeenCalledWith("content_safety.output", null, undefined);
    expect(validateModelAssignment).not.toHaveBeenCalled();
  });

  it("allows saving before testing and preserves a preview receipt when tested", async () => {
    vi.mocked(validateModelAssignment).mockResolvedValue({ validationId: "candidate-validation",
      ...view.draft, validationReport: { ...view.draft.validationReport!, checks: [
        { id: "probe:jailbreak.input:safety-model", scope: "capability", status: "passed", evidenceKind: "nemo-rail-v1", message: "Passed" },
      ] },
    });
    renderPage(<GuardrailCatalogPage />);
    const jailbreak = await screen.findByLabelText("modelSettings.detectors.jailbreak_detection.title", { selector: "tr" });
    fireEvent.keyDown(within(jailbreak).getByRole("combobox", { name: "modelSettings.modelColumn" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: /Qwen Guard · Mock provider/ }));
    const save = await catalogAction(jailbreak, "modelSettings.saveAssignment");
    expect(save.hasAttribute("disabled")).toBe(false);
    fireEvent.click(await catalogAction(jailbreak, "modelSettings.validateAssignment"));
    const testedSave = await catalogAction(jailbreak, "modelSettings.saveAssignment");
    expect(testedSave).toHaveProperty("disabled", false);
    expect(saveModelAssignment).not.toHaveBeenCalled();
    fireEvent.click(testedSave);
    await waitFor(() => expect(saveModelAssignment).toHaveBeenCalledWith("jailbreak.input", "safety-model", "candidate-validation"));
  });

  it.each(["input", "output"] as const)("offers the existing DeepSeek chat for independent %s review and validates that explicit binding", async (rail) => {
    vi.mocked(getModelConfiguration).mockResolvedValue({ ...view, models: [
      { ...chatModel, name: "DeepSeek Chat", providerKind: "deepseek", providerName: "DeepSeek" }, safetyModel,
    ] });
    renderPage(<GuardrailCatalogPage />);
    const reviewer = await screen.findByLabelText(`modelSettings.detectors.classifier_review.title`, { selector: "tr" });
    fireEvent.click(within(reviewer).getByRole("button", { name: "modelSettings.configureByStage" }));
    expect(within(reviewer).getByText("modelSettings.detectors.classifier_review.description")).toBeTruthy();
    fireEvent.keyDown(within(reviewer).getByRole("combobox", { name: `modelSettings.stage.${rail}` }), { key: "ArrowDown" });
    expect(screen.queryByRole("option", { name: /Qwen Guard/ })).toBeNull();
    fireEvent.click(await screen.findByRole("option", { name: /DeepSeek Chat · DeepSeek/ }));
    fireEvent.click(await catalogAction(reviewer, "modelSettings.validateAssignment"));
    await waitFor(() => expect(validateModelAssignment).toHaveBeenCalledWith(`classifier_review.${rail}`, "chat-model"));
    fireEvent.click(await catalogAction(reviewer, "modelSettings.saveAssignment"));
    await waitFor(() => expect(saveModelAssignment).toHaveBeenCalledWith(`classifier_review.${rail}`, "chat-model", "candidate-validation"));
    expect(saveModelAssignment).toHaveBeenCalledTimes(1);
    const primary = screen.getByLabelText(`modelSettings.detectors.content_safety.title`, { selector: "tr" });
    fireEvent.click(within(primary).getByRole("button", { name: "modelSettings.configureByStage" }));
    fireEvent.keyDown(within(primary).getByRole("combobox", { name: `modelSettings.stage.${rail}` }), { key: "ArrowDown" });
    expect(screen.queryByRole("option", { name: /DeepSeek Chat/ })).toBeNull();
    expect(screen.getByRole("option", { name: /Qwen Guard/ })).toBeTruthy();
  });

  it.each(["input", "output"] as const)("offers Laya content safety and semantic PII on the %s Rail", async (rail) => {
    vi.mocked(getModelConfiguration).mockResolvedValue({ ...view, models: [
      ...view.models, { ...chatModel, id: "laya-model", name: "Laya Auto", providerKind: "laya", providerName: "Laya", profile: "tali.laya.v1" },
    ] });
    renderPage(<GuardrailCatalogPage />);
    const primary = await screen.findByLabelText(`modelSettings.detectors.content_safety.title`, { selector: "tr" });
    fireEvent.click(within(primary).getByRole("button", { name: "modelSettings.configureByStage" }));
    fireEvent.keyDown(within(primary).getByRole("combobox", { name: `modelSettings.stage.${rail}` }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: /Laya Auto · Laya/ }));
    fireEvent.click(await catalogAction(primary, "modelSettings.validateAssignment"));
    await waitFor(() => expect(validateModelAssignment).toHaveBeenCalledWith(`content_safety.${rail}`, "laya-model"));
    const pii = screen.getByLabelText(`modelSettings.detectors.pii_detection.title`, { selector: "tr" });
    fireEvent.click(within(pii).getByRole("button", { name: "modelSettings.configureByStage" }));
    fireEvent.keyDown(within(pii).getByRole("combobox", { name: `modelSettings.stage.${rail}` }), { key: "ArrowDown" });
    expect(await screen.findByRole("option", { name: /Laya Auto/ })).toBeTruthy();
  });

  it.each(["input", "output"] as const)("offers DeepSeek with the explicit PII protocol on the %s Rail", async (rail) => {
    const binding = `pii_semantic.${rail}` as const;
    vi.mocked(getModelConfiguration).mockResolvedValue({ ...view, models: [
      { ...chatModel, name: "DeepSeek Chat", providerKind: "deepseek", providerName: "DeepSeek" },
      { ...chatModel, id: "pii-model", name: "DeepSeek PII", providerKind: "deepseek", providerName: "DeepSeek", profile: "tali.openai-compatible-pii.v1" },
    ] });
    vi.mocked(validateModelAssignment).mockResolvedValue({ ...view.draft!, validationId: "pii-validation", validationReport: {
      ...view.draft!.validationReport!, checks: [
        { id: `probe:${binding}:pii-model`, scope: "capability", status: "passed", evidenceKind: "nemo-rail-v1", message: "Passed" },
      ],
    } });
    renderPage(<GuardrailCatalogPage />);
    const pii = await screen.findByLabelText(`modelSettings.detectors.pii_detection.title`, { selector: "tr" });
    fireEvent.click(within(pii).getByRole("button", { name: "modelSettings.configureByStage" }));
    fireEvent.keyDown(within(pii).getByRole("combobox", { name: `modelSettings.stage.${rail}` }), { key: "ArrowDown" });
    expect(screen.queryByRole("option", { name: /DeepSeek Chat/ })).toBeNull();
    fireEvent.click(await screen.findByRole("option", { name: /DeepSeek PII · DeepSeek/ }));
    fireEvent.click(await catalogAction(pii, "modelSettings.validateAssignment"));
    await waitFor(() => expect(validateModelAssignment).toHaveBeenCalledWith(binding, "pii-model"));
    fireEvent.click(await catalogAction(pii, "modelSettings.saveAssignment"));
    await waitFor(() => expect(saveModelAssignment).toHaveBeenCalledWith(binding, "pii-model", "pii-validation"));
  });

  it("previews the saved Runner configuration before activating its revision", async () => {
    renderPage(<GuardrailCatalogPage />);
    const runner = (await screen.findByRole("heading", { name: "modelSettings.catalogConfiguration" })).closest("section")!;
    fireEvent.click(within(runner).getByRole("button", { name: "modelSettings.reviewActivation" }));
    expect(activateModelConfiguration).not.toHaveBeenCalled();
    const review = await screen.findByRole("dialog");
    expect(within(review).getAllByText("modelSettings.pendingConfiguration")).toHaveLength(2);
    expect(within(review).queryByRole("button", { name: /rollback/i })).toBeNull();
    expect(within(review).getAllByText("Qwen Guard").length).toBe(2);
    expect(within(review).queryByText("Authoring model")).toBeNull();
    fireEvent.click(within(review).getByRole("button", { name: "modelSettings.activateRevisionAction" }));
    await waitFor(() => expect(activateModelConfiguration).toHaveBeenCalledWith({
      bindingIds: ["content_safety.input", "content_safety.output"], expectedDraftToken: "review-token", expectedActiveId: null,
    }));
  });

  it("allows explicitly applying failed bindings and deselecting other changes", async () => {
    const configured = structuredClone(view);
    configured.draft!.state = "draft";
    configured.draft!.validationReport!.valid = false;
    configured.draft!.assignments.bindings["jailbreak.input"] = "safety-model";
    configured.draft!.validationReport!.checks.push({ id: "probe:jailbreak.input:safety-model", scope: "capability", status: "failed", evidenceKind: "nemo-rail-v1", message: "Not ready" });
    vi.mocked(getModelConfiguration).mockResolvedValue(configured);
    renderPage(<GuardrailCatalogPage />);
    fireEvent.click(await screen.findByRole("button", { name: "modelSettings.reviewActivation" }));
    const review = await screen.findByRole("dialog");
    expect(within(review).getByRole("checkbox", { name: "modelSettings.applyBinding jailbreak.input" }).hasAttribute("disabled")).toBe(false);
    expect(within(review).getByText("modelSettings.reviewNeedsValidation")).toBeTruthy();
    fireEvent.click(within(review).getByRole("checkbox", { name: "modelSettings.applyBinding content_safety.output" }));
    fireEvent.click(within(review).getByRole("button", { name: "modelSettings.activateRevisionAction" }));
    await waitFor(() => expect(activateModelConfiguration).toHaveBeenCalledWith({
      bindingIds: ["content_safety.input", "jailbreak.input"], expectedDraftToken: "review-token", expectedActiveId: null,
    }));
  });

  it("disables apply when all ready changes are deselected", async () => {
    renderPage(<GuardrailCatalogPage />);
    fireEvent.click(await screen.findByRole("button", { name: "modelSettings.reviewActivation" }));
    const review = await screen.findByRole("dialog");
    for (const checkbox of within(review).getAllByRole("checkbox")) fireEvent.click(checkbox);
    expect(within(review).getByRole("button", { name: "modelSettings.activateRevisionAction" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows active bindings and removals alongside the saved draft", async () => {
    const configured = structuredClone(view);
    configured.active = { ...structuredClone(view.draft!), id: "revision-1", revision: 1, state: "active" };
    configured.active.assignments.bindings["jailbreak.input"] = "safety-model";
    vi.mocked(getModelConfiguration).mockResolvedValue(configured);
    renderPage(<GuardrailCatalogPage />);
    expect(screen.queryByText("modelSettings.runnerConfiguration")).toBeNull();
    expect(screen.queryByText("modelSettings.viewSavedConfiguration")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "modelSettings.reviewActivation" }));
    expect(screen.getByText("modelSettings.currentConfiguration")).toBeTruthy();
    expect(screen.getAllByText("modelSettings.pendingConfiguration")).toHaveLength(2);
    expect(screen.getByText("modelSettings.bindingRemoved")).toBeTruthy();
    expect(activateModelConfiguration).not.toHaveBeenCalled();
  });

  it("pins the activation preview and requires a new review if the draft changes", async () => {
    renderPage(<GuardrailCatalogPage />);
    fireEvent.click(await screen.findByRole("button", { name: "modelSettings.reviewActivation" }));
    const review = await screen.findByRole("dialog");
    const newer = structuredClone(view);
    newer.draft!.id = "revision-3";
    newer.draft!.revision = 3;
    vi.mocked(getModelConfiguration).mockResolvedValue(newer);
    await act(async () => { await client!.refetchQueries(); });
    expect(await within(review).findByText("modelSettings.activationReviewChanged")).toBeTruthy();
    expect(within(review).getAllByText("modelSettings.pendingConfiguration")).toHaveLength(2);
    const confirm = within(review).getByRole("button", { name: "modelSettings.activateRevisionAction" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.click(confirm);
    expect(activateModelConfiguration).not.toHaveBeenCalled();
  });

  it("renders replacements as red removals and green additions without repeating unchanged bindings", async () => {
    const configured = structuredClone(view);
    configured.models.push({ ...safetyModel, id: "old-model", name: "Previous guard" });
    configured.active = { ...structuredClone(view.draft!), id: "revision-1", revision: 1, state: "active" };
    configured.active.assignments.bindings["content_safety.input"] = "old-model";
    configured.active.assignments.bindings["jailbreak.input"] = "safety-model";
    configured.draft!.assignments.bindings["pii_semantic.input"] = "safety-model";
    configured.draft!.validationReport!.checks.push({ id: "probe:pii_semantic.input:safety-model", scope: "capability", status: "passed", evidenceKind: "nemo-rail-v1", message: "Passed" });
    vi.mocked(getModelConfiguration).mockResolvedValue(configured);
    renderPage(<GuardrailCatalogPage />);
    fireEvent.click(await screen.findByRole("button", { name: "modelSettings.reviewActivation" }));
    const review = await screen.findByRole("dialog");
    const additions = within(review).getAllByText("modelSettings.bindingAdded");
    const removals = within(review).getAllByText("modelSettings.bindingRemoved");
    expect(additions).toHaveLength(2);
    expect(removals).toHaveLength(2);
    for (const label of additions) expect(label.closest("div")!.className).toContain("bg-emerald-500/10");
    for (const label of removals) expect(label.closest("div")!.className).toContain("bg-destructive/10");
    expect(within(review).queryByText("modelSettings.detectors.content_safety.title · modelSettings.outputRail")).toBeNull();
    fireEvent.click(within(review).getByRole("button", { name: "common.cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(activateModelConfiguration).not.toHaveBeenCalled();
  });

  it("explains when activation would distribute no model bindings", async () => {
    const empty = structuredClone(view);
    for (const target of Object.keys(empty.draft!.assignments.bindings)) {
      empty.draft!.assignments.bindings[target as keyof ModelAssignments["bindings"]] = null;
    }
    vi.mocked(getModelConfiguration).mockResolvedValue(empty);
    renderPage(<GuardrailCatalogPage />);
    fireEvent.click(await screen.findByRole("button", { name: "modelSettings.reviewActivation" }));
    const review = await screen.findByRole("dialog");
    expect(within(review).getByText("modelSettings.emptyRunnerConfiguration")).toBeTruthy();
    expect(within(review).getByText("modelSettings.noBindingChanges")).toBeTruthy();
    expect(within(review).queryByRole("table")).toBeNull();
    expect(within(review).getByRole("button", { name: "modelSettings.activateRevisionAction" })).toHaveProperty("disabled", true);
    expect(activateModelConfiguration).not.toHaveBeenCalled();
  });

  it("keeps a validated PII selection when another assignment refreshes the draft", async () => {
    vi.mocked(validateModelAssignment).mockResolvedValue({ ...view.draft!, validationId: "pii-validation", validationReport: {
      ...view.draft!.validationReport!, checks: [
        { id: "probe:pii_semantic.input:safety-model", scope: "capability", status: "passed", evidenceKind: "nemo-rail-v1", message: "Passed" },
      ],
    } });
    renderPage(<GuardrailCatalogPage />);
    const pii = await screen.findByLabelText("modelSettings.detectors.pii_detection.title", { selector: "tr" });
    const expand = within(pii).queryByRole("button", { name: "modelSettings.configureByStage" });
    if (expand) fireEvent.click(expand);
    fireEvent.keyDown(within(pii).getByRole("combobox", { name: "modelSettings.stage.input" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: /Qwen Guard · Mock provider/ }));
    fireEvent.click(await catalogAction(pii, "modelSettings.validateAssignment"));
    expect(await catalogAction(pii, "modelSettings.saveAssignment")).toHaveProperty("disabled", false);

    const refreshed = structuredClone(view);
    refreshed.draft!.updatedAt = "2026-09-01T00:01:00Z";
    vi.mocked(getModelConfiguration).mockResolvedValue(refreshed);
    await act(async () => { await client!.refetchQueries(); });
    await waitFor(() => expect(within(pii).getByRole("combobox", { name: "modelSettings.stage.input" }).textContent).toContain("Qwen Guard"));

    // Saving another row also refreshes the draft and must preserve PII edits.
    vi.mocked(saveModelAssignment).mockImplementation(async (target, modelId) => {
      if (target !== "control_plane") refreshed.draft!.assignments.bindings[target] = modelId;
      return structuredClone(refreshed.draft!);
    });
    const safety = screen.getByLabelText("modelSettings.detectors.content_safety.title", { selector: "tr" });
    fireEvent.keyDown(within(safety).getByRole("combobox"), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "modelSettings.notAssigned" }));
    fireEvent.click(await catalogAction(safety, "modelSettings.saveAssignment"));
    await waitFor(() => expect(saveModelAssignment).toHaveBeenCalledWith("content_safety.output", null, undefined));
    await waitFor(() => expect(within(safety).queryByText("modelSettings.unsaved")).toBeNull());
    expect(await catalogAction(pii, "modelSettings.saveAssignment")).toHaveProperty("disabled", false);
    expect(within(pii).getByRole("combobox", { name: "modelSettings.stage.input" }).textContent).toContain("Qwen Guard");

    const saved = structuredClone(refreshed);
    saved.draft!.assignments.bindings["pii_semantic.input"] = "safety-model";
    saved.draft!.updatedAt = "2026-09-01T00:02:00Z";
    vi.mocked(saveModelAssignment).mockImplementation(async () => {
      vi.mocked(getModelConfiguration).mockResolvedValue(saved);
      return saved.draft!;
    });
    fireEvent.click(await catalogAction(pii, "modelSettings.saveAssignment"));
    await waitFor(() => expect(saveModelAssignment).toHaveBeenCalledWith("pii_semantic.input", "safety-model", "pii-validation"));
    await waitFor(() => expect(screen.queryByText("modelSettings.unsaved")).toBeNull());
    cleanup();
    client!.clear();
    renderPage(<GuardrailCatalogPage />);
    const reloaded = await screen.findByLabelText("modelSettings.detectors.pii_detection.title", { selector: "tr" });
    expect(within(reloaded).getByRole("combobox", { name: "modelSettings.stage.input" }).textContent).toContain("Qwen Guard");
  });

  it("keeps failed saves visible and preserves the selected PII model for retry", async () => {
    vi.mocked(saveModelAssignment).mockRejectedValue(new Error("Validation receipt expired; validate this model again."));
    renderPage(<GuardrailCatalogPage />);
    const pii = await screen.findByLabelText("modelSettings.detectors.pii_detection.title", { selector: "tr" });
    fireEvent.click(within(pii).getByRole("button", { name: "modelSettings.configureByStage" }));
    fireEvent.keyDown(within(pii).getByRole("combobox", { name: "modelSettings.stage.input" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: /Qwen Guard/ }));
    fireEvent.click(await catalogAction(pii, "modelSettings.saveAssignment"));
    expect(await screen.findByText(/Validation receipt expired; validate this model again/)).toBeTruthy();
    expect(within(pii).getByRole("combobox", { name: "modelSettings.stage.input" }).textContent).toContain("Qwen Guard");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("warns about missing Rail evidence while allowing activation", async () => {
    const missingEvidence = structuredClone(view);
    for (const check of missingEvidence.draft.validationReport!.checks) delete check.evidenceKind;
    vi.mocked(getModelConfiguration).mockResolvedValue(missingEvidence);
    renderPage(<GuardrailCatalogPage />);
    const activate = await screen.findByRole("button", { name: "modelSettings.reviewActivation" });
    expect(activate.hasAttribute("disabled")).toBe(false);
    fireEvent.click(activate);
    const review = await screen.findByRole("dialog");
    expect(within(review).getByRole("button", { name: "modelSettings.activateRevisionAction" }).hasAttribute("disabled")).toBe(false);
    expect(within(review).getByText("modelSettings.reviewNeedsValidation")).toBeTruthy();
    expect(screen.queryByText("modelSettings.evidence.passedEvidence")).toBeNull();
  });

  it("validates only the selected detector without a global Catalog action", async () => {
    renderPage(<GuardrailCatalogPage />);
    const contentSafety = await screen.findByLabelText("modelSettings.detectors.content_safety.title", { selector: "tr" });
    fireEvent.click(await catalogAction(contentSafety, "modelSettings.validateAssignment"));
    await waitFor(() => expect(validateSavedModelAssignment).toHaveBeenCalledWith("content_safety.input", "safety-model", undefined));
    expect(screen.queryByRole("button", { name: "modelSettings.validateCatalog" })).toBeNull();
  });

  it("validates the Control Plane assignment independently", async () => {
    renderPage(<GuardrailCatalogPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "modelSettings.controlPlane" }));
    const section = (await screen.findByRole("heading", { name: "modelSettings.controlPlane" })).closest("section")!;
    fireEvent.click(within(section).getByRole("button", { name: "modelSettings.validateAssignment" }));
    await waitFor(() => expect(validateModelAssignment).toHaveBeenCalledWith("control_plane", expect.anything()));
  });

  it("keeps Runner activation independent of an uncommitted Control Plane selection", async () => {
    renderPage(<GuardrailCatalogPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "modelSettings.controlPlane" }));
    const section = (await screen.findByRole("heading", { name: "modelSettings.controlPlane" })).closest("section")!;
    fireEvent.keyDown(within(section).getByRole("combobox"), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "modelSettings.notAssigned" }));
    fireEvent.click(screen.getByRole("tab", { name: "modelSettings.catalogConfiguration" }));
    expect(screen.getByRole("button", { name: "modelSettings.reviewActivation" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: "modelSettings.controlPlane" }));
    expect(within(section).getByRole("combobox").textContent).toContain("modelSettings.notAssigned");
  });

  it("activates Control Plane after validation without a Save step", async () => {
    vi.mocked(validateModelAssignment).mockResolvedValue({ validationId: "candidate-validation", ...view.draft, validationReport: {
      ...view.draft.validationReport!, checks: [{ id: "probe:control_plane:chat-model", scope: "model", status: "passed", message: "Passed" }],
    } });
    renderPage(<GuardrailCatalogPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "modelSettings.controlPlane" }));
    const section = (await screen.findByRole("heading", { name: "modelSettings.controlPlane" })).closest("section")!;
    const activate = within(section).getByRole("button", { name: "modelSettings.activateControlPlane" });
    expect(activate.hasAttribute("disabled")).toBe(false);
    expect(within(section).queryByRole("button", { name: "modelSettings.saveAssignment" })).toBeNull();
    fireEvent.click(within(section).getByRole("button", { name: "modelSettings.validateAssignment" }));
    await waitFor(() => expect(activate.hasAttribute("disabled")).toBe(false));
    expect(saveModelAssignment).not.toHaveBeenCalled();
    fireEvent.click(activate);
    await waitFor(() => expect(saveModelAssignment).toHaveBeenCalledWith("control_plane", "chat-model", "candidate-validation"));
    expect(activateModelConfiguration).not.toHaveBeenCalled();
  });

  it("opens failed validation evidence and lets users inspect the passing sample too", async () => {
    const message = "Model probe returned HTTP 500 with a complete upstream diagnostic response.";
    vi.mocked(getModelConfiguration).mockResolvedValue({
      ...view,
      draft: {
        ...view.draft,
        state: "draft",
        validationReport: {
          ...view.draft.validationReport!,
          valid: false,
          checks: [{ id: "probe:content_safety.input:safety-model", scope: "capability", status: "failed", message, cases: [
            { id: "unsafe", passed: false, inputContent: "Unsafe example input", outputContent: "Unexpected output", expectedDecision: "block", actualDecision: "allow", reason: "Missed unsafe content" },
            { id: "safe", passed: true, inputContent: "Passing example hidden", outputContent: "Safe", expectedDecision: "allow", actualDecision: "allow", reason: "" },
          ] }],
        },
      },
    });
    renderPage(<GuardrailCatalogPage />);
    const row = await screen.findByLabelText("modelSettings.detectors.content_safety.title", { selector: "tr" });
    expect(within(row).queryByText(message)).toBeNull();
    fireEvent.click(within(row).getAllByRole("button", { name: /modelSettings.evidence.failedEvidence/ })[0]!);
    const inspector = screen.getByRole("dialog", { name: "modelSettings.evidence.title" });
    expect(within(inspector).getByText("Unsafe example input")).toBeTruthy();
    expect(within(inspector).getByText("Unexpected output")).toBeTruthy();
    expect(within(inspector).getByText("block")).toBeTruthy();
    expect(within(inspector).getByText("allow")).toBeTruthy();
    expect(within(inspector).queryByText("Passing example hidden")).toBeNull();
    expect(within(inspector).getByText(message)).toBeTruthy();
    fireEvent.click(within(inspector).getByRole("button", { name: /modelSettings.evidence.safeSample/ }));
    expect(within(inspector).getByText("Passing example hidden")).toBeTruthy();
  });

  it("blocks removal in the shared right drawer and clearly identifies Topic Control use", async () => {
    vi.mocked(getModelConfiguration).mockResolvedValue({
      ...view,
      draft: { ...view.draft, assignments: { ...assignments, bindings: { ...assignments.bindings, "topic_control.input": "safety-model" } } },
    });
    renderPage(<ModelsPage />);
    fireEvent.click(await modelAction("Qwen Guard", "common.remove"));
    const drawer = screen.getByRole("dialog", { name: "modelSettings.removeResourceTitle" });
    expect(within(drawer).getByText("modelSettings.topicControlRemovalTitle")).toBeTruthy();
    expect(within(drawer).getByText("modelSettings.detectors.topic_control.title · modelSettings.inputRail")).toBeTruthy();
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

  it("updates a Provider credential from the shared right-side drawer", async () => {
    renderPage(<ProvidersPage />);
    fireEvent.click(await screen.findByRole("button", { name: "modelSettings.manageProvider Mock provider" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Mock provider" })).getByRole("button", { name: "modelSettings.updateCredential" }));
    const drawer = screen.getByRole("dialog", { name: "modelSettings.updateCredential" });
    fireEvent.change(within(drawer).getByLabelText("modelSettings.newCredential"), { target: { value: "replacement-secret" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "modelSettings.saveAndVerifyCredential" }));
    await waitFor(() => expect(updateModelProviderCredential).toHaveBeenCalledWith(provider.id, "replacement-secret"));
  });

  it("keeps every Provider row action behind one management entry", async () => {
    renderPage(<ProvidersPage />);
    const manage = await screen.findByRole("button", { name: "modelSettings.manageProvider Mock provider" });
    expect(screen.queryByRole("button", { name: "modelSettings.updateCredential Mock provider" })).toBeNull();
    expect(screen.queryByRole("button", { name: "modelSettings.retest Mock provider" })).toBeNull();
    expect(screen.queryByRole("button", { name: "common.remove Mock provider" })).toBeNull();
    fireEvent.click(manage);
    const drawer = screen.getByRole("dialog", { name: "Mock provider" });
    expect(within(drawer).getByRole("button", { name: "modelSettings.retest" })).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: "modelSettings.updateCredential" })).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: "providerRegistration.registerModels" })).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: "common.remove" })).toBeTruthy();
  });

  it("keeps a failed credential update inside the inspector with a clear recovery path", async () => {
    vi.mocked(updateModelProviderCredential).mockRejectedValueOnce(new Error("Credential rejected by Provider"));
    renderPage(<ProvidersPage />);
    fireEvent.click(await screen.findByRole("button", { name: "modelSettings.manageProvider Mock provider" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Mock provider" })).getByRole("button", { name: "modelSettings.updateCredential" }));
    const drawer = screen.getByRole("dialog", { name: "modelSettings.updateCredential" });
    fireEvent.change(within(drawer).getByLabelText("modelSettings.newCredential"), { target: { value: "rejected-secret" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "modelSettings.saveAndVerifyCredential" }));
    expect((await within(drawer).findByRole("alert")).textContent).toContain("Credential rejected by Provider");
    expect(within(drawer).getByRole("button", { name: "common.back" })).toHaveProperty("disabled", false);
    fireEvent.change(within(drawer).getByLabelText("modelSettings.newCredential"), { target: { value: "corrected-secret" } });
    expect(within(drawer).queryByRole("alert")).toBeNull();
  });

  it("removes an unassigned Model only after drawer confirmation", async () => {
    const unused = { ...safetyModel, id: "unused-model", name: "Unused model", model: "mock/unused" };
    vi.mocked(getModelConfiguration).mockResolvedValue({ ...view, models: [...view.models, unused] });
    renderPage(<ModelsPage />);
    fireEvent.click(await modelAction("Unused model", "common.remove"));
    const drawer = screen.getByRole("dialog", { name: "modelSettings.removeResourceTitle" });
    fireEvent.click(within(drawer).getByRole("button", { name: "common.remove" }));
    await waitFor(() => expect(deleteModelDefinition).toHaveBeenCalledWith("unused-model"));
  });

  it("tests Model callability directly without confirmation or changing catalog assignments", async () => {
    renderPage(<ModelsPage />);
    fireEvent.click(await modelAction("Qwen Guard", "modelSettings.testCall"));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(testModelConnection).toHaveBeenCalledWith("safety-model"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(safetyModel.connectionMessage));
    await waitFor(() => expect(getModelConfiguration).toHaveBeenCalledTimes(2));
    expect(saveModelAssignment).not.toHaveBeenCalled();
    expect(activateModelConfiguration).not.toHaveBeenCalled();
  });

  it("shows pending feedback and lets users retry a failed Model test directly", async () => {
    let rejectProbe!: (error: Error) => void;
    vi.mocked(testModelConnection).mockImplementationOnce(() => new Promise((_, reject) => { rejectProbe = reject; }));
    renderPage(<ModelsPage />);
    fireEvent.click(await modelAction("Qwen Guard", "modelSettings.testCall"));
    await waitFor(() => expect(screen.getByRole("button", { name: "modelSettings.actions Qwen Guard" })).toHaveProperty("disabled", true));
    expect(screen.queryByRole("dialog")).toBeNull();
    rejectProbe(new Error("Network unavailable"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Network unavailable"));
    const retry = await modelAction("Qwen Guard", "modelSettings.testCall");
    expect(retry).toHaveProperty("disabled", false);
    vi.mocked(testModelConnection).mockResolvedValueOnce({ ...safetyModel, connectionStatus: "validated" });
    fireEvent.click(retry);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("modelSettings.callPassed"));
    expect(testModelConnection).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("tests every platform Model one after another and summarizes callability", async () => {
    const third = { ...chatModel, id: "third-model", name: "Third model" };
    vi.mocked(getModelConfiguration).mockResolvedValue({ ...view, models: [chatModel, safetyModel, third] });
    const calls: string[] = [];
    let releaseFirst!: () => void;
    vi.mocked(testModelConnection).mockImplementation((id: string) => {
      calls.push(id);
      if (calls.length === 1) return new Promise((resolve) => { releaseFirst = () => resolve({ ...chatModel, connectionStatus: "validated" }); });
      if (id === "safety-model") return Promise.resolve({ ...safetyModel, connectionStatus: "failed" });
      return Promise.resolve({ ...third, connectionStatus: "validated" });
    });
    renderPage(<ModelsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "modelSettings.testAllModels" }));
    await waitFor(() => expect(calls).toEqual(["chat-model"]));
    await waitFor(() => expect(screen.getByRole("button", { name: "modelSettings.actions Qwen Guard" })).toHaveProperty("disabled", true));
    expect(screen.getByRole("status").textContent).toBe("modelSettings.batchTestProgress");
    await act(async () => { releaseFirst(); });
    await waitFor(() => expect(calls).toEqual(["chat-model", "safety-model", "third-model"]));
    const report = await screen.findByRole("region", { name: "modelSettings.batchTestReport" });
    await waitFor(() => expect(within(report).getByText("modelSettings.batchTestSummaryFailed")).toBeTruthy());
    expect(within(report).getByText("Qwen Guard")).toBeTruthy();
    expect(toast.error).toHaveBeenCalledWith("modelSettings.batchTestSummaryFailed");
    expect(screen.getByRole("button", { name: "modelSettings.testAllModels" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "modelSettings.actions Qwen Guard" })).toHaveProperty("disabled", false);
  });

  it("retests a Provider only after right-drawer confirmation", async () => {
    renderPage(<ProvidersPage />);
    fireEvent.click(await screen.findByRole("button", { name: "modelSettings.manageProvider Mock provider" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Mock provider" })).getByRole("button", { name: "modelSettings.retest" }));
    expect(revalidateModelProvider).not.toHaveBeenCalled();
    const drawer = screen.getByRole("dialog", { name: "modelSettings.providerRetestConfirmationTitle" });
    fireEvent.click(within(drawer).getByRole("button", { name: "modelSettings.providerRetestConfirmationAction" }));
    await waitFor(() => expect(revalidateModelProvider).toHaveBeenCalledWith(provider.id));
  });
});
