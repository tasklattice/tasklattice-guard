import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeLogInteraction } from "@/lib/api";

import { CheckpointHistory } from "./logs";

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      values?.version === undefined ? key : `${key} ${values.version}`,
    i18n: { language: "en-US", exists: () => false },
  }),
}));

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "admin" } }) }));

const interaction: RuntimeLogInteraction = {
  id: "runtime-log-1",
  created_at: "2026-08-15T05:00:00Z",
  completed_at: "2026-08-15T05:00:01Z",
  guardrail_id: "guardrail-1",
  guardrail_version: "20260904-030000.003Z",
  deployment_id: "deployment-1",
  integration_id: null,
  protocol: "openai",
  outcome: "block",
  capture_level: "trace",
  entries: [
    {
      id: "entry-input",
      trace_id: "trace-input",
      created_at: "2026-08-15T05:00:00Z",
      phase: "input",
      outcome: "allow",
      action: "pass",
      risk: null,
      latency_ms: 5,
      timed_out: false,
      detail: "Inbound request approved",
      content_before: null,
      content_after: null,
      content_available: true,
      findings: [],
      steps: [],
    },
    {
      id: "entry-output",
      trace_id: "trace-output",
      created_at: "2026-08-15T05:00:01Z",
      phase: "output",
      outcome: "block",
      action: "block",
      risk: "sensitive_data",
      latency_ms: 8,
      timed_out: false,
      detail: "Outbound response blocked",
      content_before: null,
      content_after: null,
      content_available: true,
      findings: [],
      steps: [],
    },
  ],
};

const baseProps = {
  interactions: [interaction],
  loading: false,
  error: null,
  onInspect: vi.fn(),
  guardrailName: () => "Runtime Guardrail",
  deploymentName: () => "Runtime Deployment",
};

describe("CheckpointHistory", () => {
  afterEach(cleanup);

  it("renders one traffic checkpoint per inbound and outbound log entry", () => {
    render(<CheckpointHistory {...baseProps} />);

    expect(screen.getByText("Inbound request approved")).toBeTruthy();
    expect(screen.getByText("Outbound response blocked")).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.queryByText(/policy \/ version \/ published/i)).toBeNull();
    expect(screen.queryByText(/validation completed/i)).toBeNull();
  });

  it("renders only checkpoints supplied by the shared runtime query", () => {
    render(<CheckpointHistory {...baseProps} interactions={[{ ...interaction, entries: [interaction.entries[0]!] }]} />);

    expect(screen.getByText("Inbound request approved")).toBeTruthy();
    expect(screen.queryByText("Outbound response blocked")).toBeNull();
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });
});
