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
  deletable: true, running: false };
beforeEach(() => { vi.mocked(getTestingReportDeletionImpact).mockResolvedValue(impact); vi.mocked(deleteTestingReport).mockResolvedValue(undefined); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function showDelete() {
  const deleted = vi.fn();
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><DeleteTestingReportSheet run={run} onClose={vi.fn()} onDeleted={deleted} /></QueryClientProvider>);
  return deleted;
}

describe("Testing Report display and deletion", () => {
  it.each(["local", "imported"])("keeps the %s registry focused on request rate without stale report or version details", origin => {
    const trafficVersion = "20261009-090837.640Z";
    const guardrail = {
      id: run.guardrail_id, name: "Bank assistant", status: "enforce", origin, policy_bindings: [],
      updated_at: "2026-10-10T00:00:00Z", latest_validation_run: null, latest_testing_report: run,
      version_summary: { total: 2, released: 1, pending: 1, missingEvidence: 0 },
      traffic_versions: [{ version: trafficVersion, baseline: true, routers: [{ id: "router-1", name: "Bank traffic", status: "active" }] }],
    } as Guardrail;
    render(<GuardrailRegistry guardrails={[guardrail]} onOpen={vi.fn()} />);
    expect(screen.queryByText("100%")).toBeNull();
    expect(screen.getByText("Bank assistant").closest("a")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "dashboard.metrics.request_rate" })).toBeTruthy();
    expect(screen.getByText("guardrails.requestRateUnavailable")).toBeTruthy();
    expect(screen.queryByText(trafficVersion)).toBeNull();
    expect(screen.queryByText("Bank traffic")).toBeNull();
    expect(screen.queryByText(run.guardrail_version)).toBeNull();
    expect(screen.queryByText("guardrails.notRun")).toBeNull();
  });
  it("confirms permanent deletion of a completed report without changing publication", async () => {
    const deleted = showDelete();
    await waitFor(() => expect(screen.getByRole("button", { name: "validation.deleteReport" }).hasAttribute("disabled")).toBe(false));
    expect(deleteTestingReport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "validation.deleteReport" }));
    await waitFor(() => expect(deleteTestingReport).toHaveBeenCalledWith(run.id));
    await waitFor(() => expect(deleted).toHaveBeenCalledOnce());
  });
  it("keeps running reports until their test has finished", async () => {
    vi.mocked(getTestingReportDeletionImpact).mockResolvedValue({ ...impact, running: true, deletable: false });
    showDelete();
    await screen.findByText("validation.deleteReportRunning");
    expect(screen.getByRole("button", { name: "validation.deleteReport" }).hasAttribute("disabled")).toBe(true);
  });
});
