import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import * as api from "@/lib/api";
import { GuardrailDetailPage } from "./guardrails";
import { GuardrailDraftReviewSheet } from "@/components/guardrail-draft-review";
import { GuardrailDraftChangesSheet } from "@/components/guardrail-draft-changes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { defaultPolicyBinding } from "@/components/policy-binding-editor";
import { PolicyCatalog } from "../../server/policy-catalog/catalog";

const routing = vi.hoisted(() => ({ navigate: vi.fn(), tab: "testing", role: "admin" }));
vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en", exists: () => false } }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to?: string }) => <a href={to}>{children}</a>,
  useNavigate: () => routing.navigate,
  useParams: () => ({ guardrailId: "guardrail-workflow" }),
  useSearch: () => ({ tab: routing.tab }),
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
  updated_at: "2026-10-08T00:00:00Z", status: "needs_validation", latest_validation_run: null,
  router_count: 0, test_case_count: 1, excluded_test_case_count: 0, excluded_test_case_ids: [],
  tested_current: false, published_current: false, is_default: false, system_managed: false, local_only: true, coverage: [],
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
  beforeEach(() => { routing.tab = "testing"; routing.role = "admin"; routing.navigate.mockReset(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("hides draft status and Test draft when the working copy matches a published version", async () => {
    setupPage({ published_current: true, has_unpublished_changes: false, latest_version: "20261008-000000.000Z" });
    render(wrap(<GuardrailDetailPage />));
    await screen.findByRole("heading", { name: draft.name });
    expect(screen.queryByRole("button", { name: "guardrails.testDraft" })).toBeNull();
    expect(screen.queryByText("guardrails.draftRevisionLabel")).toBeNull();
    expect(screen.queryByText("guardrails.unpublishedChanges")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "routing.actions" }));
    expect(screen.getByRole("menuitem", { name: "guardrails.editAction" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "guardrails.draftChanges.discard" })).toBeNull();
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
    const version = { version: report.guardrail_version, source_draft_version: 3, compile_status: "compiling" } as api.GuardrailVersion;
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
    await waitFor(() => expect(run).toHaveBeenCalledWith(draft.id, { onProgress: expect.any(Function) }));
    expect(screen.getByText("guardrails.testingInPlace")).toBeTruthy();
    expect(screen.getByRole("button", { name: "guardrails.continueEditing" }).hasAttribute("disabled")).toBe(true);
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
    expect(screen.queryByRole("button", { name: "guardrails.publishVersion" })).toBeNull();
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
