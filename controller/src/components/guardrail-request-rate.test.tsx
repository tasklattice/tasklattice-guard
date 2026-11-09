import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { GuardrailRequestRate } from "./guardrail-request-rate";
vi.mock("@tanstack/react-router", () => ({ Link: ({ children, className }: { children: ReactNode; className?: string }) => <a className={className}>{children}</a> }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, values?: { total?: string }) => values?.total ?? key, i18n: { language: "en" } }) }));
afterEach(cleanup);
const points = [{ timestamp: "2026-10-19T01:00:00Z", total: 0 }, { timestamp: "2026-10-19T02:00:00Z", total: 0 }];
it("shows a flat zero line only for a successful no-traffic snapshot", () => {
  const { container } = render(<GuardrailRequestRate guardrailId="one" name="Guardrail" points={points} />);
  expect(container.querySelector("polyline")?.getAttribute("points")).toBe("2,34 158,34");
  expect(screen.getByText("0")).toBeTruthy();
});
it("hides stale data on failure, then restores the line after recovery", () => {
  const view = render(<GuardrailRequestRate guardrailId="one" name="Guardrail" points={points} error />);
  expect(screen.getByText("guardrails.requestRateUnavailable")).toBeTruthy();
  expect(view.container.querySelector("svg")).toBeNull();
  expect(screen.queryByText("0")).toBeNull();
  view.rerender(<GuardrailRequestRate guardrailId="one" name="Guardrail" points={points} />);
  expect(view.container.querySelector("svg")).toBeTruthy();
});
it("keeps loading distinct from zero traffic", () => {
  const { container } = render(<GuardrailRequestRate guardrailId="one" name="Guardrail" loading />);
  expect(screen.getByText("common.loading")).toBeTruthy();
  expect(container.querySelector("svg")).toBeNull();
});
