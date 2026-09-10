import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Router, Guardrail, GuardrailFindingPage, GuardrailPolicyBinding, GuardrailVersion, GuardrailVersionDetail, Metrics, Policy, TestCase } from "@/lib/api";
import { TooltipProvider } from "@/components/ui/tooltip";
import { defaultGuardrailDraft, DEFAULT_GUARDRAIL_ID } from "../../server/domain/defaults";
import { PolicyCatalog } from "../../server/policy-catalog/catalog";
import * as api from "@/lib/api";
import { defaultPolicyBinding } from "@/components/policy-binding-editor";

import { DeleteGuardrailSheet, DraftReleaseView, EditGuardrailSheet, GuardrailFindingsView, GuardrailRuntimeView, ImmutableVersionView, TestCases } from "./guardrails";

const VERSION_ID = "20260813-080000.000Z";

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
vi.mock("@/routes/routers", () => ({
  CreateRouterSheet: () => null,
  TrafficScopeBadges: ({ router }: { router: Router }) => <span>{router.name} scope</span>,
}));

const router: Router = {
  id: "router-observed",
  name: "Observed traffic",
  guardrail_id: "guardrail-observed",
  guardrail_version: VERSION_ID,
  endpoint_id: "endpoint-observed",
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
  allowed_topics: [],
  restricted_topics: [],
  policy_bindings: [],
  safety_level: "balanced",
  output_delivery: "window_buffered",
  updated_at: "2026-08-14T08:00:00Z",
  status: "protected",
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
      active: true,
      runtime_engine: "llmrails",
      execution_mode: "nemo_only",
    }]} window="24h" onWindowChange={() => undefined} /></QueryClientProvider>);

    expect(screen.getByText("Observed LiteLLM")).toBeTruthy();
    expect(screen.getByText("Observed traffic")).toBeTruthy();
    expect(screen.getByText("Observed traffic scope")).toBeTruthy();
    expect(screen.getByText(VERSION_ID)).toBeTruthy();
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
        guardrail_version: "20260816-094646.000Z",
        router_id: null,
        endpoint_id: null,
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

    render(<QueryClientProvider client={client}><GuardrailFindingsView data={data} loading={false} error={null} policies={[]} routers={[]} endpoints={[]} window="24h" onWindowChange={() => undefined} /></QueryClientProvider>);

    expect(screen.getByText("guardrails.securityFindingsTitle")).toBeTruthy();
    expect(screen.getByText("harmful-request")).toBeTruthy();
    expect(screen.getByText("guardrails.playgroundSource")).toBeTruthy();
    expect(screen.getByText("Policy content-safety matched Rule harmful-request.")).toBeTruthy();
    expect(screen.getByText("99%")).toBeTruthy();
  });

  it("removes findings with repeated local ids when filtering to an empty severity", () => {
    const repeatedFinding = {
      id: "model/content-safety",
      created_at: "2026-08-16T09:46:46Z",
      guardrail_id: "guardrail-observed",
      guardrail_version: "20260816-094646.000Z",
      router_id: null,
      endpoint_id: null,
      protocol: "http",
      phase: "output" as const,
      severity: "medium" as const,
      risk: "content_safety",
      verdict: "unsafe",
      confidence: null,
      recommended_action: "reject",
      policy_id: "builtin-content-safety",
      rule_id: "model/content-safety",
      detail: "Runner reported an unsafe content-safety finding.",
    };
    const data: GuardrailFindingPage = {
      count: 2,
      summary: { total: 2, critical: 0, high: 0, medium: 2, low: 0, affected_traces: 2, latest_at: repeatedFinding.created_at },
      items: [
        { ...repeatedFinding, trace_id: "trace-one" },
        { ...repeatedFinding, trace_id: "trace-two" },
      ],
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { container } = render(<QueryClientProvider client={client}><GuardrailFindingsView data={data} loading={false} error={null} policies={[]} routers={[]} endpoints={[]} window="24h" onWindowChange={() => undefined} /></QueryClientProvider>);

    expect(container.querySelectorAll("article")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "routerDetail.severity.critical0" }));
    expect(container.querySelectorAll("article")).toHaveLength(0);
    expect(screen.getByText("guardrails.noMatchingFindings")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "routerDetail.severity.medium2" }));
    expect(container.querySelectorAll("article")).toHaveLength(2);
  });

  it("shows immutable configuration before the unified compiled runtime", () => {
    const version: GuardrailVersion = {
      guardrail_id: "guardrail-observed",
      version: VERSION_ID,
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

    const configuration = screen.getAllByText(VERSION_ID)[1];
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

  it("requires explicit publication after Validation passes", () => {
    const validatedGuardrail = {
      id: "guardrail-release",
      name: "Release Guardrail",
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
        guardrail_version: "20260814-080000.000Z",
        source_draft_version: 2,
        status: "passed",
        created_at: "2026-08-14T08:00:00Z",
        metrics: { total: 5, passed: 5, compliance_rate: 100, false_positive_rate: 0, false_negative_rate: 0, escalation_rate: 0, p95_latency_ms: 20 },
        results: [],
        excluded_case_ids: [],
      },
      router_count: 0,
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
    const props = { guardrail: validatedGuardrail, policies: [], cases: [], casesLoading: false, activeVersion: undefined, routers: [], onOpenValidation, onEdit: vi.fn(), onAddCase: vi.fn(), onCreateRouter: vi.fn(), onChanged: async () => undefined };

    const view = render(<QueryClientProvider client={client}><DraftReleaseView {...props} /></QueryClientProvider>);
    expect(screen.getByRole("button", { name: "guardrails.publishVersion" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "guardrails.createRouter" })).toBeNull();
    expect(screen.queryByRole("link", { name: "guardrails.openValidation" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "guardrails.openValidation" }));
    expect(onOpenValidation).toHaveBeenCalledWith(validatedGuardrail.latest_validation_run);

    view.rerender(<QueryClientProvider client={client}><DraftReleaseView {...props} guardrail={{ ...validatedGuardrail, published_current: true }} activeVersion={{ guardrail_id: validatedGuardrail.id, version: "20260814-080000.000Z", source_draft_version: 2, compiler_version: "compiler", plan_checksum: "plan", config_checksum: "config", created_at: "2026-08-14T08:00:00Z", active: true, runtime_engine: "llmrails", execution_mode: "nemo_only" }} /></QueryClientProvider>);
    expect(screen.queryByRole("button", { name: "guardrails.publishVersion" })).toBeNull();
    expect(screen.getByRole("button", { name: "guardrails.createRouter" })).toBeTruthy();
  });

  it("lets the Default Guardrail edit and validate its draft without creating another Router", () => {
    const defaultGuardrail = {
      id: "guardrail-default",
      name: "Default Guardrail",
      allowed_topics: [],
      restricted_topics: [],
      policy_bindings: [{ policy_id: "builtin-secrets", policy_version: "1", parameter_values: {}, enabled_rule_ids: [], rule_actions: {}, enabled_rails: ["input", "output"] }],
      safety_level: "balanced",
      output_delivery: "window_buffered",
      updated_at: "2026-08-14T08:00:00Z",
      status: "needs_validation",
      latest_validation_run: null,
      router_count: 1,
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

    render(<QueryClientProvider client={client}><DraftReleaseView guardrail={defaultGuardrail} policies={[]} cases={[]} casesLoading={false} routers={[]} onRunValidation={onRunValidation} onEdit={onEdit} onAddCase={vi.fn()} onCreateRouter={vi.fn()} onChanged={async () => undefined} /></QueryClientProvider>);

    expect(screen.queryByRole("link", { name: "guardrails.runReviewed" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "guardrails.runReviewed" }));
    expect(onRunValidation).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "common.edit" }));
    expect(onEdit).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "guardrails.createRouter" })).toBeNull();
  });

  it("edits Topic Control without requiring a Guardrail business purpose", () => {
    const topicGuardrail = {
      ...deletableGuardrail,
      allowed_topics: [],
      restricted_topics: ["legacy restricted topic"],
      policy_bindings: [{
        policy_id: "builtin-topic-safety",
        policy_version: "1.0.0",
        action: "redirect",
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
    expect(screen.queryByText("legacy restricted topic")).toBeNull();
    expect(screen.getByRole("button", { name: "common.save" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows validation setup failure instead of recommending test exclusions", () => {
    const run = { id: "failed-run", status: "failed", failure_reason: "No Evaluator Binding is available for content_safety.", metrics: { compliance_rate: 0 } } as NonNullable<Guardrail["latest_validation_run"]>;
    const guardrail = { ...deletableGuardrail, tested_current: false, published_current: false, latest_validation_run: run };
    const onOpenValidation = vi.fn();
    render(<QueryClientProvider client={new QueryClient()}><DraftReleaseView guardrail={guardrail} policies={[]} cases={[]} casesLoading={false} routers={[]} onOpenValidation={onOpenValidation} onEdit={vi.fn()} onAddCase={vi.fn()} onCreateRouter={vi.fn()} onChanged={async () => undefined} /></QueryClientProvider>);
    expect(screen.getByText(run.failure_reason!)).toBeTruthy();
    expect(screen.queryByText(/guardrails.lastValidationFailedDetail/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "guardrails.openValidation" }));
    expect(onOpenValidation).toHaveBeenCalledWith(run);
    expect(screen.queryByRole("button", { name: "guardrails.publishVersion" })).toBeNull();
  });

  it("shows every complete Default Policy with its identity, version, and full Rule count", () => {
    const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const draft = defaultGuardrailDraft(policies);
    const guardrail: Guardrail = {
      ...deletableGuardrail,
      id: DEFAULT_GUARDRAIL_ID,
      name: "Default Guardrail",
      is_default: true,
      system_managed: true,
      local_only: true,
      policy_bindings: draft.policyBindings.map((binding) => ({
        policy_id: binding.policyId,
        policy_version: binding.policyVersion,
        action: binding.action,
        parameter_values: binding.parameterValues,
        enabled_rule_ids: binding.enabledRuleIds,
        rule_actions: binding.ruleActions,
        enabled_rails: binding.enabledRails,
      })),
    };
    const client = new QueryClient();
    render(<QueryClientProvider client={client}><DraftReleaseView guardrail={guardrail} policies={policies} cases={[]} casesLoading={false} routers={[]} onEdit={vi.fn()} onAddCase={vi.fn()} onCreateRouter={vi.fn()} onChanged={async () => undefined} /></QueryClientProvider>);

    for (const binding of draft.policyBindings) {
      const policy = policies.find((item) => item.id === binding.policyId)!;
      const link = screen.getAllByRole("link").find((item) => item.textContent?.includes(`${policy.id}@${policy.version}`));
      expect(link).toBeDefined();
      expect(link!.textContent).toContain(policy.name);
      expect(link!.textContent).toContain(`${policy.id}@${policy.version}`);
      expect(link!.textContent).toContain(`guardrails.ruleCount count:${policy.rules.length}`);
      expect(link!.textContent).toContain("guardrails.policyBehavior");
    }
  });

  it("reorders saved draft Policies without losing pinned versions, Rule order or local overrides", async () => {
    const catalog = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
    const policies = ["configured-phrase-filter", "local-credentials"].map(id => catalog.find(p => p.id === id)!);
    const bindings = policies.map(defaultPolicyBinding);
    bindings[0]!.parameter_values = { phrase_entries: JSON.stringify([{ id: "private-phrase", phrase: "confidential", action: "reject" }]) };
    bindings[1]!.rule_order = [...bindings[1]!.enabled_rule_ids].reverse();
    bindings[1]!.rule_actions = { [bindings[1]!.enabled_rule_ids[0]!]: "redact" };
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
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update).toHaveBeenCalledWith(guardrail.id, expect.objectContaining({ policy_bindings: [original[1], original[0]], output_delivery: "full_buffered" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  });

  it("blocks saving incomplete Policy-owned phrases and recovers when filled", () => {
    const policy = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list().find(item => item.id === "configured-phrase-filter")!;
    const guardrail: Guardrail = { ...deletableGuardrail, policy_bindings: [{
      policy_id: policy.id, policy_version: policy.version, action: null,
      parameter_values: { phrase_entries: JSON.stringify([{ id: "entry", phrase: "", action: "reject" }]) },
      enabled_rule_ids: ["configured/phrases"], rule_actions: {}, enabled_rails: ["input", "output"], reasoning_policy: null,
    }] };
    const client = new QueryClient();
    render(<QueryClientProvider client={client}><TooltipProvider><EditGuardrailSheet guardrail={guardrail} policies={[policy]} open onOpenChange={vi.fn()} onSaved={vi.fn()} /></TooltipProvider></QueryClientProvider>);
    expect(screen.getByRole("button", { name: "common.save" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("Phrases and actions");
    fireEvent.change(screen.getByRole("textbox", { name: "protection.phrases.match index:1" }), { target: { value: "confidential" } });
    expect(screen.getByRole("button", { name: "common.save" }).hasAttribute("disabled")).toBe(false);
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
