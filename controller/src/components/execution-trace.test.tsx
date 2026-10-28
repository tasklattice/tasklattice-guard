import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ExecutionTracePanel } from "@/components/playground/probe-insights";
import { ExecutionTrace, playgroundTraceSteps } from "./execution-trace";
import { runtimeTraceSteps } from "@/lib/controller-api-mappers";
import type { PlaygroundCheckResult, RuntimeTraceStep } from "@/lib/api";
import type { RuntimeEvent } from "@/lib/controller-api";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, values?: { name?: string }) => values?.name ? `${key} ${values.name}` : key, i18n: { exists: () => false } }),
}));
afterEach(cleanup);
it("surfaces provider failure in the collapsed Trace and explains it before the raw error", () => {
  const detail = "All eligible Safety Providers failed: pii_semantic.input:9ec3a7b2-9532-4739-8c2d-db7c887697d5:0: HTTPStatusError";
  render(<ExecutionTrace steps={[{ id: "provider", name: "Privacy check", kind: "action", outcome: "error", latency_ms: 100, detail }]} description={detail} />);
  expect(screen.getByText("logs.traceErrors")).toBeTruthy();
  expect(screen.queryByText(detail)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /logs.executionTrace/ }));
  expect(screen.getAllByText("logs.traceFailureTitles.model")).toHaveLength(1);
  expect(screen.getByText("logs.traceFailures.http")).toBeTruthy();
  expect(screen.getByText(/pii_semantic.input/, { selector: "p" })).toBeTruthy();
  const technicalDetails = screen.getByText(detail).closest("details")!;
  expect(technicalDetails.open).toBe(false);
  fireEvent.click(screen.getByText("logs.technicalDetails"));
  expect(technicalDetails.open).toBe(true);
  expect(screen.queryByText(/HTTP 401|HTTP 429|HTTP 500/)).toBeNull();
});

it("explains provider failures in older reports without spans", () => {
  render(<ExecutionTrace steps={[]} description="All eligible Safety Providers failed: provider: HTTPStatusError" />);
  fireEvent.click(screen.getByRole("button", { name: /logs.executionTrace/ }));
  expect(screen.getByText("logs.traceFailureTitles.model")).toBeTruthy();
  expect(screen.getByText("logs.traceFailures.http")).toBeTruthy();
});

it("keeps the original case explanation available on demand even without recorded spans", () => {
  render(<ExecutionTrace steps={[]} description="Provider returned an invalid response; expected Block, received Allow." />);
  expect(screen.queryByText(/Provider returned/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /logs.executionTrace/ }));
  expect(screen.getByText(/Provider returned/)).toBeTruthy();
  expect(screen.queryByText("logs.traceEmpty")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /logs.executionTrace/ }));
  expect(screen.queryByText(/Provider returned/)).toBeNull();
});
const steps: RuntimeTraceStep[] = [
  { id: "root", kind: "runtime", name: "Runtime", status: "active", detail: "Runtime detail", duration_ms: 10 },
  { id: "child", parent_id: "root", kind: "action", name: "Action", status: "completed", outcome: "matched", verdict: "matched", detail: "Action detail", duration_ms: 7, parallel_group: "group" },
];
it("renders the same hierarchy, outcomes, and interactions for Playground and Logs", () => {
  const telemetry = { metadata: { trace: steps.map(step => ({ ...step, parentId: step.parent_id, durationMs: step.duration_ms, parallelGroup: step.parallel_group })) } } as unknown as RuntimeEvent;
  const { container, unmount } = render(<ExecutionTrace steps={runtimeTraceSteps(telemetry)} />);
  expect(screen.getByRole("button", { name: /logs.executionTrace/ }).getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("Runtime")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /logs.executionTrace/ }));
  const logsMarkup = container.textContent;
  unmount();
  const playground = render(<ExecutionTracePanel result={{ trace_id: "trace", trace: steps } as PlaygroundCheckResult} />);
  expect(screen.queryByText("Runtime")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /logs.executionTrace/ }));
  expect(playground.container.textContent).toBe(logsMarkup);
  expect(playgroundTraceSteps(steps)[1]?.outcome).toBe("matched");
  fireEvent.click(screen.getByRole("button", { name: "logs.collapseSpan Runtime" }));
  expect(screen.queryByText("Action")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "logs.expandSpan Runtime" }));
  fireEvent.click(screen.getByRole("button", { name: "logs.inspectSpan Action" }));
  expect(screen.getByText("Action detail")).toBeTruthy();
  expect(screen.getByText("root")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /logs.executionTrace/ }));
  expect(screen.queryByText("Action detail")).toBeNull();
  expect(screen.queryByText("Runtime")).toBeNull();
});
