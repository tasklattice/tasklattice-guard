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
const steps: RuntimeTraceStep[] = [
  { id: "root", kind: "runtime", name: "Runtime", status: "active", detail: "Runtime detail", duration_ms: 10 },
  { id: "child", parent_id: "root", kind: "action", name: "Action", status: "completed", outcome: "unsafe", verdict: "unsafe", detail: "Action detail", duration_ms: 7, parallel_group: "group" },
];
it("renders the same hierarchy, outcomes, and interactions for Playground and Logs", () => {
  const telemetry = { metadata: { trace: steps.map(step => ({ ...step, parentId: step.parent_id, durationMs: step.duration_ms, parallelGroup: step.parallel_group })) } } as unknown as RuntimeEvent;
  const { container, unmount } = render(<ExecutionTrace steps={runtimeTraceSteps(telemetry)} />);
  const logsMarkup = container.innerHTML;
  unmount();
  const playground = render(<ExecutionTracePanel result={{ trace_id: "trace", trace: steps } as PlaygroundCheckResult} />);
  expect(playground.container.innerHTML).toBe(logsMarkup);
  expect(playgroundTraceSteps(steps)[1]?.outcome).toBe("unsafe");
  fireEvent.click(screen.getByRole("button", { name: "logs.collapseSpan Runtime" }));
  expect(screen.queryByText("Action")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "logs.expandSpan Runtime" }));
  fireEvent.click(screen.getByRole("button", { name: "logs.inspectSpan Action" }));
  expect(screen.getByText("Action detail")).toBeTruthy();
  expect(screen.getByText("root")).toBeTruthy();
});
