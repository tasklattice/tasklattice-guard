import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { TestCaseResult } from "@/lib/api-types";
import { requestController } from "@/lib/controller-api";
import { downloadLogFile } from "@/lib/http-log-content";
import { TestCaseEvidence } from "./test-case-evidence";

vi.mock("@/lib/controller-api", () => ({ requestController: vi.fn() }));
vi.mock("@/lib/http-log-content", async original => ({ ...await original<typeof import("@/lib/http-log-content")>(), downloadLogFile: vi.fn() }));
beforeEach(async () => { await i18n.changeLanguage("en"); vi.clearAllMocks(); });
afterEach(cleanup);

it.each([true, false])("preserves full HTTP evidence for a case with passed=%s", async passed => {
  const exchange = { request: { method: "POST", url: "https://model.test/v1/systemone", headers: [["authorization", "[REDACTED]"]], bodyBase64: btoa('{"text":"wire sample"}') }, response: { status: 200, bodyBase64: btoa('{"unsafe_content":0.83}') } };
  const detail = { caseId: "case-1", passed, inputContent: "Fixture sample", outputContent: "Output sample", expectedDecision: "block", actualDecision: passed ? "block" : "allow", reason: "Assessment",
    trace: [{ kind: "model_http_evidence", evidence: JSON.stringify(exchange) }], matchedRuleIds: passed ? ["target"] : [], testDefinition: { expected_text: null } };
  vi.mocked(requestController).mockResolvedValue(detail);
  const result = { case_id: "case-1", name: "Example case", passed, source_policy_id: "p", source_policy_version: "v2" } as TestCaseResult;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><TestCaseEvidence runId="report-1" ordinal={4} result={result} /></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: `${passed ? "Pass" : "Failed"} evidence · Example case` }));
  await screen.findByText("Fixture sample");
  expect(screen.getAllByText("Output sample")).toHaveLength(1);
  fireEvent.click(screen.getByRole("tab", { name: /HTTP calls/ }));
  expect(screen.getByText(/unsafe_content/)).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Payload", exact: true }));
  expect(screen.getByText(/wire sample/)).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Headers", exact: true }));
  expect(screen.getByText("[REDACTED]")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Export Evidence", exact: true }));
  await waitFor(() => expect(downloadLogFile).toHaveBeenCalledOnce());
  const [bytes] = vi.mocked(downloadLogFile).mock.calls[0]!;
  expect(JSON.parse(new TextDecoder().decode(bytes))).toMatchObject({ runId: "report-1", case: detail });
  expect(requestController).toHaveBeenCalledWith("/api/v1/test-runs/report-1/cases/4/evidence", expect.anything());
  client.clear();
});
