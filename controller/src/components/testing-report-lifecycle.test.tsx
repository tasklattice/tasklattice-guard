import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Guardrail, ValidationRun } from "@/lib/api";
import { deleteTestingReport, getTestingReportDeletionImpact } from "@/lib/controller-api";
import type { TestingReportDeletionImpact } from "../../shared/testing-report-deletion";
import { GuardrailRegistry } from "./guardrail-registry";
import { DeleteTestingReportSheet } from "./delete-testing-report-sheet";

vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock("./guardrail-row-actions", () => ({ GuardrailRowActions: () => null }));
vi.mock("./ui/notifications", () => ({ toast: { success: vi.fn() } }));
vi.mock("@/lib/controller-api", () => ({ deleteTestingReport: vi.fn(), getTestingReportDeletionImpact: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en", exists: () => false } }) }));
const run = { id: "report-1", guardrail_id: "guard-1", guardrail_version: "20261010-001500.000Z", status: "passed", subject: "version", metrics: { compliance_rate: 100 } } as ValidationRun;
const impact: TestingReportDeletionImpact = { runId: run.id, guardrailId: run.guardrail_id, version: run.guardrail_version,
  deletable: true, running: false, pendingVersion: run.guardrail_version, replacementRunId: null, references: [], blockers: [] };
beforeEach(() => { vi.mocked(getTestingReportDeletionImpact).mockResolvedValue(impact); vi.mocked(deleteTestingReport).mockResolvedValue(undefined); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function showDelete() {
  const deleted = vi.fn();
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><DeleteTestingReportSheet run={run} onClose={vi.fn()} onDeleted={deleted} /></QueryClientProvider>);
  return deleted;
}

describe("Testing Report display and deletion", () => {
  it.each(["local", "imported"])("keeps the %s resource registry at version level instead of using a single report", origin => {
    const guardrail = { id: run.guardrail_id, name: "Bank assistant", status: "ready", origin, policy_bindings: [], updated_at: "2026-10-10T00:00:00Z", latest_validation_run: null, latest_testing_report: run, version_summary: { total: 2, released: 1, pending: 1, missingEvidence: 0 } } as Guardrail;
    render(<GuardrailRegistry guardrails={[guardrail]} onOpen={vi.fn()} />);
    expect(screen.queryByText("100%")).toBeNull();
    expect(screen.getByText("2/10")).toBeTruthy();
    expect(screen.queryByText("guardrails.notRun")).toBeNull();
  });
  it("reviews the return to Pending before permanently deleting the last Passed report", async () => {
    const deleted = showDelete();
    await screen.findByText("validation.deleteReportPendingTitle");
    expect(deleteTestingReport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "validation.deleteReport" }));
    await waitFor(() => expect(deleteTestingReport).toHaveBeenCalledWith(run.id, run.guardrail_version));
    await waitFor(() => expect(deleted).toHaveBeenCalledOnce());
  });
  it("explains retained release evidence and sends no pending transition", async () => {
    vi.mocked(getTestingReportDeletionImpact).mockResolvedValue({ ...impact, pendingVersion: null, replacementRunId: "report-2" });
    showDelete();
    await screen.findByText("validation.deleteReportRetainsRelease");
    fireEvent.click(screen.getByRole("button", { name: "validation.deleteReport" }));
    await waitFor(() => expect(deleteTestingReport).toHaveBeenCalledWith(run.id, null));
  });
  it("blocks removal of the last Passed report when the version is referenced", async () => {
    vi.mocked(getTestingReportDeletionImpact).mockResolvedValue({ ...impact, deletable: false, references: [{ kind: "router_active", routerId: "router-1", routerName: "Bank traffic" }] });
    showDelete();
    await screen.findByText("Bank traffic");
    expect(screen.getByRole("button", { name: "validation.deleteReport" }).hasAttribute("disabled")).toBe(true);
    expect(deleteTestingReport).not.toHaveBeenCalled();
  });
  it("keeps running reports until their test has finished", async () => {
    vi.mocked(getTestingReportDeletionImpact).mockResolvedValue({ ...impact, running: true, deletable: false, pendingVersion: null });
    showDelete();
    await screen.findByText("validation.deleteReportRunning");
    expect(screen.getByRole("button", { name: "validation.deleteReport" }).hasAttribute("disabled")).toBe(true);
  });
});
