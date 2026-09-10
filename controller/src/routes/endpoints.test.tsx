import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Endpoint, EndpointRegistration } from "@/lib/api";

import { CreateEndpointSheet, DeleteEndpointSheet, EndpointsPage, SetupChecklist } from "./endpoints";

const createEndpointMock = vi.fn();
const getEndpointMock = vi.fn();
const getEndpointsMock = vi.fn();
const getEndpointDeletionImpactMock = vi.fn();
const deleteEndpointMock = vi.fn();

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const labels: Record<string, string> = {
        "common.cancel": "Cancel",
        "common.back": "Back",
        "common.close": "Close",
        "common.retry": "Retry",
        "endpoints.register": "Add endpoint",
        "endpoints.registering": "Registering…",
        "endpoints.registerDescription": "Register one concrete AI Gateway instance.",
        "endpoints.setupTitle": "Set up Gateway connection",
        "endpoints.setupDescription": "Complete connection setup.",
        "endpoints.name": "Endpoint name",
        "endpoints.namePlaceholder": "Corporate AI Gateway",
        "endpoints.endpointProtocol": "Adapter protocol",
        "endpoints.adapters.litellm-generic-guardrail": "TaskLattice Guard for LiteLLM",
        "endpoints.adapterDescriptions.litellm-generic-guardrail": "Connect with an Endpoint and Secret.",
        "endpoints.credential": "Credential",
        "endpoints.setupChecklist": "Gateway setup checklist",
        "endpoints.stepsComplete": "{{count}} / 3 complete",
        "endpoints.setupStatuses.awaiting_callback": "Awaiting callback",
        "endpoints.setupStatuses.verified": "Verified",
        "endpoints.saveCredential": "Save the credential",
        "endpoints.saveCredentialDescription": "Store this value as {{env}}.",
        "endpoints.saveEndpointSecretDescription": "Save this Secret, then paste it into LiteLLM.",
        "endpoints.oneTimeCredential": "One-time credential",
        "endpoints.oneTimeCredentialDescription": "Shown once.",
        "endpoints.copyCredential": "Copy credential",
        "endpoints.credentialStoredConfirmation": "I stored this credential in a secure location",
        "endpoints.credentialSaved": "Credential saved",
        "endpoints.credentialSavedDescription": "The complete value is hidden. Only its non-secret hint remains.",
        "endpoints.revealCredential": "Reveal credential",
        "endpoints.hideCredential": "Hide credential",
        "endpoints.configureAdapter": "Configure {{adapter}}",
        "endpoints.configureAdapterDescription": "Deploy the generated configuration.",
        "endpoints.configureTaskLatticeProvider": "Connect the TaskLattice Guard Provider",
        "endpoints.configureTaskLatticeProviderDescription": "Connect Endpoint and Secret, then choose Provider settings.",
        "endpoints.protocolShort.litellm": "LiteLLM",
        "endpoints.taskLatticeGuardProvider": "TaskLattice Guard",
        "endpoints.taskLatticeGuardProviderDescription": "Built into the TaskLattice LiteLLM image",
        "endpoints.litellmProviderStepOpen": "Open Guardrails > Guardrail Garden.",
        "endpoints.litellmProviderStepSelect": "Open TaskLattice Guard and choose Create Guardrail.",
        "endpoints.litellmProviderStepConnect": "Paste Endpoint and Secret, select an inspection point, then choose Verify & connect.",
        "endpoints.endpointUrl": "Endpoint",
        "endpoints.endpointSecret": "Secret",
        "endpoints.endpointSecretDescription": "Use the complete one-time Secret saved in step 1.",
        "endpoints.endpointSecretDetailsDescription": "Use any active Secret.",
        "endpoints.endpointSecretAvailable": "Active Secret available",
        "endpoints.litellmProviderSettings": "Provider settings",
        "endpoints.litellmProviderSettingsDescription": "These settings are enforced by LiteLLM.",
        "endpoints.protectionStages": "Inspection points",
        "endpoints.protectionStagesDescription": "Select Before model, After model, or both. At least one checkpoint is required.",
        "endpoints.guardUnavailable": "Guard unavailable",
        "endpoints.guardUnavailableDescription": "Block request is recommended; Continue without protection favors availability.",
        "endpoints.advancedProviderSettings": "Advanced",
        "endpoints.advancedProviderSettingsDescription": "Runtime timeout defaults to 10 seconds. Apply to every request is on by default.",
        "endpoints.failOpenScopeTitle": "Continue is limited to availability failures",
        "endpoints.failOpenScopeDescription": "Continue applies only to network failures, timeouts, and HTTP 502, 503, or 504.",
        "endpoints.noLiteLLMRestartTitle": "No LiteLLM restart required",
        "endpoints.noLiteLLMRestartDescription": "Verify & connect saves and activates this Provider immediately.",
        "endpoints.apiBaseUrl": "TaskLattice API base URL",
        "endpoints.apiBaseEnvironmentVariable": "API base environment variable",
        "endpoints.configurationTemplate": "Adapter configuration",
        "endpoints.copyTemplate": "Copy configuration",
        "endpoints.copyItem": "Copy {{item}}",
        "endpoints.modes": "Recommended modes",
        "endpoints.defaultBehavior": "Application",
        "endpoints.defaultOn": "Default on",
        "endpoints.failureBehavior": "Failure behavior",
        "endpoints.failClosed": "Fail closed",
        "endpoints.blockOnError": "block on error",
        "endpoints.verifyCallbacks": "Verify real traffic",
        "endpoints.verifyCallbacksDescription": "Send a real model request.",
        "endpoints.inputCallback": "Input callback",
        "endpoints.outputCallback": "Output callback",
        "endpoints.waiting": "Waiting",
        "endpoints.callbacksVerified": "An authenticated callback has been received. This Gateway connection is verified; other checkpoints are optional.",
        "endpoints.complete": "Complete",
        "endpoints.finishLater": "Finish later",
        "endpoints.openEndpointDetails": "Open endpoint",
        "endpoints.unsavedCredentialTitle": "This credential has not been marked as saved",
        "endpoints.unsavedCredentialDescription": "Leaving permanently hides the complete value.",
        "endpoints.keepSettingUp": "Keep setting up",
        "endpoints.leaveAndLoseKey": "Leave and lose key",
        "endpoints.deleteEyebrow": "Endpoint / protected deletion",
        "endpoints.deleteDialogTitle": "Delete this Endpoint?",
        "endpoints.deleteDialogDescription": "{{name}} will be marked deleted.",
        "endpoints.recentIncomingRequests": "Incoming requests · last {{minutes}} min",
        "endpoints.activeRoutersAffected": "Active Routers affected",
        "endpoints.activeCredentialsRetained": "Active credentials retained",
        "endpoints.protectedDeleteWarning": "This Endpoint has protected activity.",
        "endpoints.noProtectedActivity": "No protected activity.",
        "endpoints.deleteRetentionNote": "Audit and runtime history remain stored.",
        "endpoints.deleteReason": "Reason for deletion",
        "endpoints.deleteReasonPlaceholder": "Explain why this Endpoint is being disabled",
        "endpoints.deleteTelemetryStale": "Runner telemetry is stale.",
        "endpoints.continueDelete": "Continue",
        "endpoints.deleteConfirm": "Delete Endpoint",
        "endpoints.deleting": "Deleting…",
        "endpoints.deleteProtectedTitle": "Confirm protected Endpoint deletion",
        "endpoints.deleteProtectedDescription": "{{requests}} requests and {{routers}} Routers remain.",
        "endpoints.deleteStopsTraffic": "{{routers}} Routers stop and {{credentials}} credentials stop authenticating.",
        "endpoints.typeNameToConfirm": "Type {{name}} to confirm",
        "endpoints.deleteDespiteProtection": "Delete and stop traffic",
      };
      return Object.entries(values ?? {}).reduce((label, [name, value]) => label.replace(`{{${name}}}`, String(value)), labels[key] ?? key);
    },
    i18n: { language: "en", exists: () => false },
  }),
}));

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "admin" } }) }));

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...original,
    createEndpoint: (...args: unknown[]) => createEndpointMock(...args),
    getEndpoint: (...args: unknown[]) => getEndpointMock(...args),
    getEndpoints: (...args: unknown[]) => getEndpointsMock(...args),
    getEndpointDeletionImpact: (...args: unknown[]) => getEndpointDeletionImpactMock(...args),
    deleteEndpoint: (...args: unknown[]) => deleteEndpointMock(...args),
  };
});

function endpoint(overrides: Partial<Endpoint> = {}): Endpoint {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    adapter_id: "litellm-generic-guardrail",
    protocol: "litellm",
    name: "Beijing primary",
    description: "",
    enabled: true,
    key_hint: "tali_••••8NzQ",
    credentials: [{ id: "credential-1", key_hint: "tali_••••8NzQ", created_at: "2026-08-12T08:00:00Z" }],
    setup_status: "awaiting_callback",
    runtime_status: "waiting",
    first_seen_at: null,
    input_seen_at: null,
    output_seen_at: null,
    last_seen_at: null,
    last_error_at: null,
    request_count: 0,
    error_count: 0,
    setup: {
      api_base_url: "https://guard.example.com/runtime/v1/endpoints/11111111-1111-4111-8111-111111111111",
      callback_url: "https://guard.example.com/runtime/v1/endpoints/11111111-1111-4111-8111-111111111111/beta/litellm_basic_guardrail_api",
      auth_header: "x-api-key",
      credential_env_var: "TASKLATTICE_GUARD_API_KEY",
      api_base_env_var: "TASKLATTICE_GUARD_API_BASE",
      recommended_modes: ["pre_call", "post_call"],
      default_on: true,
      fail_on_error: true,
      unreachable_fallback: "fail_closed",
      yaml_template: "litellm_settings:\n  guardrails:\n    - guardrail_name: tasklattice-guard",
    },
    created_at: "2026-08-12T08:00:00Z",
    updated_at: "2026-08-12T08:00:00Z",
    ...overrides,
  };
}

function registration(overrides: Partial<Endpoint> = {}): EndpointRegistration {
  return {
    endpoint: endpoint(overrides),
    credential: {
      id: "credential-1",
      value: "tali_endpoint_one_time_value",
      key_hint: "tali_••••8NzQ",
      created_at: "2026-08-12T08:00:00Z",
    },
  };
}

function renderWithProviders(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe("Endpoint onboarding", () => {
  beforeEach(() => {
    createEndpointMock.mockReset();
    getEndpointMock.mockReset();
    getEndpointsMock.mockReset();
    getEndpointDeletionImpactMock.mockReset();
    deleteEndpointMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("guides the packaged TaskLattice Guard Provider through connection and runtime settings", () => {
    const item = endpoint({
      setup_status: "verified",
      runtime_status: "waiting",
      input_seen_at: "2026-08-12T08:05:00Z",
      last_seen_at: "2026-08-12T08:05:00Z",
    });

    renderWithProviders(
      <SetupChecklist
        endpoint={item}
        credential={registration().credential}
        credentialSaved
        configurationCopied={false}
        onCredentialSavedChange={vi.fn()}
        onConfigurationCopied={vi.fn()}
      />,
    );

    expect(screen.getByRole("list", { name: "Gateway setup checklist" })).toBeTruthy();
    expect(screen.queryByText("tali_endpoint_one_time_value")).toBeNull();
    expect(screen.getByText("tali_••••8NzQ")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reveal credential" })).toBeTruthy();
    expect(screen.getByText("Connect the TaskLattice Guard Provider")).toBeTruthy();
    expect(screen.getByText("Open TaskLattice Guard and choose Create Guardrail.")).toBeTruthy();
    expect(screen.getByText("Paste Endpoint and Secret, select an inspection point, then choose Verify & connect.")).toBeTruthy();
    expect(screen.getByText("Endpoint")).toBeTruthy();
    expect(screen.getByText(item.setup.api_base_url)).toBeTruthy();
    expect(screen.getByText("Secret")).toBeTruthy();
    expect(screen.getByText("Inspection points")).toBeTruthy();
    expect(screen.getByText("Guard unavailable")).toBeTruthy();
    expect(screen.getByText("Advanced")).toBeTruthy();
    expect(screen.getByText("Continue is limited to availability failures")).toBeTruthy();
    expect(screen.getByText("No LiteLLM restart required")).toBeTruthy();
    expect(screen.getAllByText("Complete").length).toBe(3);
    expect(screen.queryByText(/config\.yaml/i)).toBeNull();
    expect(screen.queryByText(/guardrail_name: tasklattice-guard/)).toBeNull();
    expect(screen.queryByText(`TASKLATTICE_GUARD_API_BASE=${item.setup.api_base_url}`)).toBeNull();
    expect(screen.getByText("An authenticated callback has been received. This Gateway connection is verified; other checkpoints are optional.")).toBeTruthy();
  });

  it("hides a saved credential and supports explicit reveal and hide without clearing the saved state", async () => {
    const result = registration();
    createEndpointMock.mockResolvedValue(result);
    getEndpointMock.mockResolvedValue(result.endpoint);

    renderWithProviders(<CreateEndpointSheet open onOpenChange={vi.fn()} onCreated={vi.fn().mockResolvedValue(undefined)} />);

    fireEvent.change(screen.getByPlaceholderText("Corporate AI Gateway"), { target: { value: "Beijing primary" } });
    fireEvent.click(screen.getByRole("button", { name: "Add endpoint" }));

    expect(await screen.findByText("tali_endpoint_one_time_value")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "I stored this credential in a secure location" }));

    expect(screen.queryByText("tali_endpoint_one_time_value")).toBeNull();
    expect(screen.getByText("tali_••••8NzQ")).toBeTruthy();
    expect(screen.getByText("The complete value is hidden. Only its non-secret hint remains.")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "I stored this credential in a secure location" })).toBeNull();
    expect(screen.getAllByText("Complete")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Reveal credential" }));
    expect(screen.getByText("tali_endpoint_one_time_value")).toBeTruthy();
    expect(screen.getByText("Credential saved")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "I stored this credential in a secure location" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Hide credential" }));
    expect(screen.queryByText("tali_endpoint_one_time_value")).toBeNull();
    expect(screen.getByRole("button", { name: "Reveal credential" })).toBeTruthy();
    expect(screen.getAllByText("Complete")).toHaveLength(1);
  });

  it("protects the one-time credential when creation is closed before it is marked as saved", async () => {
    const result = registration();
    createEndpointMock.mockResolvedValue(result);
    getEndpointMock.mockResolvedValue(result.endpoint);
    const onOpenChange = vi.fn();
    const onCreated = vi.fn().mockResolvedValue(undefined);

    renderWithProviders(<CreateEndpointSheet open onOpenChange={onOpenChange} onCreated={onCreated} />);

    fireEvent.change(screen.getByPlaceholderText("Corporate AI Gateway"), { target: { value: "Beijing primary" } });
    fireEvent.click(screen.getByRole("button", { name: "Add endpoint" }));

    await waitFor(() => expect(screen.getByText("tali_endpoint_one_time_value")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(await screen.findByText("This credential has not been marked as saved")).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Leave and lose key" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(result.endpoint, false));
  });

  it("uses the shared side sheet and requires the Endpoint name for protected deletion", () => {
    const item = endpoint({ name: "Production Gateway" });
    const onConfirm = vi.fn();

    renderWithProviders(<DeleteEndpointSheet
      endpoint={item}
      open
      impact={{
        endpoint_id: item.id,
        endpoint_name: item.name,
        window_minutes: 30,
        incoming_request_count: 12,
        active_router_count: 2,
        active_credential_count: 1,
        last_request_at: "2026-08-20T09:58:00Z",
        telemetry_fresh: true,
        telemetry_watermark: "2026-08-20T10:00:00Z",
        requires_second_confirmation: true,
        requires_confirmation: true,
      }}
      loading={false}
      deleting={false}
      error={null}
      locale="en"
      onOpenChange={vi.fn()}
      onRetry={vi.fn()}
      onConfirm={onConfirm}
    />);

    expect(screen.getByText("Audit and runtime history remain stored.")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    const continueButton = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(continueButton.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason for deletion"), { target: { value: "Gateway has been decommissioned" } });
    expect(continueButton.disabled).toBe(false);
    fireEvent.click(continueButton);

    const finalDelete = screen.getByRole("button", { name: "Delete and stop traffic" }) as HTMLButtonElement;
    expect(finalDelete.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Type Production Gateway to confirm"), { target: { value: item.name } });
    expect(finalDelete.disabled).toBe(false);
    fireEvent.click(finalDelete);

    expect(onConfirm).toHaveBeenCalledWith({ reason: "Gateway has been decommissioned", confirm_recent_traffic: true, confirmation_name: item.name });
  });

  it("blocks Endpoint deletion when Runner telemetry is stale", () => {
    const item = endpoint({ name: "Unobserved Gateway" });
    const onConfirm = vi.fn();

    renderWithProviders(<DeleteEndpointSheet
      endpoint={item}
      open
      impact={{
        endpoint_id: item.id,
        endpoint_name: item.name,
        window_minutes: 30,
        incoming_request_count: 0,
        active_router_count: 0,
        active_credential_count: 1,
        last_request_at: null,
        telemetry_fresh: false,
        telemetry_watermark: null,
        requires_second_confirmation: false,
        requires_confirmation: false,
      }}
      loading={false}
      deleting={false}
      error={null}
      locale="en"
      onOpenChange={vi.fn()}
      onRetry={vi.fn()}
      onConfirm={onConfirm}
    />);

    fireEvent.change(screen.getByLabelText("Reason for deletion"), { target: { value: "No longer in inventory" } });
    expect(screen.getByText("Runner telemetry is stale.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Delete Endpoint" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("runs a fresh deletion impact check every time the side sheet is opened", async () => {
    const item = endpoint({ name: "Production Gateway" });
    const impact = {
      endpoint_id: item.id,
      endpoint_name: item.name,
      window_minutes: 30,
      incoming_request_count: 0,
      active_router_count: 0,
      active_credential_count: 1,
      last_request_at: null,
      telemetry_fresh: true,
      telemetry_watermark: "2026-08-20T10:00:00Z",
      requires_second_confirmation: false,
      requires_confirmation: false,
    };
    getEndpointsMock.mockResolvedValue({ items: [item], count: 1 });
    getEndpointMock.mockResolvedValue(item);
    getEndpointDeletionImpactMock.mockResolvedValue(impact);

    renderWithProviders(<EndpointsPage />);

    fireEvent.click(await screen.findByText(item.name));
    fireEvent.click(await screen.findByRole("button", { name: "endpoints.deleteAction" }));
    await waitFor(() => expect(getEndpointDeletionImpactMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByText(item.name));
    fireEvent.click(await screen.findByRole("button", { name: "endpoints.deleteAction" }));
    await waitFor(() => expect(getEndpointDeletionImpactMock).toHaveBeenCalledTimes(2));
  });

  it("passes the required reason and protection confirmation to the delete API", async () => {
    const item = endpoint({ name: "Retired Gateway" });
    getEndpointsMock.mockResolvedValue({ items: [item], count: 1 });
    getEndpointMock.mockResolvedValue(item);
    getEndpointDeletionImpactMock.mockResolvedValue({
      endpoint_id: item.id,
      endpoint_name: item.name,
      window_minutes: 30,
      incoming_request_count: 0,
      active_router_count: 0,
      active_credential_count: 1,
      last_request_at: null,
      telemetry_fresh: true,
      telemetry_watermark: "2026-08-20T10:00:00Z",
      requires_second_confirmation: false,
      requires_confirmation: false,
    });
    deleteEndpointMock.mockResolvedValue(undefined);

    renderWithProviders(<EndpointsPage />);

    fireEvent.click(await screen.findByText(item.name));
    fireEvent.click(await screen.findByRole("button", { name: "endpoints.deleteAction" }));
    await waitFor(() => expect(getEndpointDeletionImpactMock).toHaveBeenCalledTimes(1));
    fireEvent.change(await screen.findByLabelText("Reason for deletion"), { target: { value: "Gateway contract ended" } });
    const deleteButton = screen.getByRole("button", { name: "Delete Endpoint" }) as HTMLButtonElement;
    await waitFor(() => expect(deleteButton.disabled).toBe(false));
    fireEvent.click(deleteButton);

    await waitFor(() => expect(deleteEndpointMock).toHaveBeenCalledWith(item.id, {
      reason: "Gateway contract ended",
      confirm_recent_traffic: false,
    }));
  });
});
