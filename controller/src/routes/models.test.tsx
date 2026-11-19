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
    "classifier_review.security": "safety-model",
    "classifier_review.content_safety.input": null,
    "classifier_review.content_safety.output": null,
    "classifier_review.jailbreak.input": null,
    "classifier_review.topic_control.input": null,
    "classifier_review.pii_semantic.input": null,
    "classifier_review.pii_semantic.output": null,
    "content_safety.input": "29552d89-6b79-4d32-8871-09ed926d3d16",
    "content_safety.output": "29552d89-6b79-4d32-8871-09ed926d3d16",
    "jailbreak.input": "29552d89-6b79-4d32-8871-09ed926d3d16",
    "topic_control.input": "29552d89-6b79-4d32-8871-09ed926d3d16",
    "pii_semantic.input": "29552d89-6b79-4d32-8871-09ed926d3d16",
    "pii_semantic.output": "29552d89-6b79-4d32-8871-09ed926d3d16",
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
const builtinProvider = {
  ...provider, id: "builtin-provider", name: "Built-in", kind: "laya" as const,
  baseUrl: "", credentialConfigured: false, backend: "builtin_laya" as const,
};
const builtinModel = {
  ...safetyModel, id: "29552d89-6b79-4d32-8871-09ed926d3d16", name: "Laya English", model: "laya-english",
  providerId: builtinProvider.id, providerName: builtinProvider.name, providerKind: builtinProvider.kind,
  backend: builtinProvider.backend, profile: "tali.laya.v1" as const, checkpointRevision: "85cc74ddae6109077ebe2853a9b3077fb6606a78",
};
const now = "2026-09-01T00:00:00Z";
const view: ModelConfigurationView = {
  providers: [provider, builtinProvider], models: [chatModel, safetyModel, builtinModel],
  draft: {
    id: "revision-2", reviewToken: "review-token", revision: 2, state: "validated", generation: null, assignments,
    validationReport: {
      valid: true, checkedAt: now,
      checks: [
        { id: "probe:classifier_review.security:safety-model", scope: "capability", status: "passed", evidenceKind: "nemo-rail-v1", message: "Input Rail samples passed.", latencyMs: 6 },
      ],
      contractCoverage: [
        { contract: "tali.guard.secrets.exact.v1", source: "local", modelId: null, bindingId: null, railType: "input" },
        { contract: "tali.guard.content-safety.v1", source: "model", modelId: "safety-model", bindingId: "classifier_review.security", railType: "input" },
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

  it("uses Laya for initial classification without a model selector or save action", async () => {
    renderPage(<GuardrailCatalogPage />);
    const primary = await screen.findByLabelText("modelSettings.primaryModel");
    expect(within(primary).getByText("modelSettings.defaultPrimaryModel")).toBeTruthy();
    expect(within(primary).getByText("modelSettings.builtinReady")).toBeTruthy();
    expect(within(primary).queryByRole("combobox")).toBeNull();
    expect(within(primary).queryByRole("button")).toBeNull();
    expect(screen.queryByLabelText("modelSettings.detectors.content_safety.title", { selector: "tr" })).toBeNull();
    expect(discoverModelProvider).not.toHaveBeenCalled();
    expect(saveModelAssignment).not.toHaveBeenCalled();
  });

  it("shows the built-in Provider as Runner local without connection controls", async () => {
    vi.mocked(getModelConfiguration).mockResolvedValue({ ...view, providers: [builtinProvider], models: [builtinModel] });
    renderPage(<ProvidersPage />);
    const row = (await screen.findByText("modelSettings.runnerLocal")).closest("tr")!;
    expect(within(row).getByText("modelSettings.builtinReady")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: /modelSettings.manageProvider/ })).toBeNull();
  });

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
    const jailbreak = await screen.findByLabelText("modelSettings.detectors.security_review.title", { selector: "tr" });
    fireEvent.keyDown(within(jailbreak).getByRole("combobox"), { key: "ArrowDown" });
    expect(await screen.findByRole("option", { name: /Qwen Guard · Mock provider/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Project A private model/ })).toBeNull();
  });

  it("shows one security reviewer, one Topic reviewer and the two specialist models", async () => {
    renderPage(<GuardrailCatalogPage />);
    const section = (await screen.findByRole("heading", {name: "modelSettings.catalogConfiguration"})).closest("section")!;
    const rows = [...section.querySelectorAll("tr[aria-label]")];
    expect(rows.map(row => row.getAttribute("aria-label"))).toEqual(
      ["security_review", "topic_control_review", "contextual_grounding", "automated_reasoning"].map(key => "modelSettings.detectors." + key + ".title"));
    for (const row of rows) expect(row.querySelectorAll('[role="combobox"]')).toHaveLength(1);
    expect(within(section).queryByText("modelSettings.configureByStage")).toBeNull();
  });

  it("selects one shared model, validates the security group, and saves its receipt", async () => {
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
    const row = await screen.findByLabelText("modelSettings.detectors.security_review.title", { selector: "tr" });
    fireEvent.keyDown(within(row).getByRole("combobox"), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: /Replacement Guard/ }));
    expect(await catalogAction(row, "modelSettings.saveAssignment")).toHaveProperty("disabled", false);
    fireEvent.keyDown(within(row).getByRole("combobox"), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: /Qwen Guard/ }));
    expect(await catalogAction(row, "modelSettings.saveAssignment")).toHaveProperty("disabled", true);
    fireEvent.keyDown(within(row).getByRole("combobox"), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: /Replacement Guard/ }));
    expect(within(row).getAllByText("modelSettings.notChecked")).toHaveLength(1);
    fireEvent.click(await catalogAction(row, "modelSettings.validateAssignment"));
    await waitFor(() => expect(validateModelAssignment).toHaveBeenCalledTimes(1));
    expect(validateModelAssignment).toHaveBeenNthCalledWith(1, "classifier_review.security", "replacement");
    await waitFor(() => expect(within(row).getAllByText("modelSettings.evidence.passedEvidence")).toHaveLength(1));
    fireEvent.click(await catalogAction(row, "modelSettings.saveAssignment"));
    await waitFor(() => expect(saveModelAssignment).toHaveBeenCalledTimes(1));
    expect(saveModelAssignment).toHaveBeenNthCalledWith(1, "classifier_review.security", "replacement", "receipt-classifier_review.security");
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
    const row = await screen.findByLabelText("modelSettings.detectors.security_review.title", { selector: "tr" });
    expect(within(row).getByRole("button", { name: "modelSettings.validateAssignment" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "modelSettings.saveAssignment" })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: /^modelSettings.actionsColumn/ })).toBeNull();
    fireEvent.keyDown(within(row).getByRole("combobox"), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: /Untested Guard/ }));
    fireEvent.click(await catalogAction(row, "modelSettings.saveAssignment"));
    await waitFor(() => expect(within(row).queryByText("modelSettings.unsaved")).toBeNull());
    expect(saveModelAssignment).toHaveBeenNthCalledWith(1, "classifier_review.security", "untested-model", undefined);
    fireEvent.click(screen.getByRole("button", { name: "modelSettings.reviewActivation" }));
    const review = await screen.findByRole("dialog");
    const apply = within(review).getByRole("button", { name: "modelSettings.activateRevisionAction" });
    expect(apply).toHaveProperty("disabled", false);
    fireEvent.click(apply);
    await waitFor(() => expect(activateModelConfiguration).toHaveBeenCalledWith({
      bindingIds: ["classifier_review.security"], expectedDraftToken: "saved-classifier_review.security", expectedActiveId: "active-config",
    }));
    expect(validateModelAssignment).not.toHaveBeenCalled();
    expect(within(row).queryByText("modelSettings.evidence.passedEvidence")).toBeNull();
  });

  it("keeps historical selections until the administrator explicitly clears the shared reviewer", async () => {
    const draft = structuredClone(view.draft!);
    draft.assignments.bindings["classifier_review.security"] = null;
    draft.assignments.bindings["classifier_review.pii_semantic.output"] = "chat-model";
    vi.mocked(getModelConfiguration).mockResolvedValue({ ...view, draft });
    renderPage(<GuardrailCatalogPage />);
    const row = await screen.findByLabelText("modelSettings.detectors.security_review.title", { selector: "tr" });
    expect(within(row).getByRole("combobox").textContent).toContain("modelSettings.chooseSharedModel");
    expect(await catalogAction(row, "modelSettings.saveAssignment")).toHaveProperty("disabled", true);
    fireEvent.keyDown(within(row).getByRole("combobox"), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "modelSettings.noReview" }));
    fireEvent.click(await catalogAction(row, "modelSettings.saveAssignment"));
    await waitFor(() => expect(saveModelAssignment).toHaveBeenCalledWith("classifier_review.security", null, undefined));
  });

  it("offers review protocols without offering initial classifier protocols", async () => {
    vi.mocked(getModelConfiguration).mockResolvedValue({ ...view, models: [...view.models,
      { ...chatModel, id: "jev", name: "JEV", providerKind: "typesafe", profile: "tali.typesafe-jev.v1" },
    ] });
    renderPage(<GuardrailCatalogPage />);
    const row = await screen.findByLabelText("modelSettings.detectors.security_review.title", { selector: "tr" });
    fireEvent.keyDown(within(row).getByRole("combobox"), { key: "ArrowDown" });
    expect(screen.queryByRole("option", { name: /JEV|Laya English/ })).toBeNull();
    expect(screen.getByRole("option", { name: /Qwen Guard/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Authoring model/ })).toBeTruthy();
  });

  it("replaces a stale security pass after a validation request fails", async () => {
    vi.mocked(validateSavedModelAssignment).mockRejectedValueOnce(new Error("Input service unavailable"));
    renderPage(<GuardrailCatalogPage />);
    const row = await screen.findByLabelText("modelSettings.detectors.security_review.title", { selector: "tr" });
    fireEvent.click(await catalogAction(row, "modelSettings.validateAssignment"));
    await waitFor(() => expect(validateSavedModelAssignment).toHaveBeenCalledTimes(1));
    const input = within(row).getByRole("group", { name: "modelSettings.detectors.security_review.title · modelSettings.bothStages" });
    expect(within(input).queryByText("modelSettings.evidence.passedEvidence")).toBeNull();
    expect(await catalogAction(row, "modelSettings.saveAssignment")).toHaveProperty("disabled", true);
    expect(saveModelAssignment).not.toHaveBeenCalled();
    fireEvent.click(within(input).getByRole("button", { name: /modelSettings.evidence.failedEvidence/ }));
    expect(within(screen.getByRole("dialog")).getByText("Input service unavailable")).toBeTruthy();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("clears the security group without issuing validation calls", async () => {
    renderPage(<GuardrailCatalogPage />);
    const row = await screen.findByLabelText("modelSettings.detectors.security_review.title", { selector: "tr" });
    fireEvent.keyDown(within(row).getByRole("combobox"), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "modelSettings.noReview" }));
    expect(await catalogAction(row, "modelSettings.validateAssignment")).toHaveProperty("disabled", true);
    fireEvent.click(await catalogAction(row, "modelSettings.saveAssignment"));
    await waitFor(() => expect(saveModelAssignment).toHaveBeenCalledTimes(1));
    expect(saveModelAssignment).toHaveBeenCalledWith("classifier_review.security", null, undefined);
    expect(validateModelAssignment).not.toHaveBeenCalled();
  });

  it("offers only chat models for Topic review and saves that capability independently", async () => {
    renderPage(<GuardrailCatalogPage />);
    const topic = await screen.findByLabelText("modelSettings.detectors.topic_control_review.title", {selector:"tr"});
    fireEvent.keyDown(within(topic).getByRole("combobox"), {key:"ArrowDown"});
    expect(screen.queryByRole("option", {name:/Qwen Guard/})).toBeNull();
    expect(screen.getByRole("option", {name:"modelSettings.noReview"})).toBeTruthy();
    fireEvent.click(screen.getByRole("option", {name:/Authoring model/}));
    fireEvent.click(await catalogAction(topic, "modelSettings.validateAssignment"));
    await waitFor(() => expect(validateModelAssignment).toHaveBeenCalledWith("classifier_review.topic_control.input", "chat-model"));
    fireEvent.click(await catalogAction(topic, "modelSettings.saveAssignment"));
    await waitFor(() => expect(saveModelAssignment).toHaveBeenCalledWith("classifier_review.topic_control.input", "chat-model", "candidate-validation"));
    expect(saveModelAssignment).toHaveBeenCalledTimes(1);
  });

  it("can clear Topic review without changing its primary or security reviewers", async () => {
    vi.mocked(getModelConfiguration).mockResolvedValue({...view, draft:{...view.draft!, assignments:{
      ...assignments, bindings:{...assignments.bindings, "topic_control.input":"safety-model",
        "classifier_review.topic_control.input":"chat-model", "classifier_review.security":"safety-model"},
    }}});
    renderPage(<GuardrailCatalogPage />);
    const topic = await screen.findByLabelText("modelSettings.detectors.topic_control_review.title", {selector:"tr"});
    fireEvent.keyDown(within(topic).getByRole("combobox"), {key:"ArrowDown"});
    fireEvent.click(screen.getByRole("option", {name:"modelSettings.noReview"}));
    fireEvent.click(await catalogAction(topic, "modelSettings.saveAssignment"));
    await waitFor(() => expect(saveModelAssignment).toHaveBeenCalledWith("classifier_review.topic_control.input", null, undefined));
    expect(saveModelAssignment).toHaveBeenCalledTimes(1);
    expect(validateModelAssignment).not.toHaveBeenCalled();
  });

  it("keeps all six initial bindings unchanged when a reviewer is cleared", async () => {
    const current = structuredClone(view);
    const primaries = Object.fromEntries(Object.entries(current.draft!.assignments.bindings).filter(([id]) => !id.startsWith("classifier_review.")));
    vi.mocked(getModelConfiguration).mockImplementation(async () => structuredClone(current));
    vi.mocked(saveModelAssignment).mockImplementation(async (target, modelId) => {
      if (target !== "control_plane") current.draft!.assignments.bindings[target] = modelId;
      return structuredClone(current.draft!);
    });
    renderPage(<GuardrailCatalogPage />);
    const row = await screen.findByLabelText("modelSettings.detectors.security_review.title", { selector: "tr" });
    fireEvent.keyDown(within(row).getByRole("combobox"), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("option", { name: "modelSettings.noReview" }));
    fireEvent.click(await catalogAction(row, "modelSettings.saveAssignment"));
    await waitFor(() => expect(saveModelAssignment).toHaveBeenCalledTimes(1));
    for (const [id, modelId] of Object.entries(primaries)) expect(current.draft!.assignments.bindings[id as keyof ModelAssignments["bindings"]]).toBe(modelId);
  });

  it("previews the saved Runner configuration before activating its revision", async () => {
    renderPage(<GuardrailCatalogPage />);
    const runner = (await screen.findByRole("heading", { name: "modelSettings.catalogConfiguration" })).closest("section")!;
    fireEvent.click(within(runner).getByRole("button", { name: "modelSettings.reviewActivation" }));
    expect(activateModelConfiguration).not.toHaveBeenCalled();
    const review = await screen.findByRole("dialog");
    expect(within(review).getAllByText("modelSettings.pendingConfiguration")).toHaveLength(2);
    expect(within(review).queryByRole("button", { name: /rollback/i })).toBeNull();
    expect(within(review).getAllByText("Qwen Guard").length).toBe(1);
    expect(within(review).queryByText("Authoring model")).toBeNull();
    fireEvent.click(within(review).getByRole("button", { name: "modelSettings.activateRevisionAction" }));
    await waitFor(() => expect(activateModelConfiguration).toHaveBeenCalledWith({
      bindingIds: ["classifier_review.security"], expectedDraftToken: "review-token", expectedActiveId: null,
    }));
  });

  it("allows explicitly applying failed bindings and deselecting other changes", async () => {
    const configured = structuredClone(view);
    configured.draft!.state = "draft";
    configured.draft!.validationReport!.valid = false;
    configured.draft!.assignments.bindings["classifier_review.topic_control.input"] = "safety-model";
    configured.draft!.validationReport!.checks.push({ id: "probe:classifier_review.topic_control.input:safety-model", scope: "capability", status: "failed", evidenceKind: "nemo-rail-v1", message: "Not ready" });
    vi.mocked(getModelConfiguration).mockResolvedValue(configured);
    renderPage(<GuardrailCatalogPage />);
    fireEvent.click(await screen.findByRole("button", { name: "modelSettings.reviewActivation" }));
    const review = await screen.findByRole("dialog");
    expect(within(review).getByRole("checkbox", { name: "modelSettings.applyBinding classifier_review.topic_control.input" }).hasAttribute("disabled")).toBe(false);
    expect(within(review).getByText("modelSettings.reviewNeedsValidation")).toBeTruthy();
    fireEvent.click(within(review).getByRole("checkbox", { name: "modelSettings.applyBinding classifier_review.security" }));
    fireEvent.click(within(review).getByRole("button", { name: "modelSettings.activateRevisionAction" }));
    await waitFor(() => expect(activateModelConfiguration).toHaveBeenCalledWith({
      bindingIds: ["classifier_review.topic_control.input"], expectedDraftToken: "review-token", expectedActiveId: null,
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
    configured.active.assignments.bindings["classifier_review.topic_control.input"] = "safety-model";
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
    configured.active.assignments.bindings["classifier_review.security"] = "old-model";
    configured.active.assignments.bindings["classifier_review.topic_control.input"] = "safety-model";
    configured.draft!.assignments.bindings["classifier_review.topic_control.input"] = "chat-model";
    configured.draft!.validationReport!.checks.push({ id: "probe:classifier_review.pii_semantic.input:safety-model", scope: "capability", status: "passed", evidenceKind: "nemo-rail-v1", message: "Passed" });
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
    expect(within(review).queryByText("modelSettings.detectors.security_review.title · modelSettings.outputRail")).toBeNull();
    fireEvent.click(within(review).getByRole("button", { name: "common.cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(activateModelConfiguration).not.toHaveBeenCalled();
  });

  it("has no pending model changes when only default Laya is configured", async () => {
    const defaults = structuredClone(view);
    for (const target of Object.keys(defaults.draft!.assignments.bindings).filter(id => id.startsWith("classifier_review."))) {
      defaults.draft!.assignments.bindings[target as keyof ModelAssignments["bindings"]] = null;
    }
    vi.mocked(getModelConfiguration).mockResolvedValue(defaults);
    renderPage(<GuardrailCatalogPage />);
    fireEvent.click(await screen.findByRole("button", { name: "modelSettings.reviewActivation" }));
    const review = await screen.findByRole("dialog");
    expect(within(review).getByText("modelSettings.noBindingChanges")).toBeTruthy();
    expect(within(review).queryByText("modelSettings.emptyRunnerConfiguration")).toBeNull();
    expect(within(review).getByRole("button", { name: "modelSettings.activateRevisionAction" })).toHaveProperty("disabled", true);
    expect(activateModelConfiguration).not.toHaveBeenCalled();
  });

  it("keeps failed saves visible and preserves the selected security model for retry", async () => {
    vi.mocked(saveModelAssignment).mockRejectedValue(new Error("Validation receipt expired; validate this model again."));
    renderPage(<GuardrailCatalogPage />);
    const pii = await screen.findByLabelText("modelSettings.detectors.security_review.title", { selector: "tr" });
    fireEvent.keyDown(within(pii).getByRole("combobox"), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: /Authoring model/ }));
    fireEvent.click(await catalogAction(pii, "modelSettings.saveAssignment"));
    expect(await screen.findByText(/Validation receipt expired; validate this model again/)).toBeTruthy();
    expect(within(pii).getByRole("combobox").textContent).toContain("Authoring model");
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
    const contentSafety = await screen.findByLabelText("modelSettings.detectors.security_review.title", { selector: "tr" });
    fireEvent.click(await catalogAction(contentSafety, "modelSettings.validateAssignment"));
    await waitFor(() => expect(validateSavedModelAssignment).toHaveBeenCalledWith("classifier_review.security", "safety-model", undefined));
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

  it("lists the same DeepSeek security reviewer in the Control Plane chat selector", async () => {
    const deepseek = { ...chatModel, id: "ds-review", name: "DeepSeek Flash", providerKind: "deepseek" as const, profile: "tali.classifier-review.v1" as const };
    vi.mocked(getModelConfiguration).mockResolvedValue({ ...view, models: [deepseek, safetyModel], draft: {
      ...view.draft, assignments: { controlPlane: null, bindings: { ...assignments.bindings, "classifier_review.security": deepseek.id } },
    } });
    renderPage(<GuardrailCatalogPage />);
    const review = await screen.findByLabelText("modelSettings.detectors.security_review.title", { selector: "tr" });
    expect(within(review).getByRole("combobox").textContent).toContain(deepseek.name);
    fireEvent.click(screen.getByRole("tab", { name: "modelSettings.controlPlane" }));
    const section = screen.getByRole("heading", { name: "modelSettings.controlPlane" }).closest("section")!;
    fireEvent.keyDown(within(section).getByRole("combobox"), { key: "ArrowDown" });
    expect(screen.queryByRole("option", { name: /Qwen Guard/ })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /DeepSeek Flash/ }));
    fireEvent.click(within(section).getByRole("button", { name: "modelSettings.validateAssignment" }));
    await waitFor(() => expect(validateModelAssignment).toHaveBeenCalledWith("control_plane", deepseek.id));
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
          checks: [{ id: "probe:classifier_review.security:safety-model", scope: "capability", status: "failed", message, cases: [
            { id: "unsafe", passed: false, inputContent: "Unsafe example input", outputContent: "Unexpected output", expectedDecision: "block", actualDecision: "allow", reason: "Missed unsafe content" },
            { id: "safe", passed: true, inputContent: "Passing example hidden", outputContent: "Safe", expectedDecision: "allow", actualDecision: "allow", reason: "" },
          ] }],
        },
      },
    });
    renderPage(<GuardrailCatalogPage />);
    const row = await screen.findByLabelText("modelSettings.detectors.security_review.title", { selector: "tr" });
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
