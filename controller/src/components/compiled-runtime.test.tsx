import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GuardrailVersionDetail } from "@/lib/api";

import { CompiledRuntime } from "./compiled-runtime";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => Object.entries(values ?? {}).reduce((label, [name, value]) => `${label} ${name}:${value}`, key),
  }),
}));

const detail: GuardrailVersionDetail = {
  guardrail_id: "guardrail-observed",
  version: "20260904-020000.002Z",
  source_draft_version: 3,
  compiler_version: "tasklattice-nemo-config-v7",
  plan_checksum: "plan-checksum",
  config_checksum: "config-checksum",
  created_at: "2026-08-13T08:00:00Z",
  active: true,
  runtime_engine: "llmrails",
  execution_mode: "nemo_only",
  safety_level: "balanced",
  output_delivery: "window_buffered",
  runtime_profile: "llmrails_colang1_standard",
  colang_version: "1.0",
  rails: [{ rail_type: "input", flow: "protect input" }],
  actions: [{ name: "GuardContentFilterAction", version: "1.0.0", flow: "protect input", phases: ["input"], timeout_ms: 2500, failure_mode: "closed" }],
  models: ["nvidia/safety-guard"],
  features: [],
  dependencies: [{ kind: "action", name: "GuardContentFilterAction", version: "1.0.0" }],
  estimated_critical_path_ms: 2500,
  policy_bindings: [],
  artifacts: [
    { path: "config.yml", language: "yaml", content: "rails:\n  input: protect input" },
    { path: "rails.co", language: "colang", content: "define flow protect input" },
  ],
};

describe("CompiledRuntime", () => {
  afterEach(cleanup);

  it("keeps the semantic summary and generated files in one tabbed component", () => {
    render(<CompiledRuntime detail={detail} />);

    expect(screen.getByText("guardrails.compiledRuntime")).toBeTruthy();
    expect(screen.getByText("guardrails.compiledRuntimeSummary rails:1 actions:1 models:1 files:2")).toBeTruthy();
    expect(screen.getByText("protect input")).toBeTruthy();
    expect(screen.getByText("GuardContentFilterAction@1.0.0")).toBeTruthy();
    expect(screen.getByText("model:nvidia/safety-guard")).toBeTruthy();
    expect(screen.getByText("action:GuardContentFilterAction@1.0.0")).toBeTruthy();

    const filesTab = screen.getByRole("tab", { name: "guardrails.generatedFilesTab count:2" });
    expect(filesTab.getAttribute("data-state")).toBe("inactive");
    fireEvent.mouseDown(filesTab, { button: 0, ctrlKey: false });
    fireEvent.mouseUp(filesTab, { button: 0, ctrlKey: false });
    fireEvent.click(filesTab);
    expect(filesTab.getAttribute("data-state")).toBe("active");
    expect(screen.getAllByText("config.yml").length).toBeGreaterThan(0);
    expect(screen.getByText(/input: protect input/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "rails.co" }));
    expect(screen.getByText("define flow protect input")).toBeTruthy();
  });
});
