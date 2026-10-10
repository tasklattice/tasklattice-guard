import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Guardrail, GuardrailFindingPage, GuardrailPolicyBinding, GuardrailVersion, GuardrailVersionDetail, Metrics, Policy, TestCase } from "@/lib/api";
import type { TrafficRouter } from "@/lib/traffic-routing-api";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PolicyCatalog } from "../../server/policy-catalog/catalog";
import * as api from "@/lib/api";
import * as controllerApi from "@/lib/controller-api";
import { defaultPolicyBinding } from "@/components/policy-binding-editor";

import { DeleteGuardrailSheet, EditGuardrailTestCasesSheet, EditGuardrailSheet, GuardrailFindingsView, GuardrailRuntimeView, ImmutableVersionView, TestCases } from "./guardrails";
import { EditGuardrailLoggingSheet } from "@/components/edit-guardrail-logging-sheet";

const VERSION_ID = "20260813-080000.000Z";

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => Object.entries(values ?? {}).reduce((label, [name, value]) => `${label} ${name}:${value}`, key),
    i18n: { language: "en", exists: () => false },
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, search }: { children: ReactNode; to?: string; search?: Record<string, string> }) => <a href={`${to ?? "#test"}${search ? `?${new URLSearchParams(search)}` : ""}`}>{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

vi.mock("@/components/dashboard/runtime-health-alert", () => ({ RuntimeHealthAlert: () => null }));
vi.mock("@/components/dashboard/runtime-metric-chart", () => ({ RuntimeMetricChart: () => <div>runtime-chart</div> }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "admin" } }) }));
vi.mock("@/routes/create-guardrail-wizard", () => ({ CreateGuardrailWizard: () => null }));
vi.mock("@/routes/routers", () => ({
  TrafficScopeBadges: ({ router }: { router: TrafficRouter }) => <span>{router.name} scope</span>,
}));

const routerDraft = {
  routes: [{
    id: "route-observed", name: "Observed traffic", kind: "fallback" as const, enabled: true,
    selector: { expression: { combinator: "and" as const, conditions: [] } },
    targets: [{ id: "target-observed", guardrailId: "guardrail-observed", guardrailVersion: VERSION_ID, weightBps: 10000 }],
  }],
};
const router: TrafficRouter = {
  id: "router-observed",
  name: "Observed traffic",
  description: "",
  draftRevision: 1,
  draft: routerDraft,
  activeRevision: 1,
  activeDraftRevision: 1,
  activeSnapshot: routerDraft,
  desiredGeneration: 1,
  rolloutStatus: "active",
  endpointIds: ["endpoint-observed"],
  updatedAt: "2026-08-13T08:00:00Z",
};

const deletableGuardrail = {
  id: "guardrail-live",
  name: "Live Finance Guardrail",
  allowed_topics: [],
  restricted_topics: [],
  policy_bindings: [],
  safety_level: "balanced",
  output_delivery: "window_buffered",
  updated_at: "2026-08-14T08:00:00Z",
  status: "ready",
  latest_validation_run: null,
  router_count: 2,
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
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("loads the Guardrail logging level and recovers from a failed settings request", async () => {
    const load = vi.spyOn(api, "getGuardrailLoggingSettings")
      .mockRejectedValueOnce(new Error("Logging temporarily unavailable"))
      .mockResolvedValue({ guardrail_id: "guardrail-default", level: "info", updated_at: "2026-09-22T00:00:00Z",
        updated_by: null, retention_days: 30, content_capture_enabled: true });
    const save = vi.spyOn(api, "updateGuardrailLoggingSettings");
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><EditGuardrailLoggingSheet guardrailId="guardrail-default" guardrailName="Default Guardrail" onClose={vi.fn()} /></QueryClientProvider>);
    await screen.findByText("Logging temporarily unavailable");
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    const select = await screen.findByRole("combobox", { name: "guardrails.loggingLevel" });
    expect(select.querySelector(".cds--list-box__label")?.textContent).toBe("INFO");
    expect(load).toHaveBeenCalledWith("guardrail-default");
    expect(save).not.toHaveBeenCalled();
  });

  it("requires explicit Save and acknowledgement for elevated logging, and preserves the selection after a failed save", async () => {
    const settings = { guardrail_id: "g1", level: "info" as const, updated_at: "2026-10-10T00:00:00Z", updated_by: null, retention_days: 30, content_capture_enabled: true };
    vi.spyOn(api, "getGuardrailLoggingSettings").mockResolvedValue(settings);
    const save = vi.spyOn(api, "updateGuardrailLoggingSettings").mockRejectedValueOnce(new Error("Save temporarily unavailable")).mockResolvedValue({ ...settings, level: "debug" });
    const close = vi.fn();
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><EditGuardrailLoggingSheet guardrailId="g1" guardrailName="Guardrail" onClose={close} /></QueryClientProvider>);
    const select = await screen.findByRole("combobox", { name: "guardrails.loggingLevel" });
    const submit = screen.getByRole("button", { name: "common.save" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    fireEvent.click(select);
    fireEvent.click(screen.getByRole("option", { name: "DEBUG" }));
    expect(save).not.toHaveBeenCalled();
    expect(submit.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(submit);
    await screen.findByText("Save temporarily unavailable");
    expect(save).toHaveBeenCalledWith("g1", "debug", true);
    expect(close).not.toHaveBeenCalled();
    expect(select.textContent).toContain("DEBUG");
    fireEvent.click(submit);
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("cancels a logging selection without updating runtime settings", async () => {
    vi.spyOn(api, "getGuardrailLoggingSettings").mockResolvedValue({ guardrail_id: "g1", level: "trace", updated_at: "2026-10-10T00:00:00Z", updated_by: null, retention_days: 30, content_capture_enabled: true });
    const save = vi.spyOn(api, "updateGuardrailLoggingSettings");
    const close = vi.fn();
    render(<QueryClientProvider client={new QueryClient()}><EditGuardrailLoggingSheet guardrailId="g1" guardrailName="Guardrail" onClose={close} /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("combobox", { name: "guardrails.loggingLevel" }));
    fireEvent.click(screen.getByRole("option", { name: "INFO" }));
    expect(screen.getByRole("button", { name: "common.save" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    expect(close).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
  });

  it.each(["shortcut", "policy"])("hides Topic Control settings when removed via %s and saves only after explicit Save", async removal => {
    vi.spyOn(controllerApi, "getModelConfiguration").mockResolvedValue({ models: [], active: null, draft: null, activating: null } as unknown as controllerApi.ModelConfigurationView);
    const catalog = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const policies = ["local-credentials", "builtin-topic-safety"].map(id => { const latest = catalog.find(item => item.id === id)!; return id === "builtin-topic-safety" ? latest.published_versions![0]! : latest; });
    const bindings = policies.map(defaultPolicyBinding);
    const guardrail = { ...deletableGuardrail, topic_control_mode: "permissive" as const, policy_bindings: bindings };
    const update = vi.spyOn(api, "updateGuardrail").mockResolvedValue(guardrail);
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><TooltipProvider><EditGuardrailSheet guardrail={guardrail} policies={policies} open onOpenChange={vi.fn()} onSaved={vi.fn()} /></TooltipProvider></QueryClientProvider>);
    const remove = await screen.findByRole("button", { name: "protection.validationReadiness.removeTopic" });
    expect(screen.getByRole("heading", { name: "guardrails.topicAllowlist" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "guardrails.saveDraft" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(removal === "shortcut" ? remove : screen.getByRole("button", { name: `protection.remove name:${policies[1]!.name}` }));
    expect(screen.queryByRole("heading", { name: "guardrails.topicAllowlist" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "topicControl.mode" })).toBeNull();
    expect(update).not.toHaveBeenCalled();
    expect(guardrail.policy_bindings).toEqual(bindings);
    expect(screen.getByRole("button", { name: "guardrails.saveDraft" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "guardrails.saveDraft" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(guardrail.id, expect.objectContaining({ policy_bindings: [bindings[0]] })));
  });

  it("hides retained topic values when reopening a draft without Topic Control", () => {
    const policy = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list().find(item => item.id === "local-credentials")!;
    const guardrail = { ...deletableGuardrail, allowed_topics: ["Kubernetes"], restricted_topics: ["Investments"], policy_bindings: [defaultPolicyBinding(policy)] };
    render(<QueryClientProvider client={new QueryClient()}><TooltipProvider><EditGuardrailSheet guardrail={guardrail} policies={[policy]} open onOpenChange={vi.fn()} onSaved={vi.fn()} /></TooltipProvider></QueryClientProvider>);
    expect(screen.queryByRole("heading", { name: "guardrails.topicAllowlist" })).toBeNull();
    expect(screen.queryByDisplayValue("Kubernetes")).toBeNull();
    expect(screen.queryByDisplayValue("Investments")).toBeNull();
  });

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
        endpoint_id: "endpoint-observed",
        endpoint_name: "Observed LiteLLM",
        router_id: router.id,
        router_name: router.name,
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
        guardrail_versions: [VERSION_ID],
      }],
    } as Metrics;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><GuardrailRuntimeView guardrailId="guardrail-observed" metrics={metrics} loading={false} error={null} routers={[router]} versions={[{
      guardrail_id: "guardrail-observed",
      version: VERSION_ID,
      source_draft_version: 3,
      compiler_version: "tasklattice-nemo-config-v7",
      plan_checksum: "plan-checksum",
      config_checksum: "config-checksum",
      created_at: "2026-08-13T08:00:00Z",
      runtime_engine: "llmrails",
      execution_mode: "nemo_only",
    }]} window="24h" onWindowChange={() => undefined} /></QueryClientProvider>);

    expect(screen.getByText("Observed LiteLLM")).toBeTruthy();
    expect(screen.getByText("Observed traffic")).toBeTruthy();
    expect(screen.getByText("Observed traffic scope")).toBeTruthy();
    expect(screen.getByText(VERSION_ID)).toBeTruthy();
    expect(screen.getByText("runtime-chart")).toBeTruthy();
    expect(screen.getByText("guardrails.runtimeEvidencePrivacyTitle")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "common.close" }));
    expect(screen.queryByText("guardrails.runtimeEvidencePrivacyTitle")).toBeNull();
    expect(screen.getByText("runtime-chart")).toBeTruthy();
  });

  it("aggregates privacy-safe findings from Playground on the Guardrail", () => {
    const data: GuardrailFindingPage = {
      count: 1,
      summary: { total: 1, critical: 1, high: 0, medium: 0, low: 0, informational: 0, unclassified: 0, affected_traces: 1, latest_at: "2026-08-16T09:46:46Z" },
      items: [{
        id: "finding-critical",
        event_id: "event-critical",
        trace_id: "trace-playground",
        created_at: "2026-08-16T09:46:46Z",
        guardrail_id: "guardrail-observed",
        guardrail_version: "20260816-094646.000Z",
        router_id: null,
        endpoint_id: null,
        protocol: "playground",
        phase: "input",
        severity: "critical",
        risk: "builtin_content_filter",
        verdict: "matched",
        confidence: 0.99,
        recommended_action: "block",
        policy_id: "content-safety",
        rule_id: "harmful-request",
        detail: "Policy content-safety matched Rule harmful-request.",
      }],
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><GuardrailFindingsView data={data} loading={false} error={null} policies={[]} routers={[]} endpoints={[]} window="24h" onWindowChange={() => undefined} /></QueryClientProvider>);

    expect(screen.getByRole("region", { name: "guardrails.securityFindingsTitle" })).toBeTruthy();
    expect(screen.getByText("harmful-request")).toBeTruthy();
    expect(screen.getByText("guardrails.playgroundSource")).toBeTruthy();
    expect(screen.getByText("Policy content-safety matched Rule harmful-request.")).toBeTruthy();
    expect(screen.getByText("99%")).toBeTruthy();
    const link = new URL(screen.getByRole("link", { name: "logs.viewLog" }).getAttribute("href")!, "http://localhost");
    expect(link.pathname).toBe("/logs");
    expect(Object.fromEntries(link.searchParams)).toEqual({ eventId: "event-critical", requestId: "trace-playground", checkpointId: "event-critical", guardrailId: "guardrail-observed" });
  });

  it("removes findings with repeated local ids when filtering to an empty severity", async () => {
    const repeatedFinding = {
      id: "model/content-safety",
      created_at: "2026-08-16T09:46:46Z",
      guardrail_id: "guardrail-observed",
      guardrail_version: "20260816-094646.000Z",
      router_id: null,
      endpoint_id: null,
      protocol: "litellm",
      phase: "output" as const,
      severity: "medium" as const,
      risk: "content_safety",
      verdict: "matched",
      confidence: null,
      recommended_action: "block",
      policy_id: "builtin-content-safety",
      rule_id: "model/content-safety",
      detail: "Runner reported an unsafe content-safety finding.",
    };
    const data: GuardrailFindingPage = {
      count: 2,
      summary: { total: 2, critical: 0, high: 0, medium: 2, low: 0, informational: 0, unclassified: 0, affected_traces: 2, latest_at: repeatedFinding.created_at },
      items: [
        { ...repeatedFinding, trace_id: "trace-one" },
        { ...repeatedFinding, trace_id: "trace-two" },
      ],
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { container } = render(<QueryClientProvider client={client}><GuardrailFindingsView data={data} loading={false} error={null} policies={[]} routers={[]} endpoints={[]} window="24h" onWindowChange={() => undefined} /></QueryClientProvider>);

    expect(container.querySelectorAll("article")).toHaveLength(2);
    fireEvent.click(screen.getByRole("combobox", { name: /securityEvents.riskLevel/ }));
    fireEvent.click(screen.getByRole("option", { name: /routerDetail.severity.critical/ }));
    await waitFor(() => expect(container.querySelectorAll("article")).toHaveLength(0));
    expect(screen.getByText("guardrails.noMatchingFindings")).toBeTruthy();

    fireEvent.click(screen.getByRole("option", { name: /routerDetail.severity.medium/ }));
    await waitFor(() => expect(container.querySelectorAll("article")).toHaveLength(2));
  });

  it("keeps scope totals during filter loading and exposes retry without claiming zero events", () => {
    const onRetry = vi.fn();
    const summary = { total: 18, critical: 3, high: 3, medium: 3, low: 3, informational: 3, unclassified: 3, affected_traces: 12, latest_at: null };
    const props = { summary, policies: [], routers: [], endpoints: [], window: "24h" as const, onWindowChange: vi.fn(), severities: ["high" as const], onRetry };
    const view = render(<GuardrailFindingsView {...props} loading error={null} />);
    expect(screen.getByRole("status").textContent).toContain("matched:3 total:18 interactions:12");
    expect(screen.getByText("securityEvents.updating")).toBeTruthy();
    view.rerender(<GuardrailFindingsView {...props} loading={false} error={new Error("Offline")} />);
    fireEvent.click(screen.getByRole("button", { name: "securityEvents.retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.queryByText("guardrails.noSecurityFindings")).toBeNull();
  });

  it("shows the immutable configuration of a version, read only", () => {
    const version: GuardrailVersion = {
      guardrail_id: "guardrail-observed",
      version: VERSION_ID,
      source_draft_version: 3,
      compiler_version: "tasklattice-nemo-config-v6",
      plan_checksum: "plan-checksum",
      created_at: "2026-08-13T08:00:00Z",
      status: "ready",
      released_at: "2026-08-13T08:00:00Z",
      release_run_id: null,
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
    const onChanged = vi.fn().mockResolvedValue(undefined);
    render(<QueryClientProvider client={client}><TooltipProvider><ImmutableVersionView detail={detail} selectedVersion={version} versions={[version]} loading={false} comparisonActive={false} comparisonLoading={false} compareOptions={[]} guardrailId="guardrail-observed" guardrailName="Observed" validation={null} onChanged={onChanged} onOpenDraft={() => undefined} onOpenValidation={() => undefined} onSelectVersion={() => undefined} onStartCompare={() => undefined} onCompareBaseChange={() => undefined} onCloseCompare={() => undefined} /></TooltipProvider></QueryClientProvider>);

    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: `immutableVersions.view version:${VERSION_ID}` }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /immutableVersions.policies/ }));
    expect(screen.getByText("pii")).toBeTruthy();
    // Each Policy opens the exact version this snapshot was built from.
    expect(screen.getByText("pii").closest("a")?.getAttribute("href")).toBe("/policy-library?policy=pii&version=1.95.0");
    fireEvent.click(screen.getByRole("tab", { name: "immutableVersions.compiled" }));
    expect(screen.getByText("guardrails.compiledRailsActions")).toBeTruthy();
    expect(screen.getByText("guardrails.dependenciesModels")).toBeTruthy();

    const generatedFilesTab = screen.getByRole("tab", { name: /immutableVersions.files/ });
    fireEvent.click(generatedFilesTab, { button: 0, ctrlKey: false });
    fireEvent.mouseUp(generatedFilesTab, { button: 0, ctrlKey: false });
    fireEvent.click(generatedFilesTab);
    expect(screen.getAllByText("config.yml").length).toBeGreaterThan(0);
    expect(screen.getByRole("dialog").textContent).toContain("immutableVersions.readOnly");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("groups inherited and Guardrail-specific Test Cases by source and keeps groups collapsed", () => {
    const bindings = [
      { policy_id: "policy-one", policy_version: "1.0.0", enabled_rule_ids: ["rule-1", "rule-2"], enabled_rails: ["input"] },
      { policy_id: "policy-two", policy_version: "2.0.0", enabled_rule_ids: ["rule-3"], enabled_rails: ["input"] },
    ] as GuardrailPolicyBinding[];
    const policies = [
      { id: "policy-one", version: "1.0.0", name: "First Policy" },
      { id: "policy-two", version: "2.0.0", name: "Second Policy" },
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


  it.each(["exclude", "restore"] as const)("preserves confirmation, error recovery and refresh when Testing will %s an inherited case", async (action) => {
    const testCase = {
      id: "case-inherited", name: "Inherited case", guardrail_id: deletableGuardrail.id, policy_id: "policy-one",
      phase: "input", content: "reviewed content", expected_decision: "block", updated_at: "2026-08-13T08:00:00Z",
      trusted_instruction: "", target_source: "user_input", query: "", grounding_sources: [], expected_reasoning_result: null,
      case_type: "rule_acceptance", required: true, excluded: action === "restore", origin: "generated",
      source_policy_id: "policy-one", source_policy_version: "1.0.0", source_case_id: "source-1", covered_rule_ids: ["rule-1"],
    } satisfies TestCase;
    const mutate = vi.spyOn(api, action === "exclude" ? "excludeGuardrailTestCase" : "restoreGuardrailTestCase")
      .mockRejectedValueOnce(new Error("Scope temporarily unavailable"))
      .mockResolvedValue({ ...testCase, excluded: action === "exclude" });
    const onChanged = vi.fn();
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}><EditGuardrailTestCasesSheet guardrail={deletableGuardrail} policies={[]} cases={[testCase]} casesLoading={false} onClose={vi.fn()} onChanged={onChanged} onRetryCases={vi.fn()} /></QueryClientProvider>);
    fireEvent.click(screen.getByTestId("test-source-policy:policy-one").querySelector("summary")!);
    const label = action === "exclude" ? "guardrails.excludeTestCase" : "guardrails.restoreTestCase";
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "common.cancel" }));
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: label }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: label }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("Scope temporarily unavailable");
    expect(onChanged).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: label }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(mutate).toHaveBeenLastCalledWith(deletableGuardrail.id, testCase.id);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "guardrails.testCaseSources" })).toBeTruthy();
  });

  it("offers retry for unavailable test cases in the editor", () => {
    const onRetryCases = vi.fn();
    const props = { guardrail: deletableGuardrail, policies: [], cases: [], casesLoading: false, onClose: vi.fn(), onChanged: vi.fn(), onRetryCases };
    const client = new QueryClient();
    const view = render(<QueryClientProvider client={client}><EditGuardrailTestCasesSheet {...props} casesError={new Error("Cases unavailable")} /></QueryClientProvider>);
    expect(screen.getByText("Cases unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    expect(onRetryCases).toHaveBeenCalledOnce();
    view.rerender(<QueryClientProvider client={client}><EditGuardrailTestCasesSheet {...props} /></QueryClientProvider>);
    fireEvent.click(screen.getByTestId("test-source-guardrail:custom").querySelector("summary")!);
    expect(screen.getByRole("button", { name: "guardrails.addTestCase" })).toBeTruthy();
  });

  it("edits custom cases in one drawer with append and confirmed deletion, without inherited-case exclusion", async () => {
    const testCase = {
      id: "custom-one", name: "Custom case", guardrail_id: deletableGuardrail.id, policy_id: "policy-one",
      phase: "input", content: "custom content", expected_decision: "block", updated_at: "2026-10-08T00:00:00Z",
      trusted_instruction: "", target_source: "user_input", query: "", grounding_sources: [], expected_reasoning_result: null,
      case_type: "custom", required: true, excluded: false, origin: "custom",
      source_policy_id: null, source_policy_version: null, source_case_id: null, covered_rule_ids: [],
    } satisfies TestCase;
    const remove = vi.spyOn(api, "deleteTestCase").mockResolvedValue();
    const changed = vi.fn(async () => {});
    render(<QueryClientProvider client={new QueryClient()}><EditGuardrailTestCasesSheet guardrail={deletableGuardrail} policies={[]} cases={[testCase]} casesLoading={false} onClose={vi.fn()} onChanged={changed} onRetryCases={vi.fn()} /></QueryClientProvider>);
    fireEvent.click(screen.getByTestId("test-source-guardrail:custom").querySelector("summary")!);
    expect(screen.queryByRole("button", { name: "guardrails.excludeTestCase" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "guardrails.addTestCase" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: "guardrails.caseName" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    fireEvent.click(screen.getByTestId("test-source-guardrail:custom").querySelector("summary")!);
    fireEvent.click(screen.getByRole("button", { name: "guardrails.deleteCustomCase" }));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("test-source-guardrail:custom").querySelector("summary")!);
    fireEvent.click(screen.getByRole("button", { name: "guardrails.deleteCustomCase" }));
    fireEvent.click(screen.getByRole("button", { name: "guardrails.deleteCustomCase" }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(remove).toHaveBeenCalledWith(deletableGuardrail.id, testCase.id);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });


  it("edits Topic Control without requiring a Guardrail business purpose", () => {
    const topicGuardrail = {
      ...deletableGuardrail,
      allowed_topics: [],
      restricted_topics: ["legacy restricted topic"],
      policy_bindings: [{
        policy_id: "builtin-topic-safety",
        policy_version: "1.0.0",
        action: "block",
        parameter_values: {},
        enabled_rule_ids: ["model/topic-control"],
        rule_actions: {},
        enabled_rails: ["input"],
        reasoning_policy: null,
      }],
    } satisfies Guardrail;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    render(<QueryClientProvider client={client}><TooltipProvider><EditGuardrailSheet guardrail={topicGuardrail} policies={[]} open onOpenChange={vi.fn()} onSaved={vi.fn()} /></TooltipProvider></QueryClientProvider>);

    expect(screen.queryByText("guardrails.businessPurpose")).toBeNull();
    expect(screen.queryByDisplayValue("Support account operations.")).toBeNull();
    expect(screen.queryByText("guardrails.businessPurposeLocked")).toBeNull();
    expect(screen.getByText("guardrails.topicAllowlist")).toBeTruthy();
    expect(screen.getByText("guardrails.topicAllowlistRequired")).toBeTruthy();
    expect(screen.queryByText("guardrails.restrictedDomains")).toBeNull();
    expect(screen.getByDisplayValue("legacy restricted topic")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "topicControl.mode" }), { target: { value: "permissive" } });
    expect(screen.queryByText("guardrails.topicAllowlistRequired")).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "topicControl.mode" }), { target: { value: "strict" } });
    expect(screen.getByRole("button", { name: "guardrails.saveDraft" }).hasAttribute("disabled")).toBe(true);
  });



  it("reorders saved draft Policies without losing pinned versions, Rule order or local overrides", async () => {
    const catalog = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const policies = ["configured-phrase-filter", "local-credentials"].map(id => catalog.find(p => p.id === id)!);
    const bindings = policies.map(defaultPolicyBinding);
    bindings[0]!.parameter_values = { phrase_entries: JSON.stringify([{ id: "private-phrase", phrase: "confidential", action: "block" }]) };
    bindings[1]!.rule_order = [...bindings[1]!.enabled_rule_ids].reverse();
    bindings[1]!.rule_actions = { [bindings[1]!.enabled_rule_ids[0]!]: "transform" };
    const original = structuredClone(bindings);
    const guardrail = { ...deletableGuardrail, output_delivery: "full_buffered" as const, policy_bindings: bindings };
    const update = vi.spyOn(api, "updateGuardrail").mockResolvedValue(guardrail);
    const onSaved = vi.fn();
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}><TooltipProvider><EditGuardrailSheet guardrail={guardrail} policies={policies} open onOpenChange={vi.fn()} onSaved={onSaved} /></TooltipProvider></QueryClientProvider>);
    const order = screen.getByRole("list", { name: "protection.order" });
    expect(within(order).getAllByRole("listitem").map(item => item.textContent)).toEqual([
      expect.stringContaining(policies[0]!.name), expect.stringContaining(policies[1]!.name),
    ]);
    expect(screen.getByRole("button", { name: `protection.moveUp name:${policies[0]!.name}` }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: `protection.moveUp name:${policies[1]!.name}` }));
    expect(within(order).getAllByRole("listitem").map(item => item.textContent)).toEqual([
      expect.stringContaining(policies[1]!.name), expect.stringContaining(policies[0]!.name),
    ]);
    expect(update).not.toHaveBeenCalled();
    expect(bindings).toEqual(original);
    fireEvent.click(screen.getByRole("button", { name: "guardrails.saveDraft" }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update).toHaveBeenCalledWith(guardrail.id, expect.objectContaining({ policy_bindings: [original[1], original[0]], output_delivery: "full_buffered" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  });

  it("blocks saving incomplete Policy-owned phrases and recovers when filled", () => {
    const policy = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list().find(item => item.id === "configured-phrase-filter")!;
    const guardrail: Guardrail = { ...deletableGuardrail, policy_bindings: [{
      policy_id: policy.id, policy_version: policy.version, action: null,
      parameter_values: { phrase_entries: JSON.stringify([{ id: "entry", phrase: "", action: "block" }]) },
      enabled_rule_ids: ["configured/phrases"], rule_actions: {}, enabled_rails: ["input", "output"], reasoning_policy: null,
    }] };
    const client = new QueryClient();
    render(<QueryClientProvider client={client}><TooltipProvider><EditGuardrailSheet guardrail={guardrail} policies={[policy]} open onOpenChange={vi.fn()} onSaved={vi.fn()} /></TooltipProvider></QueryClientProvider>);
    expect(screen.getByRole("button", { name: "guardrails.saveDraft" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("Phrases and actions");
    fireEvent.change(screen.getByRole("textbox", { name: "protection.phrases.match index:1" }), { target: { value: "confidential" } });
    expect(screen.getByRole("button", { name: "guardrails.saveDraft" }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("deletes directly after impact review when there was no recent incoming traffic", () => {
    const onConfirm = vi.fn();
    render(<DeleteGuardrailSheet guardrail={deletableGuardrail} open impact={{ guardrail_id: deletableGuardrail.id, guardrail_name: deletableGuardrail.name, window_minutes: 30, incoming_request_count: 0, last_request_at: null, active_router_count: 2, telemetry_fresh: true, telemetry_watermark: "2026-08-20T10:00:00Z", requires_second_confirmation: false, requires_confirmation: false }} loading={false} deleting={false} error={null} onOpenChange={vi.fn()} onRetry={vi.fn()} onConfirm={onConfirm} />);

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
    render(<DeleteGuardrailSheet guardrail={deletableGuardrail} open impact={{ guardrail_id: deletableGuardrail.id, guardrail_name: deletableGuardrail.name, window_minutes: 30, incoming_request_count: 17, last_request_at: "2026-08-20T09:58:00Z", active_router_count: 2, telemetry_fresh: true, telemetry_watermark: "2026-08-20T10:00:00Z", requires_second_confirmation: true, requires_confirmation: true }} loading={false} deleting={false} error={null} onOpenChange={vi.fn()} onRetry={vi.fn()} onConfirm={onConfirm} />);

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
    render(<DeleteGuardrailSheet guardrail={deletableGuardrail} open impact={{ guardrail_id: deletableGuardrail.id, guardrail_name: deletableGuardrail.name, window_minutes: 30, incoming_request_count: 0, last_request_at: null, active_router_count: 0, telemetry_fresh: false, telemetry_watermark: null, requires_second_confirmation: false, requires_confirmation: false }} loading={false} deleting={false} error={null} onOpenChange={vi.fn()} onRetry={vi.fn()} onConfirm={onConfirm} />);

    fireEvent.change(screen.getByLabelText("guardrails.deleteReason"), { target: { value: "No longer needed" } });
    expect(screen.getByText("guardrails.deleteTelemetryStale")).toBeTruthy();
    expect((screen.getByRole("button", { name: "guardrails.deleteConfirm" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
