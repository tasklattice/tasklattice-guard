import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Policy } from "@/lib/api-types";
import { requestController } from "@/lib/controller-api";
import { downloadLogFile } from "@/lib/http-log-content";
import { policyTestingEn } from "@/policy-testing-i18n";
import { PolicyVersionTest } from "./policy-version-test";

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "u", project_id: "p", role: "user" } }) }));
vi.mock("@/lib/controller-api", () => ({ requestController: vi.fn() }));
vi.mock("@/lib/http-log-content", () => ({ downloadLogFile: vi.fn() }));
vi.mock("@/routes/validation", () => ({ ValidationCaseResults: ({ runId, evidence }: { runId: string; evidence: boolean }) => <div data-testid="case-results">{runId}:{String(evidence)}</div> }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { exists: () => false }, t: (key: string, args: Record<string, unknown> = {}) => {
  let label = key.startsWith("policyTesting.") ? policyTestingEn[key.slice(14) as keyof typeof policyTestingEn] ?? key : key;
  for (const [name, value] of Object.entries(args)) label = label.replaceAll(`{{${name}}}`, String(value));
  return label;
} }) }));

const policy = { id: "content-safety", name: "Content Safety", version: "v2", test_count: 2 } as Policy;
const environment = { poolId: "default", modelRevisionId: "rev-1", models: [] };
const report = { id: "report-1", status: "failed", version: "v2", completed: 2, passed: 1, total: 2, createdAt: "2026-11-07T00:00:00Z", snapshot: { parameters: {}, environment } };
const api = vi.mocked(requestController);
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><PolicyVersionTest policy={policy}><p>Case definitions</p></PolicyVersionTest></QueryClientProvider>);
  return client;
}
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("Policy version Test entry", () => {
  it("explains missing dependencies and disables Test", async () => {
    api.mockImplementation(async path => path.endsWith("test-readiness") ? { ready: false, blockers: [{ code: "runner_unavailable", message: "No healthy testing Runner is available." }], environment } : null);
    const client = mount();
    await screen.findByText("No healthy testing Runner is available.");
    expect((screen.getByRole("button", { name: "Test" }) as HTMLButtonElement).disabled).toBe(true);
    client.clear();
  });
  it("starts the displayed version, shows progress, and prevents repeat submission", async () => {
    api.mockImplementation(async (path, options) => options?.method === "POST" ? { ...report, status: "queued", completed: 0 } : path.endsWith("test-readiness") ? { ready: true, blockers: [], environment } : null);
    const client = mount();
    await waitFor(() => expect((screen.getByRole("button", { name: "Test" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await screen.findByText("0 / 2 completed");
    expect(api).toHaveBeenCalledWith("/api/v1/policies/content-safety/versions/v2/test-runs", { method: "POST" });
    expect((screen.getByRole("button", { name: "Testing…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Export Evidence" }) as HTMLButtonElement).disabled).toBe(true);
    client.clear();
  });
  it.each(["passed", "failed"])("restores a %s report with case evidence and exports its complete document", async status => {
    const document = { report: { ...report, status }, cases: [{ passed: true }, { passed: false }] };
    api.mockImplementation(async path => path.endsWith("test-readiness") ? { ready: true, blockers: [], environment } : path.endsWith("/evidence") ? document : { ...report, status });
    const client = mount();
    await screen.findByText("report-1:true");
    fireEvent.click(screen.getByRole("button", { name: "Export Evidence" }));
    await waitFor(() => expect(downloadLogFile).toHaveBeenCalledOnce());
    const args = vi.mocked(downloadLogFile).mock.calls[0]!;
    expect(JSON.parse(new TextDecoder().decode(args[0]))).toEqual(document);
    client.clear();
  });
});
