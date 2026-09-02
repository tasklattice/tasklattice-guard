import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Deployment, Guardrail, GuardrailFindingPage, GuardrailPolicyBinding, GuardrailVersion, GuardrailVersionDetail, Metrics, Policy, TestCase } from "@/lib/api";
import { TooltipProvider } from "@/components/ui/tooltip";

import { DeleteGuardrailSheet, DraftReleaseView, GuardrailFindingsView, GuardrailRuntimeView, ImmutableVersionView, TestCases } from "./guardrails";

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => Object.entries(values ?? {}).reduce((label, [name, value]) => `${label} ${name}:${value}`, key),
    i18n: { language: "en", exists: () => false },
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#test">{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

vi.mock("@/components/dashboard/runtime-health-alert", () => ({ RuntimeHealthAlert: () => null }));
vi.mock("@/components/dashboard/runtime-metric-chart", () => ({ RuntimeMetricChart: () => <div>runtime-chart</div> }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "admin" } }) }));
vi.mock("@/routes/create-guardrail-wizard", () => ({ CreateGuardrailWizard: () => null }));
vi.mock("@/routes/deployments", () => ({
  CreateDeploymentSheet: () => null,
  TrafficScopeBadges: ({ deployment }: { deployment: Deployment }) => <span>{deployment.name} scope</span>,
}));

const deployment: Deployment = {
  id: "deployment-observed",
  name: "Observed traffic",
  guardrail_id: "guardrail-observed",
  guardrail_version: 2,
  integration_id: "integration-observed",
  route_order: 1,
  traffic_scope: { combinator: "and", conditions: [{ field: "protocol", operator: "equals", value: "litellm" }] },
  enabled: true,
  is_default: false,
  system_managed: false,
  updated_at: "2026-08-13T08:00:00Z",
};

const deletableGuardrail = {
  id: "guardrail-live",
  name: "Live Finance Guardrail",
  purpose: "Protect live Finance traffic.",
  allowed_topics: [],
  restricted_topics: [],
  policy_bindings: [],
  safety_level: "balanced",
  output_delivery: "window_buffered",
  updated_at: "2026-08-14T08:00:00Z",
  status: "protected",
  latest_validation_run: null,
  deployment_count: 2,
  test_case_count: 0,
  excluded_test_case_count: 0,
  excluded_test_case_ids: [],
  tested_current: true,
  published_current: true,
  is_default: false,
  system_managed: false,
  local_only: false,
  coverage: [],
} satisfies Guardrail;

describe("Guardrail detail information hierarchy", () => {
  afterEach(cleanup);

  it("makes caller distribution the primary runtime evidence", () => {
    const metrics = {
      total_decisions: 40,
      intervention_rate: 12.5,
      blocked: 4,
      intervened: 1,
      runtime_p95_ms: 86,
      error_rate: 2.5,
      errors: 1,
      caller_distribution: [{
        integration_id: "integration-observed",
        integration_name: "Observed LiteLLM",
        deployment_id: deployment.id,
        deployment_name: deployment.name,
        protocol: "litellm",
        requests: 40,
        share: 100,
        allowed: 34,
        blocked: 4,
        intervened: 1,
        errors: 1,
        intervention_rate: 12.5,
        error_rate: 2.5,
        p95_latency_ms: 86,
        guardrail_versions: [2],
      }],
    } as Metrics;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><GuardrailRuntimeView guardrailId="guardrail-observed" metrics={metrics} loading={false} error={null} deployments={[deployment]} versions={[{
      guardrail_id: "guardrail-observed",
      version: 2,
      source_draft_version: 3,
      compiler_version: "tasklattice-nemo-config-v7",
      plan_checksum: "plan-checksum",
      config_checksum: "config-checksum",
      created_at: "2026-08-13T08:00:00Z",
      active: true,
      runtime_engine: "llmrails",
      execution_mode: "nemo_only",
    }]} window="24h" onWindowChange={() => undefined} /></QueryClientProvider>);

    expect(screen.getByText("Observed LiteLLM")).toBeTruthy();
    expect(screen.getByText("Observed traffic")).toBeTruthy();
    expect(screen.getByText("Observed traffic scope")).toBeTruthy();
    expect(screen.getByText("20260813-080000Z")).toBeTruthy();
    expect(screen.getByText("runtime-chart")).toBeTruthy();
  });

  it("aggregates privacy-safe findings from Playground on the Guardrail", () => {
    const data: GuardrailFindingPage = {
      count: 1,
      summary: { total: 1, critical: 1, high: 0, medium: 0, low: 0, affected_traces: 1, latest_at: "2026-08-16T09:46:46Z" },
      items: [{
        id: "finding-critical",
        trace_id: "trace-playground",
        created_at: "2026-08-16T09:46:46Z",
        guardrail_id: "guardrail-observed",
        guardrail_version: 4,
        deployment_id: null,
        integration_id: null,
        protocol: "playground",
        phase: "input",
        severity: "critical",
        risk: "builtin_content_filter",
        verdict: "unsafe",
        confidence: 0.99,
        recommended_action: "reject",
        policy_id: "content-safety",
        rule_id: "harmful-request",
        detail: "Policy content-safety matched Rule harmful-request.",
      }],
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><GuardrailFindingsView data={data} loading={false} error={null} policies={[]} deployments={[]} integrations={[]} window="24h" onWindowChange={() => undefined} /></QueryClientProvider>);

    expect(screen.getByText("guardrails.securityFindingsTitle")).toBeTruthy();
    expect(screen.getByText("harmful-request")).toBeTruthy();
    expect(screen.getByText("guardrails.playgroundSource")).toBeTruthy();
    expect(screen.getByText("Policy content-safety matched Rule harmful-request.")).toBeTruthy();
    expect(screen.getByText("99%")).toBeTruthy();
  });

  it("shows immutable configuration before the unified compiled runtime", () => {
    const version: GuardrailVersion = {
      guardrail_id: "guardrail-observed",
      version: 2,
      source_draft_version: 3,
      compiler_version: "tasklattice-nemo-config-v6",
      plan_checksum: "plan-checksum",
      created_at: "2026-08-13T08:00:00Z",
      active: true,
      runtime_engine: "llmrails",
      config_checksum: "config-checksum",
      execution_mode: "nemo_only",
    };
    const detail: GuardrailVersionDetail = {
      ...version,
      safety_level: "balanced",
      output_delivery: "window_buffered",
      runtime_profile: "llmrails_colang2_programmable",
      colang_version: "2.x",
      rails: [{ rail_type: "input", flow: "protect input" }],
      actions: [],
      models: ["content_safety"],
      features: [],
      dependencies: [{ kind: "policy", name: "pii", version: "1.95.0" }],
      estimated_critical_path_ms: 100,
      policy_bindings: [{ policy_id: "pii", policy_version: "1.95.0", action: "block", enabled_rule_ids: ["email"], enabled_rails: ["input"] }],
      artifacts: [{ path: "config.yml", language: "yaml", content: "rails:\n  input: protect input" }],
    };

    const client = new QueryClient();
    render(<QueryClientProvider client={client}><TooltipProvider><ImmutableVersionView detail={detail} selectedVersion={version} versions={[version]} loading={false} comparisonActive={false} comparisonLoading={false} compareOptions={[]} guardrailId="guardrail-observed" validation={null} onChanged={async () => undefined} onOpenDraft={() => undefined} onSelectVersion={() => undefined} onStartCompare={() => undefined} onCompareBaseChange={() => undefined} onCloseCompare={() => undefined} /></TooltipProvider></QueryClientProvider>);

    const configuration = screen.getAllByText("20260813-080000Z")[1];
    const compiledRuntime = screen.getByText("guardrails.compiledRuntime");
    expect(configuration.compareDocumentPosition(compiledRuntime) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("pii@1.95.0")).toBeTruthy();
    expect(screen.getByText("guardrails.compiledRailsActions")).toBeTruthy();
    expect(screen.getByText("guardrails.dependenciesModels")).toBeTruthy();

    const generatedFilesTab = screen.getByRole("tab", { name: "guardrails.generatedFilesTab count:1" });
    fireEvent.mouseDown(generatedFilesTab, { button: 0, ctrlKey: false });
    fireEvent.mouseUp(generatedFilesTab, { button: 0, ctrlKey: false });
    fireEvent.click(generatedFilesTab);
    expect(screen.getAllByText("config.yml").length).toBeGreaterThan(0);
  });

  it("groups inherited and Guardrail-specific Test Cases by source and keeps groups collapsed", () => {
    const bindings = [
      { policy_id: "policy-one", policy_version: "1.0.0", enabled_rule_ids: ["rule-1", "rule-2"], enabled_rails: ["input"] },
      { policy_id: "policy-two", policy_version: "2.0.0", enabled_rule_ids: ["rule-3"], enabled_rails: ["input"] },
    ] as GuardrailPolicyBinding[];
    const policies = [
      { id: "policy-one", name: "First Policy" },
      { id: "policy-two", name: "Second Policy" },
    ] as Policy[];
    const baseCase = {
      guardrail_id: "guardrail-observed",
      phase: "input",
      content: "reviewed content",
      expected_decision: "transform",
      updated_at: "2026-08-13T08:00:00Z",
      trusted_instruction: "",
      target_source: "user_input",
      query: "",
      grounding_sources: [],
      expected_reasoning_result: null,
      case_type: "rule_acceptance",
      required: true,
      excluded: false,
    } satisfies Partial<TestCase>;
    const cases = [
      { ...baseCase, id: "case-1", name: "First inherited Case", policy_id: "policy-one", origin: "generated", source_policy_id: "policy-one", source_policy_version: "1.0.0", source_case_id: "source-1", covered_rule_ids: ["rule-1"] },
      { ...baseCase, id: "case-2", name: "Second inherited Case", policy_id: "policy-one", origin: "generated", source_policy_id: "policy-one", source_policy_version: "1.0.0", source_case_id: "source-2", covered_rule_ids: ["rule-2"], excluded: true },
      { ...baseCase, id: "case-3", name: "Other Policy Case", policy_id: "policy-two", origin: "generated", source_policy_id: "policy-two", source_policy_version: "2.0.0", source_case_id: "source-3", covered_rule_ids: ["rule-3"] },
      { ...baseCase, id: "case-4", name: "Guardrail regression Case", policy_id: "policy-one", origin: "custom", source_policy_id: null, source_policy_version: null, source_case_id: null, covered_rule_ids: [] },
    ] as TestCase[];
    const onAdd = vi.fn();
    const onExclude = vi.fn();
    const onRestore = vi.fn();

    render(<TestCases cases={cases} bindings={bindings} policies={policies} loading={false} onAdd={onAdd} onExclude={onExclude} onRestore={onRestore} />);

    expect(screen.getByText("First Policy")).toBeTruthy();
    expect(screen.getByText("Second Policy")).toBeTruthy();
    expect(screen.getByText("guardrails.guardrailCustomTests")).toBeTruthy();
    expect(screen.getByText(/inherited:2 policies:2 custom:1/)).toBeTruthy();
    expect(screen.getByText(/guardrails\.excludedTestCount count:1/)).toBeTruthy();

    const firstPolicyGroup = screen.getByTestId("test-source-policy:policy-one") as HTMLDetailsElement;
    const secondPolicyGroup = screen.getByTestId("test-source-policy:policy-two") as HTMLDetailsElement;
    const customGroup = screen.getByTestId("test-source-guardrail:custom") as HTMLDetailsElement;
    expect(firstPolicyGroup.open).toBe(false);
    expect(secondPolicyGroup.open).toBe(false);
    expect(customGroup.open).toBe(false);

    fireEvent.click(firstPolicyGroup.querySelector("summary")!);
    expect(firstPolicyGroup.open).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "guardrails.restoreTestCase" }));
    expect(onRestore).toHaveBeenCalledWith("case-2");
    fireEvent.click(screen.getAllByRole("button", { name: "guardrails.excludeTestCase" })[0]);
    expect(onExclude).toHaveBeenCalledWith("case-1");
    fireEvent.click(customGroup.querySelector("summary")!);
    expect(customGroup.open).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "guardrails.addTestCase" }));
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it("requires explicit publication after Validation passes", () => {
    const validatedGuardrail = {
      id: "guardrail-release",
      name: "Release Guardrail",
      purpose: "Protect the release workflow.",
      allowed_topics: [],
      restricted_topics: [],
      policy_bindings: [{ policy_id: "policy-one", policy_version: "1.0.0", parameter_values: {}, enabled_rule_ids: ["rule-1"], rule_actions: {}, enabled_rails: ["input"] }],
      safety_level: "balanced",
      output_delivery: "window_buffered",
      updated_at: "2026-08-14T08:00:00Z",
      status: "ready",
      latest_validation_run: {
        id: "validation-release",
        guardrail_id: "guardrail-release",
        guardrail_version: null,
        source_draft_version: 2,
        status: "passed",
        created_at: "2026-08-14T08:00:00Z",
        metrics: { total: 5, passed: 5, compliance_rate: 100, false_positive_rate: 0, false_negative_rate: 0, deep_escalation_rate: 0, p95_latency_ms: 20 },
        results: [],
        excluded_case_ids: [],
      },
      deployment_count: 0,
      test_case_count: 5,
      excluded_test_case_count: 0,
      excluded_test_case_ids: [],
      tested_current: true,
      published_current: false,
      is_default: false,
      system_managed: false,
      local_only: false,
      coverage: [],
    } satisfies Guardrail;
    const client = new QueryClient();
    const onOpenValidation = vi.fn();
    const props = { guardrail: validatedGuardrail, policies: [], cases: [], casesLoading: false, activeVersion: undefined, deployments: [], onOpenValidation, onEdit: vi.fn(), onAddCase: vi.fn(), onCreateDeployment: vi.fn(), onChanged: async () => undefined };

    const view = render(<QueryClientProvider client={client}><DraftReleaseView {...props} /></QueryClientProvider>);
    expect(screen.getByRole("button", { name: "guardrails.publishVersion" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "guardrails.createDeployment" })).toBeNull();
    expect(screen.queryByRole("link", { name: "guardrails.openValidation" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "guardrails.openValidation" }));
    expect(onOpenValidation).toHaveBeenCalledWith(validatedGuardrail.latest_validation_run);

    view.rerender(<QueryClientProvider client={client}><DraftReleaseView {...props} guardrail={{ ...validatedGuardrail, published_current: true }} activeVersion={{ guardrail_id: validatedGuardrail.id, version: 1, source_draft_version: 2, compiler_version: "compiler", plan_checksum: "plan", config_checksum: "config", created_at: "2026-08-14T08:00:00Z", active: true, runtime_engine: "llmrails", execution_mode: "nemo_only" }} /></QueryClientProvider>);
    expect(screen.queryByRole("button", { name: "guardrails.publishVersion" })).toBeNull();
    expect(screen.getByRole("button", { name: "guardrails.createDeployment" })).toBeTruthy();
  });

  it("lets the Default Guardrail edit and validate its draft without creating another Deployment", () => {
    const defaultGuardrail = {
      id: "guardrail-default",
      name: "Default Guardrail",
      purpose: "Protect unmatched traffic.",
      allowed_topics: [],
      restricted_topics: [],
      policy_bindings: [{ policy_id: "builtin-secrets", policy_version: "1", parameter_values: {}, enabled_rule_ids: [], rule_actions: {}, enabled_rails: ["input", "output"] }],
      safety_level: "balanced",
      output_delivery: "window_buffered",
      updated_at: "2026-08-14T08:00:00Z",
      status: "needs_validation",
      latest_validation_run: null,
      deployment_count: 1,
      test_case_count: 1,
      excluded_test_case_count: 0,
      excluded_test_case_ids: [],
      tested_current: false,
      published_current: false,
      is_default: true,
      system_managed: true,
      local_only: true,
      coverage: [],
    } satisfies Guardrail;
    const client = new QueryClient();
    const onEdit = vi.fn();
    const onRunValidation = vi.fn();

    render(<QueryClientProvider client={client}><DraftReleaseView guardrail={defaultGuardrail} policies={[]} cases={[]} casesLoading={false} deployments={[]} onRunValidation={onRunValidation} onEdit={onEdit} onAddCase={vi.fn()} onCreateDeployment={vi.fn()} onChanged={async () => undefined} /></QueryClientProvider>);

    expect(screen.queryByRole("link", { name: "guardrails.runReviewed" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "guardrails.runReviewed" }));
    expect(onRunValidation).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "common.edit" }));
    expect(onEdit).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "guardrails.createDeployment" })).toBeNull();
  });

  it("deletes directly after impact review when there was no recent incoming traffic", () => {
    const onConfirm = vi.fn();
    render(<DeleteGuardrailSheet guardrail={deletableGuardrail} open impact={{ guardrail_id: deletableGuardrail.id, guardrail_name: deletableGuardrail.name, window_minutes: 30, incoming_request_count: 0, last_request_at: null, active_deployment_count: 2, telemetry_fresh: true, telemetry_watermark: "2026-08-20T10:00:00Z", requires_second_confirmation: false, requires_confirmation: false }} loading={false} deleting={false} error={null} onOpenChange={vi.fn()} onRetry={vi.fn()} onConfirm={onConfirm} />);

    expect(screen.getByText("guardrails.deleteRetentionNote")).toBeTruthy();
    const deleteButton = screen.getByRole("button", { name: "guardrails.deleteConfirm" }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("guardrails.deleteReason"), { target: { value: "Retiring a duplicate policy" } });
    expect(deleteButton.disabled).toBe(false);
    fireEvent.click(deleteButton);

    expect(onConfirm).toHaveBeenCalledWith({ reason: "Retiring a duplicate policy", confirm_recent_traffic: false });
  });

  it("requires the Guardrail name in a second confirmation when traffic is recent", () => {
    const onConfirm = vi.fn();
    render(<DeleteGuardrailSheet guardrail={deletableGuardrail} open impact={{ guardrail_id: deletableGuardrail.id, guardrail_name: deletableGuardrail.name, window_minutes: 30, incoming_request_count: 17, last_request_at: "2026-08-20T09:58:00Z", active_deployment_count: 2, telemetry_fresh: true, telemetry_watermark: "2026-08-20T10:00:00Z", requires_second_confirmation: true, requires_confirmation: true }} loading={false} deleting={false} error={null} onOpenChange={vi.fn()} onRetry={vi.fn()} onConfirm={onConfirm} />);

    const continueButton = screen.getByRole("button", { name: "guardrails.continueDelete" }) as HTMLButtonElement;
    expect(continueButton.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("guardrails.deleteReason"), { target: { value: "Replacing the active Guardrail" } });
    expect(continueButton.disabled).toBe(false);
    fireEvent.click(continueButton);
    expect(screen.getByText("guardrails.deleteRecentTrafficTitle")).toBeTruthy();
    const finalDelete = screen.getByRole("button", { name: "guardrails.deleteDespiteTraffic" }) as HTMLButtonElement;
    expect(finalDelete.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(`guardrails.typeNameToConfirm name:${deletableGuardrail.name}`), { target: { value: deletableGuardrail.name } });
    expect(finalDelete.disabled).toBe(false);
    fireEvent.click(finalDelete);

    expect(onConfirm).toHaveBeenCalledWith({ reason: "Replacing the active Guardrail", confirm_recent_traffic: true, confirmation_name: deletableGuardrail.name });
  });

  it("blocks deletion when the protection check telemetry is stale", () => {
    const onConfirm = vi.fn();
    render(<DeleteGuardrailSheet guardrail={deletableGuardrail} open impact={{ guardrail_id: deletableGuardrail.id, guardrail_name: deletableGuardrail.name, window_minutes: 30, incoming_request_count: 0, last_request_at: null, active_deployment_count: 0, telemetry_fresh: false, telemetry_watermark: null, requires_second_confirmation: false, requires_confirmation: false }} loading={false} deleting={false} error={null} onOpenChange={vi.fn()} onRetry={vi.fn()} onConfirm={onConfirm} />);

    fireEvent.change(screen.getByLabelText("guardrails.deleteReason"), { target: { value: "No longer needed" } });
    expect(screen.getByText("guardrails.deleteTelemetryStale")).toBeTruthy();
    expect((screen.getByRole("button", { name: "guardrails.deleteConfirm" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
