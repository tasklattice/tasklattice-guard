import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import * as api from "@/lib/api";
import { ControllerRequestError as apiError } from "@/lib/controller-api";
import { GuardrailDetailPage } from "./guardrails";
import { GuardrailDraftReviewSheet } from "@/components/guardrail-draft-review";
import { GuardrailDraftChangesSheet } from "@/components/guardrail-draft-changes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { defaultPolicyBinding } from "@/components/policy-binding-editor";
import { PolicyCatalog } from "../../server/policy-catalog/catalog";

const routing = vi.hoisted(() => ({ navigate: vi.fn(), tab: "testing", report: undefined as string | undefined, version: undefined as string | undefined, compare: undefined as string | undefined, guardrailId: "guardrail-workflow", role: "user", pageSize: undefined as 25 | 50 | undefined, window: "24h", severity: undefined as string | undefined }));
vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en", exists: () => false } }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to?: string }) => <a href={to}>{children}</a>,
  useNavigate: () => routing.navigate,
  useParams: () => ({ guardrailId: routing.guardrailId }),
  useSearch: () => ({ tab: routing.tab, report: routing.report, version: routing.version, compare: routing.compare, pageSize: routing.pageSize, window: routing.window, severity: routing.severity }),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: routing.role } }) }));
vi.mock("@/components/dashboard/runtime-health-alert", () => ({ RuntimeHealthAlert: () => null }));
vi.mock("@/components/dashboard/runtime-metric-chart", () => ({ RuntimeMetricChart: () => null }));
vi.mock("@/routes/create-guardrail-wizard", () => ({ CreateGuardrailWizard: () => null }));
vi.mock("@/routes/routers", () => ({ TrafficScopeBadges: () => null }));

const policy = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list().find(item => item.id === "local-credentials")!;
const draft: api.Guardrail = {
  id: "guardrail-workflow", name: "Workflow Guardrail", draft_revision: 2, allowed_topics: [], restricted_topics: [],
  policy_bindings: [defaultPolicyBinding(policy)], safety_level: "balanced", output_delivery: "full_buffered",
  updated_at: "2026-10-08T00:00:00Z", status: "not_ready", latest_validation_run: null,
  router_count: 0, test_case_count: 1, excluded_test_case_count: 0, excluded_test_case_ids: [],
  tested_current: false, published_current: false, coverage: [],
};
const report: api.ValidationRun = {
  id: "report-workflow", guardrail_id: draft.id, guardrail_version: "20261008-000000.000Z", source_draft_version: 3,
  status: "passed", created_at: "2026-10-08T00:00:00Z", results: [], excluded_case_ids: [],
  metrics: { total: 1, passed: 1, compliance_rate: 100, false_positive_rate: 0, false_negative_rate: 0, escalation_rate: 0, p95_latency_ms: 10 },
};
function wrap(children: ReactNode) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><TooltipProvider>{children}</TooltipProvider></QueryClientProvider>;
}
function setupPage(overrides: Partial<api.Guardrail> = {}) {
  let current = { ...draft, ...overrides };
  vi.spyOn(api, "getGuardrail").mockImplementation(async () => current);
  vi.spyOn(api, "getPolicies").mockResolvedValue({ items: [policy], count: 1 });
  vi.spyOn(api, "getGuardrailVersions").mockResolvedValue({ items: [], count: 0 });
  vi.spyOn(api, "getValidationRuns").mockImplementation(async () => ({ items: current.latest_validation_run ? [current.latest_validation_run] : [], count: current.latest_validation_run ? 1 : 0 }));
  vi.spyOn(api, "getTestCases").mockResolvedValue({ items: [], count: 0 });
  vi.spyOn(api, "getRouters").mockResolvedValue({ items: [], count: 0 });
  vi.spyOn(api, "getEndpoints").mockResolvedValue({ items: [], count: 0 });
  vi.spyOn(api, "getMetrics").mockResolvedValue(undefined as unknown as api.Metrics);
  vi.spyOn(api, "getGuardrailFindings").mockResolvedValue({ items: [], count: 0 } as unknown as api.GuardrailFindingPage);
  vi.spyOn(api, "getGuardrailLoggingSettings").mockReturnValue(new Promise(() => {}));
  const update = vi.spyOn(api, "updateGuardrail").mockImplementation(async (_id, values) => {
    current = { ...current, ...values, draft_revision: 3, tested_current: false, published_current: false };
    return current;
  });
  return { update, completeTest: () => { current = { ...current, tested_current: true, latest_validation_run: report }; } };
}

describe("Guardrail edit, test and publish workflow", () => {
  beforeEach(() => { routing.guardrailId = draft.id; routing.tab = "testing"; routing.report = undefined; routing.version = undefined; routing.compare = undefined; routing.role = "user"; routing.pageSize = undefined; routing.window = "24h"; routing.severity = undefined; routing.navigate.mockReset(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("offers ordinary draft, testing and delete actions for the preconfigured Default", async () => {
    routing.guardrailId = "guardrail-default";
    setupPage({ id: routing.guardrailId, has_unpublished_changes: true, status: "enforce" });
    render(wrap(<GuardrailDetailPage />));
    await screen.findByRole("heading", { name: draft.name });
    expect(screen.queryByText("guardrails.defaultNoticeDescription")).toBeNull();
    expect(screen.getByRole("button", { name: "guardrails.testDraft" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "routing.actions" }));
    for (const name of ["guardrails.editAction", "guardrails.editTestCases", "guardrails.deleteAction"]) {
      expect(await screen.findByRole("menuitem", { name })).toBeTruthy();
    }
  });

  it("pages findings independently of failed statistics and resets pagination when page size changes", async () => {
    routing.tab = "event";
    setupPage();
    vi.mocked(api.getMetrics).mockRejectedValue(new apiError("Rate limited", 429));
    const finding = { id: "one", trace_id: "call", created_at: "2026-10-15T08:00:00Z", guardrail_id: draft.id,
      guardrail_version: "v1", router_id: null, endpoint_id: null, phase: "input", severity: "high", risk: "test", taxonomy_id: "test",
      verdict: "matched", confidence: 1, recommended_action: "block", policy_id: null, rule_id: "rule-one", detail: "Finding evidence" } as api.RouterTraceFinding;
    vi.mocked(api.getGuardrailFindings).mockImplementation(async (_id, _window, limit, cursor) => ({
      items: [{ ...finding, id: cursor ? "two" : "one", rule_id: cursor ? "rule-two" : "rule-one" }], count: 1, nextCursor: cursor ? null : "older",
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = <QueryClientProvider client={client}><TooltipProvider><GuardrailDetailPage /></TooltipProvider></QueryClientProvider>;
    const view = render(ui);
    await screen.findByText("rule-one");
    await screen.findByRole("button", { name: "securityEvents.retrySummary" });
    expect(api.getMetrics).toHaveBeenCalledTimes(1);
    const firstUntil = vi.mocked(api.getGuardrailFindings).mock.calls[0][6];
    expect(api.getGuardrailFindings).toHaveBeenLastCalledWith(draft.id, "24h", 25, undefined, expect.any(AbortSignal), [], firstUntil);
    await waitFor(() => expect(screen.getByRole("button", { name: "eventPagination.next" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "eventPagination.next" }));
    await screen.findByText("rule-two");
    expect(api.getGuardrailFindings).toHaveBeenLastCalledWith(draft.id, "24h", 25, "older", expect.any(AbortSignal), [], firstUntil);
    expect(api.getMetrics).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "eventPagination.next" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "eventPagination.previous" }));
    await screen.findByText("rule-one");
    expect(api.getGuardrailFindings).toHaveBeenLastCalledWith(draft.id, "24h", 25, undefined, expect.any(AbortSignal), [], firstUntil);
    await waitFor(() => expect(screen.getByRole("button", { name: "eventPagination.next" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "eventPagination.next" }));
    await screen.findByText("rule-two");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "securityEvents.perPage" }).hasAttribute("disabled")).toBe(false));
    fireEvent.change(screen.getByRole("combobox", { name: "securityEvents.perPage" }), { target: { value: "50" } });
    const change = routing.navigate.mock.calls.at(-1)![0].search({ pageSize: undefined });
    routing.pageSize = change.pageSize;
    view.rerender(<QueryClientProvider client={client}><TooltipProvider><GuardrailDetailPage /></TooltipProvider></QueryClientProvider>);
    await waitFor(() => expect(api.getGuardrailFindings).toHaveBeenLastCalledWith(draft.id, "24h", 50, undefined, expect.any(AbortSignal), [], expect.any(String)));
    expect(api.getMetrics).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "eventPagination.previous" }).hasAttribute("disabled")).toBe(true);
    routing.severity = "critical";
    view.rerender(<QueryClientProvider client={client}><TooltipProvider><GuardrailDetailPage /></TooltipProvider></QueryClientProvider>);
    await waitFor(() => expect(api.getGuardrailFindings).toHaveBeenLastCalledWith(draft.id, "24h", 50, undefined, expect.any(AbortSignal), ["critical"], expect.any(String)));
    expect(api.getMetrics).toHaveBeenCalledTimes(1);
    routing.window = "7d";
    view.rerender(<QueryClientProvider client={client}><TooltipProvider><GuardrailDetailPage /></TooltipProvider></QueryClientProvider>);
    await waitFor(() => expect(api.getGuardrailFindings).toHaveBeenLastCalledWith(draft.id, "7d", 50, undefined, expect.any(AbortSignal), ["critical"], expect.any(String)));
    await waitFor(() => expect(api.getMetrics).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "securityEvents.retrySummary" }));
    await waitFor(() => expect(api.getMetrics).toHaveBeenCalledTimes(3));
  });

  it("does not load Security Events for hidden tabs", async () => {
    setupPage();
    render(wrap(<GuardrailDetailPage />));
    await screen.findByRole("heading", { name: draft.name });
    expect(api.getGuardrailFindings).not.toHaveBeenCalled();
    expect(api.getMetrics).not.toHaveBeenCalled();
  });

  it("opens protection mode from Actions while viewing the Testing tab", async () => {
    setupPage({ status: "enforce", protection: { guardrailId: draft.id, mode: "enforce", appliedMode: "enforce", generation: 7, ready: true,
      status: "applied", applied: 1, total: 1, runners: [], updatedAt: null, updatedBy: null, reason: "" } });
    render(wrap(<GuardrailDetailPage />));
    await screen.findByRole("heading", { name: draft.name });
    expect(screen.getByRole("tab", { name: /guardrails.validationHistoryTab/ }).getAttribute("data-state")).toBe("active");
    fireEvent.click(screen.getByRole("button", { name: "routing.actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "protectionMode.change" }));
    expect(await screen.findByRole("dialog", { name: "protectionMode.change" })).toBeTruthy();
    expect((screen.getByRole("radio", { name: "states.enforce" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "states.monitor" }));
    expect((screen.getByRole("radio", { name: "states.monitor" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("radio", { name: "states.bypass" })).toBeTruthy();
  });

  it("hides draft status and Test draft when the working copy matches a published version", async () => {
    setupPage({ published_current: true, has_unpublished_changes: false });
    render(wrap(<GuardrailDetailPage />));
    await screen.findByRole("heading", { name: draft.name });
    expect(screen.queryByRole("button", { name: "guardrails.testDraft" })).toBeNull();
    expect(screen.queryByText("guardrails.draftRevisionLabel")).toBeNull();
    expect(screen.queryByText("guardrails.unpublishedChanges")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "routing.actions" }));
    expect(screen.getByRole("menuitem", { name: "guardrails.editAction" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "guardrails.draftChanges.discard" })).toBeNull();
  });

  it.each(["local", "imported"] as const)("uses the same working draft Actions and default tab for %s Guardrails", async (origin) => {
    routing.tab = undefined as unknown as string;
    setupPage({ origin, source_id: origin === "imported" ? "bank-uat" : undefined, published_current: true, has_unpublished_changes: false, status: "enforce" });
    render(wrap(<GuardrailDetailPage />));
    await screen.findByRole("heading", { name: draft.name });
    expect(Boolean(screen.queryByText("guardrailPackage.importedFrom"))).toBe(origin === "imported");
    expect(screen.queryByRole("button", { name: "guardrails.testDraft" })).toBeNull();
    expect(screen.queryByRole("button", { name: "guardrails.publishVersion" })).toBeNull();
    expect(screen.getByRole("tab", { name: /guardrails.validationHistoryTab/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /guardrails.runtimeTab/ }).getAttribute("data-state")).toBe("active");
    fireEvent.click(screen.getByRole("button", { name: "routing.actions" }));
    expect(screen.getByRole("menuitem", { name: "guardrails.editAction" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "guardrails.editTestCases" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "guardrails.editLogLevel" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "guardrails.deleteAction" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "guardrails.openPlayground" })).toBeTruthy();
    expect(api.getTestCases).toHaveBeenCalledWith(draft.id);
    expect(api.getGuardrailLoggingSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: "guardrails.editLogLevel" }));
    await screen.findByRole("dialog", { name: "guardrails.editLogLevel" });
    expect(api.getGuardrailLoggingSettings).toHaveBeenCalledWith(draft.id);
  });

  it.each(["guardrail-workflow", "guardrail-default"])("offers the same Delete confirmation for %s", async id => {
    routing.guardrailId = id;
    setupPage({ id, has_unpublished_changes: false });
    const impact = vi.spyOn(api, "getGuardrailDeletionImpact").mockResolvedValue({ telemetry_fresh: true, requires_second_confirmation: false, incoming_request_count: 0, active_router_count: 0, window_minutes: 30 } as api.GuardrailDeletionImpact);
    const remove = vi.spyOn(api, "deleteGuardrail");
    render(wrap(<GuardrailDetailPage />));
    await screen.findByRole("heading", { name: draft.name });
    fireEvent.click(screen.getByRole("button", { name: "routing.actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "guardrails.deleteAction" }));
    await screen.findByRole("dialog", { name: "guardrails.deleteDialogTitle" });
    await screen.findByText("guardrails.noRecentTraffic");
    expect(impact).toHaveBeenCalledWith(id);
    expect(screen.getByLabelText("guardrails.deleteReason")).toBeTruthy();
    expect(screen.getByRole("button", { name: "guardrails.deleteConfirm" }).hasAttribute("disabled")).toBe(true);
    expect(remove).not.toHaveBeenCalled();
  });

  it("keeps the selected immutable version and comparison base in the URL", async () => {
    routing.tab = "immutable";
    setupPage({ origin: "imported", published_current: true, has_unpublished_changes: false, status: "enforce" });
    const versions = ["20261009-090837.640Z", "20261009-090835.526Z"].map(version => ({
      guardrail_id: draft.id, version, created_at: "2026-10-09T09:09:10Z", status: "ready", origin: "imported", test_suite_count: 12,
    } as api.GuardrailVersion));
    vi.mocked(api.getGuardrailVersions).mockResolvedValue({ items: versions, count: 2 });
    vi.spyOn(api, "getGuardrailVersion").mockResolvedValue(undefined as never);
    render(wrap(<GuardrailDetailPage />));
    await screen.findByRole("heading", { name: draft.name });

    // Selecting a version writes it to the URL and drops any stale comparison.
    const rows = await screen.findAllByRole("button", { name: "immutableVersions.view" });
    const older = rows.find(button => button.textContent === versions[1].version);
    if (!older) throw new Error("Older version row is missing");
    fireEvent.click(older);
    const selection = routing.navigate.mock.calls.at(-1)![0] as { search: (previous: Record<string, unknown>) => Record<string, unknown> };
    expect(selection.search({ tab: "immutable", compare: versions[0].version, pageSize: 50 }))
      .toEqual({ tab: "immutable", pageSize: 50, version: versions[1].version, compare: undefined });
  });

  it("opens the version named by the URL instead of the newest one", async () => {
    routing.tab = "immutable";
    setupPage({ origin: "imported", published_current: true, has_unpublished_changes: false, status: "enforce" });
    const versions = ["20261009-090837.640Z", "20261009-090835.526Z"].map(version => ({
      guardrail_id: draft.id, version, created_at: "2026-10-09T09:09:10Z", status: "ready", origin: "imported", test_suite_count: 12,
    } as api.GuardrailVersion));
    vi.mocked(api.getGuardrailVersions).mockResolvedValue({ items: versions, count: 2 });
    const detail = vi.spyOn(api, "getGuardrailVersion").mockResolvedValue(undefined as never);
    routing.version = versions[1].version;
    render(wrap(<GuardrailDetailPage />));
    // The deep link selects and fetches the older version, not the newest one.
    await waitFor(() => expect(detail).toHaveBeenCalledWith(draft.id, versions[1].version));
    expect(detail).not.toHaveBeenCalledWith(draft.id, versions[0].version);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByText(versions[1].version).length).toBeGreaterThan(0);
  });

  it("runs the selected imported version from a direct Testing Report link and reruns that same version", async () => {
    setupPage({ origin: "imported", source_id: "bank-uat", published_current: true, has_unpublished_changes: false, status: "enforce" });
    const versions = ["20261009-090837.640Z", "20261009-090835.526Z"].map(version => ({
      guardrail_id: draft.id, version, created_at: "2026-10-09T09:09:10Z", status: "ready", origin: "imported", test_suite_count: 12,
    } as api.GuardrailVersion));
    vi.mocked(api.getGuardrailVersions).mockResolvedValue({ items: versions, count: 2 });
    const localReport = { ...report, subject: "version" as const, guardrail_version: versions[1].version };
    const run = vi.spyOn(api, "testGuardrailVersion").mockResolvedValue(localReport);
    const draftRun = vi.spyOn(api, "createValidationRun");
    render(wrap(<GuardrailDetailPage />));
    await screen.findByRole("heading", { name: draft.name });
    expect(screen.getByRole("tab", { name: /guardrails.validationHistoryTab/ }).getAttribute("aria-selected")).toBe("true");
    const retention = screen.getByText("immutableVersions.reportRetention").closest("details");
    expect(retention?.open).toBe(false);
    expect(retention?.textContent).toContain("immutableVersions.testingDescription");
    expect(screen.getByText("immutableVersions.localTestingEmpty")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("tab", { name: /guardrails.versions/ }).textContent).toContain("2/10");
    fireEvent.click(screen.getByRole("button", { name: "guardrails.runReviewed" }));
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "immutableVersions.runVersionTests" })[1]);
    await waitFor(() => expect(run).toHaveBeenCalledWith(draft.id, versions[1].version, true));
    // Opening a report writes its ID into the URL instead of hidden state.
    await waitFor(() => expect(routing.navigate).toHaveBeenCalled());
    const opened = routing.navigate.mock.calls.at(-1)![0] as { search: (previous: Record<string, unknown>) => Record<string, unknown> };
    expect(opened.search({ tab: "testing", pageSize: 50 })).toEqual({ tab: "testing", pageSize: 50, report: localReport.id });
    vi.spyOn(api, "getValidationRun").mockResolvedValue(localReport);
    routing.report = localReport.id;
    render(wrap(<GuardrailDetailPage />));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("immutableVersions.localTestReportDescription")).toBeTruthy();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "validation.runAgain" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(within(dialog).getByRole("button", { name: "validation.runAgain" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run).toHaveBeenLastCalledWith(draft.id, versions[1].version, true);
    expect(draftRun).not.toHaveBeenCalled();
    expect(api.getTestCases).toHaveBeenCalledWith(draft.id);
  });

  it("lets viewers read imported reports without running tests or editing the frozen suite", async () => {
    routing.role = "viewer";
    setupPage({ origin: "imported", has_unpublished_changes: false });
    vi.mocked(api.getValidationRuns).mockResolvedValue({ items: [{ ...report, subject: "version" }], count: 1 });
    render(wrap(<GuardrailDetailPage />));
    await screen.findByRole("heading", { name: draft.name });
    expect(screen.getByRole("tab", { name: /guardrails.validationHistoryTab/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("combobox", { name: "immutableVersions.testVersion" })).toBeNull();
    expect(screen.queryByRole("button", { name: "immutableVersions.runTests" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "validation.openValidationRun" }));
    await waitFor(() => expect(routing.navigate).toHaveBeenCalled());
    routing.report = report.id;
    render(wrap(<GuardrailDetailPage />));
    await screen.findByRole("dialog");
    expect(screen.queryByRole("button", { name: "validation.runAgain" })).toBeNull();
  });

  it("reviews changes before confirming discard and uses exactly the reviewed revision", async () => {
    vi.spyOn(api, "getGuardrailDraftChanges").mockResolvedValue({ draftRevision: 2, baselineVersion: "20261008-000000.000Z", baselineAvailable: true, hasUnpublishedChanges: true, canDiscard: true,
      changes: [{ kind: "policyOrder", subject: "", field: "policyOrder", before: "credentials\ncontact", after: "contact\ncredentials" }] });
    const discard = vi.spyOn(api, "discardGuardrailDraft").mockResolvedValue({ ...draft, published_current: true, has_unpublished_changes: false });
    const changed = vi.fn(async () => {}); const closed = vi.fn();
    render(wrap(<GuardrailDraftChangesSheet guardrail={draft} canManage onChanged={changed} onClose={closed} />));
    const button = await screen.findByRole("button", { name: "guardrails.draftChanges.discard" });
    expect(screen.getByText("credentials contact")).toBeTruthy();
    fireEvent.click(button);
    expect(discard).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "guardrails.draftChanges.discardTitle" })).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => expect(discard).toHaveBeenCalledWith(draft.id, 2, "20261008-000000.000Z"));
    await waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(changed).toHaveBeenCalledOnce();
  });

  it("does not allow a viewer to discard changes", async () => {
    vi.spyOn(api, "getGuardrailDraftChanges").mockResolvedValue({ draftRevision: 2, baselineVersion: "20261008-000000.000Z", baselineAvailable: true, hasUnpublishedChanges: true, canDiscard: true, changes: [] });
    render(wrap(<GuardrailDraftChangesSheet guardrail={draft} canManage={false} onChanged={vi.fn(async () => {})} onClose={vi.fn()} />));
    await screen.findByText("guardrails.draftRevisionLabel");
    expect(screen.queryByRole("button", { name: "guardrails.draftChanges.discard" })).toBeNull();
  });

  it("saves and skips testing in place, then tests and explicitly publishes the saved revision", async () => {
    const page = setupPage();
    let finishRun!: (run: api.ValidationRun) => void;
    const run = vi.spyOn(api, "createValidationRun").mockImplementation(() => new Promise(resolve => { finishRun = resolve; }));
    const version = { version: report.guardrail_version, source_draft_version: 3, status: "ready" } as api.GuardrailVersion;
    const publish = vi.spyOn(api, "publishGuardrail").mockResolvedValue(version);
    render(wrap(<GuardrailDetailPage />));
    await screen.findByRole("button", { name: "routing.actions" });
    expect(screen.queryByRole("tab", { name: "guardrails.draftReleaseTab" })).toBeNull();
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "routing.actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "guardrails.editAction" }));
    fireEvent.change(screen.getByRole("textbox", { name: "guardrails.guardrailName" }), { target: { value: "Updated Guardrail" } });
    fireEvent.click(screen.getByRole("button", { name: "guardrails.saveDraft" }));
    await screen.findByRole("heading", { name: "guardrails.draftSaved" });
    expect(page.update).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(routing.navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "guardrails.skipTest" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("tab", { name: /guardrails.validationHistoryTab/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "guardrails.testDraft" }));
    fireEvent.click(screen.getByRole("button", { name: "guardrails.testNow" }));
    await waitFor(() => expect(run).toHaveBeenCalledWith(draft.id, { onProgress: expect.any(Function) }, true));
    expect(screen.getByText("guardrails.testingInPlace")).toBeTruthy();
    expect(screen.getByRole("button", { name: "guardrails.continueEditing" }).hasAttribute("disabled")).toBe(false);
    page.completeTest(); finishRun(report);
    await screen.findByRole("button", { name: "guardrails.publishVersion" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(routing.navigate).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "guardrails.publishVersion" }));
    expect(publish).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "guardrails.publishVersion" }));
    await waitFor(() => expect(publish).toHaveBeenCalledWith(draft.id, 3));
    await waitFor(() => expect(routing.navigate).toHaveBeenCalled());
    expect(routing.navigate.mock.lastCall![0].search({ tab: "testing" }).tab).toBe("immutable");
  });

  it("shows an execution error in the same drawer and allows retry without publishing", async () => {
    const failed = { ...report, source_draft_version: 2, status: "failed" as const, failure_reason: "Runner is unavailable", metrics: { ...report.metrics, passed: 0, compliance_rate: 0 } };
    const run = vi.spyOn(api, "createValidationRun").mockRejectedValueOnce(new Error("Connection interrupted")).mockResolvedValue(failed);
    const publish = vi.spyOn(api, "publishGuardrail");
    const changed = vi.fn(async () => {});
    render(wrap(<GuardrailDraftReviewSheet guardrail={draft} policies={[policy]} versions={[]} onClose={vi.fn()} onEdit={vi.fn()} onChanged={changed} onPublished={vi.fn()} />));
    fireEvent.click(screen.getByRole("button", { name: "guardrails.testNow" }));
    await screen.findByText("Connection interrupted");
    fireEvent.click(screen.getByRole("button", { name: "guardrails.testNow" }));
    await screen.findByText("Runner is unavailable");
    expect(run).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "guardrails.publishVersion" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "validation.runAgain" })).toBeTruthy();
    expect(publish).not.toHaveBeenCalled();
  });

  it("shows real case counts and reconnects to the same run after polling fails", async () => {
    const running: api.ValidationRun = { ...report, source_draft_version: 2, status: "incomplete", execution_status: "running", metrics: { ...report.metrics, total: 10 }, progress: { phase: "executing", completedCases: 4, passedCases: 3, updatedAt: new Date().toISOString() } };
    let interrupt!: (error: Error) => void;
    const create = vi.spyOn(api, "createValidationRun").mockImplementation((_id, observer) => {
      observer?.onProgress?.(running);
      return new Promise((_resolve, reject) => { interrupt = reject; });
    });
    const resume = vi.spyOn(api, "resumeValidationRun").mockImplementation(async (_id, observer) => {
      const done = { ...report, source_draft_version: 2, execution_status: "passed" as const };
      observer?.onProgress?.(done);
      return done;
    });
    render(wrap(<GuardrailDraftReviewSheet guardrail={draft} policies={[policy]} versions={[]} onClose={vi.fn()} onEdit={vi.fn()} onChanged={vi.fn(async () => {})} onPublished={vi.fn()} />));
    fireEvent.click(screen.getByRole("button", { name: "guardrails.testNow" }));
    const bar = await screen.findByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("4");
    expect(bar.getAttribute("aria-valuemax")).toBe("10");
    expect(screen.getByText("40%")).toBeTruthy();
    expect(screen.queryByText("guardrails.draftTestFailed")).toBeNull();
    interrupt(new Error("Connection interrupted"));
    fireEvent.click(await screen.findByRole("button", { name: "guardrails.testProgress.reconnect" }));
    await screen.findByRole("button", { name: "validation.runAgain" });
    expect(create).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledWith(running.id, { onProgress: expect.any(Function) });
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("resumes an existing current-draft test when its drawer is reopened", async () => {
    const active = { ...report, source_draft_version: 2, status: "incomplete" as const, execution_status: "queued" as const };
    const create = vi.spyOn(api, "createValidationRun");
    const resume = vi.spyOn(api, "resumeValidationRun").mockResolvedValue({ ...report, source_draft_version: 2 });
    render(wrap(<GuardrailDraftReviewSheet guardrail={{ ...draft, latest_validation_run: active }} policies={[policy]} versions={[]} onClose={vi.fn()} onEdit={vi.fn()} onChanged={vi.fn(async () => {})} onPublished={vi.fn()} />));
    await screen.findByRole("button", { name: "validation.runAgain" });
    expect(resume).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it.each(["completed", "reopened"])("loads failed case details for a %s draft test", async mode => {
    const summary = { ...report, source_draft_version: 2, status: "failed" as const, details_loaded: false };
    const failedCase: api.TestCaseResult = { case_id: "model-case", name: "Unsafe model sample", policy_id: policy.id,
      passed: false, expected_decision: "block", actual_decision: "allow", phase: "input",
      latency_ms: 1, reason: "Expected block, received allow", trace: [], findings: [],
      evidence_status: "not_required", evidence_detail: "", verified_rule_ids: [], superseded_by: [], rule_contract_satisfied: true,
      covered_rule_ids: [], matched_rule_ids: [], evaluator_ids: [],
      input_content: "", output_content: "", action: "allow", trusted_instruction: "", target_source: "user",
      query: "", grounding_sources: [], expected_reasoning_result: null, actual_reasoning_result: null,
      case_type: "rule_acceptance", required: true, expected_failure: null, actual_failure: null,
      concurrency_group: null, source_policy_id: null, source_policy_version: null, source_case_id: null,
      evaluation_contracts: [], escalated: false, model_invocations: 1 };
    let complete!: (value: api.ValidationRun) => void;
    const detail = vi.spyOn(api, "getValidationRun").mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    vi.spyOn(api, "createValidationRun").mockResolvedValue(summary);
    render(wrap(<GuardrailDraftReviewSheet guardrail={{ ...draft, latest_validation_run: mode === "reopened" ? summary : null }} policies={[policy]} versions={[]} onClose={vi.fn()} onChanged={vi.fn(async () => {})} onPublished={vi.fn()} />));
    if (mode === "completed") fireEvent.click(screen.getByRole("button", { name: "guardrails.testNow" }));
    await waitFor(() => expect(detail).toHaveBeenCalledWith(summary.id));
    expect(screen.queryByRole("heading", { name: "validation.caseResults" })).toBeNull();
    complete({ ...summary, details_loaded: true, results: [failedCase] });
    await screen.findByText(failedCase.name);
    expect(screen.getByRole("button", { name: "validation.runAgain" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "guardrails.publishVersion" }).hasAttribute("disabled")).toBe(false);
  });

  it("retries failed detail loading without rerunning the draft test", async () => {
    const summary = { ...report, source_draft_version: 2, details_loaded: false };
    const detail = vi.spyOn(api, "getValidationRun").mockRejectedValueOnce(new Error("Report detail unavailable"))
      .mockResolvedValue({ ...summary, details_loaded: true });
    const create = vi.spyOn(api, "createValidationRun");
    render(wrap(<GuardrailDraftReviewSheet guardrail={{ ...draft, latest_validation_run: summary }} policies={[policy]} versions={[]} onClose={vi.fn()} onChanged={vi.fn(async () => {})} onPublished={vi.fn()} />));
    await screen.findByText("Report detail unavailable");
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    await waitFor(() => expect(screen.queryByText("Report detail unavailable")).toBeNull());
    expect(detail).toHaveBeenCalledTimes(2);
    expect(create).not.toHaveBeenCalled();
  });

  it("invalidates an open publication confirmation when the draft changes", async () => {
    const publish = vi.spyOn(api, "publishGuardrail");
    const props = { guardrail: { ...draft, draft_revision: 3, tested_current: true, latest_validation_run: report }, policies: [policy], versions: [], initialPublish: true, onClose: vi.fn(), onEdit: vi.fn(), onChanged: vi.fn(async () => {}), onPublished: vi.fn() };
    const client = new QueryClient();
    const view = render(<QueryClientProvider client={client}><GuardrailDraftReviewSheet {...props} /></QueryClientProvider>);
    view.rerender(<QueryClientProvider client={client}><GuardrailDraftReviewSheet {...props} guardrail={{ ...props.guardrail, draft_revision: 4, tested_current: false }} /></QueryClientProvider>);
    expect(screen.getByRole("button", { name: "guardrails.publishVersion" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("guardrails.draftChangedBeforePublish")).toBeTruthy();
    expect(publish).not.toHaveBeenCalled();
  });

  it("blocks new publication at ten immutable versions, including pending versions", () => {
    const publish = vi.spyOn(api, "publishGuardrail");
    const versions = Array.from({ length: 10 }, (_, index) => ({ version: String(index), status: index % 2 ? "ready" : "pending" } as api.GuardrailVersion));
    render(wrap(<GuardrailDraftReviewSheet guardrail={{ ...draft, draft_revision: 3, tested_current: true, latest_validation_run: report }} policies={[policy]} versions={versions} initialPublish onClose={vi.fn()} onEdit={vi.fn()} onChanged={vi.fn(async () => {})} onPublished={vi.fn()} />));
    expect(screen.getByText("immutableVersions.capacityReached")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "guardrails.publishVersion" }));
    expect(screen.getByRole("button", { name: "guardrails.publishVersion" }).hasAttribute("disabled")).toBe(true);
    expect(publish).not.toHaveBeenCalled();
  });

  it("preserves unsaved edits when continuing and requires discard on close", async () => {
    setupPage();
    render(wrap(<GuardrailDetailPage />));
    fireEvent.click(await screen.findByRole("button", { name: "routing.actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "guardrails.editAction" }));
    fireEvent.change(screen.getByRole("textbox", { name: "guardrails.guardrailName" }), { target: { value: "Unsaved name" } });
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    expect(screen.getByDisplayValue("Unsaved name")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "guardrails.continueEditing" }));
    expect(screen.getByDisplayValue("Unsaved name")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "guardrails.discardChanges" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.updateGuardrail).not.toHaveBeenCalled();
  });

  it("normalizes removed draft links and hides editing for viewers", async () => {
    setupPage(); routing.tab = "draft"; routing.role = "viewer";
    render(wrap(<GuardrailDetailPage />));
    await screen.findByRole("heading", { name: draft.name });
    expect(screen.queryByRole("tab", { name: "guardrails.draftReleaseTab" })).toBeNull();
    expect(screen.queryByRole("button", { name: "routing.actions" })).toBeNull();
    expect(routing.navigate.mock.calls.some(([arg]) => arg.replace && arg.search({ tab: "draft", severity: "medium" }).tab === "runtime")).toBe(true);
  });

  it("lets viewers open a draft test target without exposing modification actions", async () => {
    setupPage(); routing.role = "viewer";
    vi.mocked(api.getValidationRuns).mockResolvedValue({ items: [report], count: 1 });
    const run = vi.spyOn(api, "createValidationRun");
    const publish = vi.spyOn(api, "publishGuardrail");
    render(wrap(<GuardrailDetailPage />));
    fireEvent.click(await screen.findByRole("button", { name: "validation.versionTarget" }));
    await screen.findByText("guardrails.draftReviewReadOnly");
    const drawer = within(screen.getByRole("dialog"));
    expect(drawer.queryByRole("button", { name: "guardrails.continueEditing" })).toBeNull();
    expect(drawer.queryByRole("button", { name: "guardrails.testNow" })).toBeNull();
    expect(drawer.queryByRole("button", { name: "guardrails.publishVersion" })).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
