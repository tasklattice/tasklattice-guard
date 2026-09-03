import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Integration, IntegrationRegistration } from "@/lib/api";

import { CreateIntegrationSheet, DeleteIntegrationSheet, IntegrationsPage, SetupChecklist } from "./integrations";

const createIntegrationMock = vi.fn();
const getIntegrationMock = vi.fn();
const getIntegrationsMock = vi.fn();
const getIntegrationDeletionImpactMock = vi.fn();
const deleteIntegrationMock = vi.fn();

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const labels: Record<string, string> = {
        "common.cancel": "Cancel",
        "common.back": "Back",
        "common.close": "Close",
        "common.retry": "Retry",
        "integrations.register": "Add integration",
        "integrations.registering": "Registering…",
        "integrations.registerDescription": "Register one concrete AI Gateway instance.",
        "integrations.setupTitle": "Set up Gateway connection",
        "integrations.setupDescription": "Complete connection setup.",
        "integrations.name": "Integration name",
        "integrations.namePlaceholder": "Corporate AI Gateway",
        "integrations.integrationProtocol": "Adapter protocol",
        "integrations.adapters.litellm-generic-guardrail": "TaskLattice Guard for LiteLLM",
        "integrations.adapterDescriptions.litellm-generic-guardrail": "Connect with an Endpoint and Secret.",
        "integrations.credential": "Credential",
        "integrations.setupChecklist": "Gateway setup checklist",
        "integrations.stepsComplete": "{{count}} / 3 complete",
        "integrations.setupStatuses.awaiting_callback": "Awaiting callback",
        "integrations.setupStatuses.verified": "Verified",
        "integrations.saveCredential": "Save the credential",
        "integrations.saveCredentialDescription": "Store this value as {{env}}.",
        "integrations.saveIntegrationSecretDescription": "Save this Secret, then paste it into LiteLLM.",
        "integrations.oneTimeCredential": "One-time credential",
        "integrations.oneTimeCredentialDescription": "Shown once.",
        "integrations.copyCredential": "Copy credential",
        "integrations.credentialStoredConfirmation": "I stored this credential in a secure location",
        "integrations.credentialSaved": "Credential saved",
        "integrations.credentialSavedDescription": "The complete value is hidden. Only its non-secret hint remains.",
        "integrations.revealCredential": "Reveal credential",
        "integrations.hideCredential": "Hide credential",
        "integrations.configureAdapter": "Configure {{adapter}}",
        "integrations.configureAdapterDescription": "Deploy the generated configuration.",
        "integrations.configureTaskLatticeProvider": "Connect the TaskLattice Guard Provider",
        "integrations.configureTaskLatticeProviderDescription": "Connect Endpoint and Secret, then choose Provider settings.",
        "integrations.protocolShort.litellm": "LiteLLM",
        "integrations.taskLatticeGuardProvider": "TaskLattice Guard",
        "integrations.taskLatticeGuardProviderDescription": "Built into the TaskLattice LiteLLM image",
        "integrations.litellmProviderStepOpen": "Open Guardrails > Guardrail Garden.",
        "integrations.litellmProviderStepSelect": "Open TaskLattice Guard and choose Create Guardrail.",
        "integrations.litellmProviderStepConnect": "Paste Endpoint and Secret, select an inspection point, then choose Verify & connect.",
        "integrations.integrationEndpoint": "Endpoint",
        "integrations.integrationSecret": "Secret",
        "integrations.integrationSecretDescription": "Use the complete one-time Secret saved in step 1.",
        "integrations.integrationSecretDetailsDescription": "Use any active Secret.",
        "integrations.integrationSecretAvailable": "Active Secret available",
        "integrations.litellmProviderSettings": "Provider settings",
        "integrations.litellmProviderSettingsDescription": "These settings are enforced by LiteLLM.",
        "integrations.protectionStages": "Inspection points",
        "integrations.protectionStagesDescription": "Select Before model, After model, or both. At least one checkpoint is required.",
        "integrations.guardUnavailable": "Guard unavailable",
        "integrations.guardUnavailableDescription": "Block request is recommended; Continue without protection favors availability.",
        "integrations.advancedProviderSettings": "Advanced",
        "integrations.advancedProviderSettingsDescription": "Runtime timeout defaults to 10 seconds. Apply to every request is on by default.",
        "integrations.failOpenScopeTitle": "Continue is limited to availability failures",
        "integrations.failOpenScopeDescription": "Continue applies only to network failures, timeouts, and HTTP 502, 503, or 504.",
        "integrations.noLiteLLMRestartTitle": "No LiteLLM restart required",
        "integrations.noLiteLLMRestartDescription": "Verify & connect saves and activates this Provider immediately.",
        "integrations.apiBaseUrl": "TaskLattice API base URL",
        "integrations.apiBaseEnvironmentVariable": "API base environment variable",
        "integrations.configurationTemplate": "Adapter configuration",
        "integrations.copyTemplate": "Copy configuration",
        "integrations.copyItem": "Copy {{item}}",
        "integrations.modes": "Recommended modes",
        "integrations.defaultBehavior": "Application",
        "integrations.defaultOn": "Default on",
        "integrations.failureBehavior": "Failure behavior",
        "integrations.failClosed": "Fail closed",
        "integrations.blockOnError": "block on error",
        "integrations.verifyCallbacks": "Verify real traffic",
        "integrations.verifyCallbacksDescription": "Send a real model request.",
        "integrations.inputCallback": "Input callback",
        "integrations.outputCallback": "Output callback",
        "integrations.waiting": "Waiting",
        "integrations.callbacksVerified": "An authenticated callback has been received. This Gateway connection is verified; other checkpoints are optional.",
        "integrations.complete": "Complete",
        "integrations.finishLater": "Finish later",
        "integrations.openIntegrationDetails": "Open integration",
        "integrations.unsavedCredentialTitle": "This credential has not been marked as saved",
        "integrations.unsavedCredentialDescription": "Leaving permanently hides the complete value.",
        "integrations.keepSettingUp": "Keep setting up",
        "integrations.leaveAndLoseKey": "Leave and lose key",
        "integrations.deleteEyebrow": "Integration / protected deletion",
        "integrations.deleteDialogTitle": "Delete this Integration?",
        "integrations.deleteDialogDescription": "{{name}} will be marked deleted.",
        "integrations.recentIncomingRequests": "Incoming requests · last {{minutes}} min",
        "integrations.activeDeploymentsAffected": "Active Deployments affected",
        "integrations.activeCredentialsRetained": "Active credentials retained",
        "integrations.protectedDeleteWarning": "This Integration has protected activity.",
        "integrations.noProtectedActivity": "No protected activity.",
        "integrations.deleteRetentionNote": "Audit and runtime history remain stored.",
        "integrations.deleteReason": "Reason for deletion",
        "integrations.deleteReasonPlaceholder": "Explain why this Integration is being disabled",
        "integrations.deleteTelemetryStale": "Runner telemetry is stale.",
        "integrations.continueDelete": "Continue",
        "integrations.deleteConfirm": "Delete Integration",
        "integrations.deleting": "Deleting…",
        "integrations.deleteProtectedTitle": "Confirm protected Integration deletion",
        "integrations.deleteProtectedDescription": "{{requests}} requests and {{deployments}} Deployments remain.",
        "integrations.deleteStopsTraffic": "{{deployments}} Deployments stop and {{credentials}} credentials stop authenticating.",
        "integrations.typeNameToConfirm": "Type {{name}} to confirm",
        "integrations.deleteDespiteProtection": "Delete and stop traffic",
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
    createIntegration: (...args: unknown[]) => createIntegrationMock(...args),
    getIntegration: (...args: unknown[]) => getIntegrationMock(...args),
    getIntegrations: (...args: unknown[]) => getIntegrationsMock(...args),
    getIntegrationDeletionImpact: (...args: unknown[]) => getIntegrationDeletionImpactMock(...args),
    deleteIntegration: (...args: unknown[]) => deleteIntegrationMock(...args),
  };
});

function integration(overrides: Partial<Integration> = {}): Integration {
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
      api_base_url: "https://guard.example.com/runtime/v1/integrations/11111111-1111-4111-8111-111111111111",
      callback_url: "https://guard.example.com/runtime/v1/integrations/11111111-1111-4111-8111-111111111111/beta/litellm_basic_guardrail_api",
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

function registration(overrides: Partial<Integration> = {}): IntegrationRegistration {
  return {
    integration: integration(overrides),
    credential: {
      id: "credential-1",
      value: "tali_integration_one_time_value",
      key_hint: "tali_••••8NzQ",
      created_at: "2026-08-12T08:00:00Z",
    },
  };
}

function renderWithProviders(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe("Integration onboarding", () => {
  beforeEach(() => {
    createIntegrationMock.mockReset();
    getIntegrationMock.mockReset();
    getIntegrationsMock.mockReset();
    getIntegrationDeletionImpactMock.mockReset();
    deleteIntegrationMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("guides the packaged TaskLattice Guard Provider through connection and runtime settings", () => {
    const item = integration({
      setup_status: "verified",
      runtime_status: "waiting",
      input_seen_at: "2026-08-12T08:05:00Z",
      last_seen_at: "2026-08-12T08:05:00Z",
    });

    renderWithProviders(
      <SetupChecklist
        integration={item}
        credential={registration().credential}
        credentialSaved
        configurationCopied={false}
        onCredentialSavedChange={vi.fn()}
        onConfigurationCopied={vi.fn()}
      />,
    );

    expect(screen.getByRole("list", { name: "Gateway setup checklist" })).toBeTruthy();
    expect(screen.queryByText("tali_integration_one_time_value")).toBeNull();
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
    createIntegrationMock.mockResolvedValue(result);
    getIntegrationMock.mockResolvedValue(result.integration);

    renderWithProviders(<CreateIntegrationSheet open onOpenChange={vi.fn()} onCreated={vi.fn().mockResolvedValue(undefined)} />);

    fireEvent.change(screen.getByPlaceholderText("Corporate AI Gateway"), { target: { value: "Beijing primary" } });
    fireEvent.click(screen.getByRole("button", { name: "Add integration" }));

    expect(await screen.findByText("tali_integration_one_time_value")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "I stored this credential in a secure location" }));

    expect(screen.queryByText("tali_integration_one_time_value")).toBeNull();
    expect(screen.getByText("tali_••••8NzQ")).toBeTruthy();
    expect(screen.getByText("The complete value is hidden. Only its non-secret hint remains.")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "I stored this credential in a secure location" })).toBeNull();
    expect(screen.getAllByText("Complete")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Reveal credential" }));
    expect(screen.getByText("tali_integration_one_time_value")).toBeTruthy();
    expect(screen.getByText("Credential saved")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "I stored this credential in a secure location" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Hide credential" }));
    expect(screen.queryByText("tali_integration_one_time_value")).toBeNull();
    expect(screen.getByRole("button", { name: "Reveal credential" })).toBeTruthy();
    expect(screen.getAllByText("Complete")).toHaveLength(1);
  });

  it("protects the one-time credential when creation is closed before it is marked as saved", async () => {
    const result = registration();
    createIntegrationMock.mockResolvedValue(result);
    getIntegrationMock.mockResolvedValue(result.integration);
    const onOpenChange = vi.fn();
    const onCreated = vi.fn().mockResolvedValue(undefined);

    renderWithProviders(<CreateIntegrationSheet open onOpenChange={onOpenChange} onCreated={onCreated} />);

    fireEvent.change(screen.getByPlaceholderText("Corporate AI Gateway"), { target: { value: "Beijing primary" } });
    fireEvent.click(screen.getByRole("button", { name: "Add integration" }));

    await waitFor(() => expect(screen.getByText("tali_integration_one_time_value")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(await screen.findByText("This credential has not been marked as saved")).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Leave and lose key" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(result.integration, false));
  });

  it("uses the shared side sheet and requires the Integration name for protected deletion", () => {
    const item = integration({ name: "Production Gateway" });
    const onConfirm = vi.fn();

    renderWithProviders(<DeleteIntegrationSheet
      integration={item}
      open
      impact={{
        integration_id: item.id,
        integration_name: item.name,
        window_minutes: 30,
        incoming_request_count: 12,
        active_deployment_count: 2,
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

  it("blocks Integration deletion when Runner telemetry is stale", () => {
    const item = integration({ name: "Unobserved Gateway" });
    const onConfirm = vi.fn();

    renderWithProviders(<DeleteIntegrationSheet
      integration={item}
      open
      impact={{
        integration_id: item.id,
        integration_name: item.name,
        window_minutes: 30,
        incoming_request_count: 0,
        active_deployment_count: 0,
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
    expect((screen.getByRole("button", { name: "Delete Integration" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("runs a fresh deletion impact check every time the side sheet is opened", async () => {
    const item = integration({ name: "Production Gateway" });
    const impact = {
      integration_id: item.id,
      integration_name: item.name,
      window_minutes: 30,
      incoming_request_count: 0,
      active_deployment_count: 0,
      active_credential_count: 1,
      last_request_at: null,
      telemetry_fresh: true,
      telemetry_watermark: "2026-08-20T10:00:00Z",
      requires_second_confirmation: false,
      requires_confirmation: false,
    };
    getIntegrationsMock.mockResolvedValue({ items: [item], count: 1 });
    getIntegrationMock.mockResolvedValue(item);
    getIntegrationDeletionImpactMock.mockResolvedValue(impact);

    renderWithProviders(<IntegrationsPage />);

    fireEvent.click(await screen.findByText(item.name));
    fireEvent.click(await screen.findByRole("button", { name: "integrations.deleteAction" }));
    await waitFor(() => expect(getIntegrationDeletionImpactMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByText(item.name));
    fireEvent.click(await screen.findByRole("button", { name: "integrations.deleteAction" }));
    await waitFor(() => expect(getIntegrationDeletionImpactMock).toHaveBeenCalledTimes(2));
  });

  it("passes the required reason and protection confirmation to the delete API", async () => {
    const item = integration({ name: "Retired Gateway" });
    getIntegrationsMock.mockResolvedValue({ items: [item], count: 1 });
    getIntegrationMock.mockResolvedValue(item);
    getIntegrationDeletionImpactMock.mockResolvedValue({
      integration_id: item.id,
      integration_name: item.name,
      window_minutes: 30,
      incoming_request_count: 0,
      active_deployment_count: 0,
      active_credential_count: 1,
      last_request_at: null,
      telemetry_fresh: true,
      telemetry_watermark: "2026-08-20T10:00:00Z",
      requires_second_confirmation: false,
      requires_confirmation: false,
    });
    deleteIntegrationMock.mockResolvedValue(undefined);

    renderWithProviders(<IntegrationsPage />);

    fireEvent.click(await screen.findByText(item.name));
    fireEvent.click(await screen.findByRole("button", { name: "integrations.deleteAction" }));
    await waitFor(() => expect(getIntegrationDeletionImpactMock).toHaveBeenCalledTimes(1));
    fireEvent.change(await screen.findByLabelText("Reason for deletion"), { target: { value: "Gateway contract ended" } });
    const deleteButton = screen.getByRole("button", { name: "Delete Integration" }) as HTMLButtonElement;
    await waitFor(() => expect(deleteButton.disabled).toBe(false));
    fireEvent.click(deleteButton);

    await waitFor(() => expect(deleteIntegrationMock).toHaveBeenCalledWith(item.id, {
      reason: "Gateway contract ended",
      confirm_recent_traffic: false,
    }));
  });
});
