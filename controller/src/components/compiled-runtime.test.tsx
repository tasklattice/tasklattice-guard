import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GuardrailVersionDetail } from "@/lib/api";

import { CompiledRuntime, GeneratedVersionFiles } from "./compiled-runtime";

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
    const { container } = render(<CompiledRuntime detail={detail} />);

    expect(screen.getByText("guardrails.compiledRuntime")).toBeTruthy();
    expect(screen.getByText("guardrails.compiledRuntimeSummary rails:1 actions:1 models:1 files:2")).toBeTruthy();
    expect(screen.getByText("protect input")).toBeTruthy();
    expect(screen.getByText("GuardContentFilterAction@1.0.0")).toBeTruthy();
    expect(screen.getByText("model:nvidia/safety-guard")).toBeTruthy();
    expect(screen.getByText("action:GuardContentFilterAction@1.0.0")).toBeTruthy();

    const filesTab = screen.getByRole("tab", { name: "guardrails.generatedFilesTab count:2" });
    expect(filesTab.getAttribute("data-state")).toBe("inactive");
    fireEvent.click(filesTab, { button: 0, ctrlKey: false });
    fireEvent.mouseUp(filesTab, { button: 0, ctrlKey: false });
    fireEvent.click(filesTab);
    expect(filesTab.getAttribute("data-state")).toBe("active");
    expect(screen.getAllByText("config.yml").length).toBeGreaterThan(0);
    expect(container.querySelector("pre")!.textContent).toContain("input: protect input");

    fireEvent.click(screen.getByRole("button", { name: "rails.co" }));
    expect(container.querySelector("pre")!.textContent).toBe("define flow protect input");
  });
});


it("uses the selected file's language and resets its code scroll position on file changes", () => {
  const { container } = render(<GeneratedVersionFiles fillHeight detail={{ ...detail, artifacts: [
    { path: "config/config.yml", language: "yaml", content: "enabled: true\n" },
    { path: "artifact/plan.json", language: "json", content: '{"steps":[],"limit":32}' },
  ] }} />);
  const previous = container.querySelector("pre")!;
  expect(previous.dataset.language).toBe("yaml");
  previous.scrollTop = 200;
  previous.scrollLeft = 100;
  fireEvent.click(screen.getByRole("button", { name: "artifact/plan.json" }));
  const current = container.querySelector("pre")!;
  expect(current.dataset.language).toBe("json");
  expect(current.querySelector(".token.property")!.textContent).toBe('"steps"');
  expect(current.textContent).toBe('{"steps":[],"limit":32}');
  expect(current.scrollTop).toBe(0);
  expect(current.scrollLeft).toBe(0);
});
