import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "@/i18n";
import { ModelValidationEvidence, RuntimeModelEvidence, validationOutputPreview } from "./runtime-model-evidence";
import { downloadLogFile } from "@/lib/http-log-content";
import { ExecutionTrace, playgroundTraceSteps } from "./execution-trace";
import type { RuntimeLogEntry, ModelHttpExchange } from "@/lib/api-types";
const exchange: ModelHttpExchange = { modelCallId: "rpc-failure", provider: "provider", model: "judge", result: "client_error", errorType: "HTTPStatusError",
  request: { method: "POST", url: "https://model.test/chat", headers: [["authorization", "[REDACTED]"]], bodyBase64: btoa("private prompt"), bodyBytes: 14 },
  response: { status: 429, headers: [["x-ratelimit-remaining", "0"], ["x-debug", "first"], ["x-debug", "second"]], bodyBase64: btoa("quota error"), bodyBytes: 10, bodyComplete: true } };
const entry = { id: "event", model_evidence_status: "captured", model_evidence_count: 1 } as RuntimeLogEntry;
vi.mock("@/lib/http-log-content", async (original) => ({ ...await original<typeof import("@/lib/http-log-content")>(), downloadLogFile: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("loads protected evidence only on demand and exposes both headers and bodies", async () => {
  await i18n.changeLanguage("en");
  const load = vi.fn().mockResolvedValue({ ...entry, model_exchanges: [exchange] });
  render(<RuntimeModelEvidence entry={entry} canViewContent loadContent={load} />);
  expect(load).not.toHaveBeenCalled();
  expect(screen.queryByText("private prompt")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "View evidence (1)" }));
  await waitFor(() => expect(screen.getByText(/rpc-failure/)).toBeTruthy());
  fireEvent.click(screen.getByText("Request", {selector:'strong'}));
  fireEvent.click(screen.getByText("Response", {selector:'strong'}));
  expect(screen.getByText("private prompt")).toBeTruthy();
  expect(screen.getByText("quota error")).toBeTruthy();
  expect(screen.getByText(/x-ratelimit-remaining: 0/).textContent).toContain("x-debug: first\nx-debug: second");
  expect(screen.getByRole("button", { name: "Download evidence (JSON)" })).toBeTruthy();
});
it("never fetches or displays payloads without content permission", async () => {
  const load = vi.fn();
  render(<RuntimeModelEvidence entry={entry} canViewContent={false} loadContent={load} />);
  expect(screen.queryByRole('button')).toBeNull();
  expect(load).not.toHaveBeenCalled();
});
it("distinguishes prepared-but-unsent requests, absent responses and incomplete response bodies", async () => {
  render(<RuntimeModelEvidence entry={{...entry,model_exchanges:[{...exchange,request:{...exchange.request,sent:false},response:null}, {...exchange, modelCallId:'partial',response:{...exchange.response!,bodyComplete:false}}]}} canViewContent />);
  fireEvent.click(screen.getByRole('button',{name:'View evidence (1)'}));
  expect(screen.getByText(/prepared but was not sent/)).toBeTruthy();
  expect(screen.getByText(/No HTTP response was received/)).toBeTruthy();
  expect(screen.getByText(/recorded body is incomplete/)).toBeTruthy();
});
it("downloads complete validation evidence beyond the body preview limit", async () => {
  const large = {...exchange, response:{...exchange.response!, bodyBase64:btoa('x'.repeat(100_000)),bodyBytes:100_000}};
  const output = JSON.stringify({decision:'block',model_http_evidence:[large]});
  render(<ModelValidationEvidence id="case" outputContent={output} />);
  fireEvent.click(screen.getByRole('button',{name:'Download evidence (JSON)'}));
  const [bytes] = vi.mocked(downloadLogFile).mock.calls[0];
  expect(JSON.parse(new TextDecoder().decode(bytes))[0]).toEqual(large);
  expect(JSON.parse(validationOutputPreview(output))).toEqual({decision:'block'});
});
it("opens formal validation wire evidence from its trace without a runtime content request", async () => {
  render(<ExecutionTrace steps={playgroundTraceSteps([{id:'http-proof',kind:'model_http_evidence',name:'Model HTTP evidence',status:'completed',detail:'Provider failed',duration_ms:0,evidence:JSON.stringify(exchange)}])} />);
  fireEvent.click(screen.getByRole('button',{name:/Execution trace/i}));
  fireEvent.click(screen.getByRole('button',{name:'View evidence (1)'}));
  expect(screen.getByText(/rpc-failure/)).toBeTruthy();
  expect(screen.getByRole('button',{name:'Download evidence (JSON)'})).toBeTruthy();
});
