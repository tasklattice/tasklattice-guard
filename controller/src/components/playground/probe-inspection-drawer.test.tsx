import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlaygroundCheckResult, PlaygroundInteraction } from "@/lib/api";

import { StageTabs } from "./probe-inspection-drawer";

vi.mock("react-i18next", () => ({
  useTranslation: () => {
    const translations: Record<string, string> = {
      "playground.inspectionStages": "Guardrail checkpoints",
      "playground.inputRail": "Input Rail",
      "playground.outputRail": "Output Rail",
      "playground.requestSentToModel": "Request sent to model",
      "playground.requestStoppedBeforeModel": "Request stopped before model",
      "playground.responseReceivedFromModel": "Response received from model",
      "playground.noModelResponse": "No model response",
      "playground.decisions.allow": "Allowed",
      "playground.decisions.block": "Blocked",
      "playground.decisions.transform": "Transformed",
      "playground.notRun": "Not run",
      "playground.requestCheck": "Request check",
      "playground.requestCheckDescription": "Request checkpoint description",
      "playground.responseCheck": "Response check",
      "playground.responseCheckDescription": "Response checkpoint description",
      "playground.responseCheckSkipped": "Response check was not run",
      "playground.responseCheckSkippedDescription": "The request was blocked before the model, so there was no model response to inspect.",
      "playground.triggeredPolicy": "Triggered Policy",
      "playground.triggeredRule": "Triggered rule",
      "playground.latency": "Latency",
      "playground.runtime": "Runtime",
      "playground.evaluatedPolicies": "Evaluated Policies",
      "playground.policyCount": "{{count}} evaluated",
      "playground.policyStates.matched": "Matched",
      "playground.findings": "Findings",
      "playground.severity.low": "Low",
      "playground.executionTrace": "Execution trace",
      "playground.matchedSteps": "{{count}} matched steps",
    };
    return {
      t: (key: string, values?: Record<string, string | number>) =>
        Object.entries(values ?? {}).reduce(
          (label, [name, value]) => label.replace(`{{${name}}}`, String(value)),
          translations[key] ?? key,
        ),
      i18n: {
        exists: (key: string) => key in translations,
        language: "en",
      },
    };
  },
}));

function checkResult(
  phase: PlaygroundCheckResult["phase"],
  overrides: Partial<PlaygroundCheckResult> = {},
): PlaygroundCheckResult {
  const input = phase === "input";
  return {
    check_id: `${phase}-check`,
    trace_id: `${phase}-trace`,
    evidence_id: `${phase}-evidence`,
    guardrail: {
      id: "guardrail-1",
      name: "Customer safety",
      version: "20260904-030000.003Z",
      published_at: "2026-08-14T07:55:44Z",
      compiler_version: "nemo-native-v1",
    },
    phase,
    decision: "allow",
    action: "pass",
    output_content: input ? "Effective request" : "Safe response",
    latency_ms: input ? 7 : 11,
    reason: input ? "Unique input checkpoint reason" : "Unique output checkpoint reason",
    runtime: "nemo-native",
    triggered_policy: input
      ? { id: "policy-input", name: "Input safety Policy" }
      : { id: "policy-output", name: "Output safety Policy" },
    triggered_rule: input
      ? { id: "rule-input", name: "Input rule" }
      : { id: "rule-output", name: "Output rule" },
    policies: [
      {
        id: input ? "policy-input" : "policy-output",
        name: input ? "Input safety Policy" : "Output safety Policy",
        risk: input ? "prompt_injection" : "unsafe_output",
        status: "matched",
        duration_ms: input ? 4 : 6,
      },
    ],
    findings: [
      {
        id: `${phase}-finding`,
        severity: "low",
        title: `${phase} finding`,
        detail: `${phase} finding detail`,
        confidence: 0.91,
        recommended_action: "Review",
        policy_id: input ? "policy-input" : "policy-output",
        rule_id: input ? "rule-input" : "rule-output",
      },
    ],
    trace_summary: { steps: 1, matched_steps: 1 },
    trace: [
      {
        id: `${phase}-step`,
        kind: "policy",
        name: `${phase} trace step`,
        status: "matched",
        detail: `${phase} trace detail`,
        duration_ms: input ? 4 : 6,
        parent_id: null,
        contract_ref: `tali.guard.${input ? "prompt-injection" : "content-safety"}.v1`,
        verdict: "allow",
        route: "default",
        capability: input ? "prompt_injection" : "content_safety",
        confidence: 0.91,
        policy_id: input ? "policy-input" : "policy-output",
        policy_version: "1",
        rail_type: phase,
        flow_name: `${phase}_flow`,
        action_name: "check_content",
        action_version: "1",
        outcome: "allow",
        engine: "nemo-native",
      },
    ],
    ...overrides,
  };
}

function interaction(
  overrides: Partial<PlaygroundInteraction> = {},
): PlaygroundInteraction {
  return {
    interaction_id: "interaction-completed",
    state: "completed",
    user_message: "Can you help?",
    effective_user_message: "Can you help?",
    assistant_message: "Of course.",
    model: {
      id: "model-1",
      provider: "openai",
      name: "GPT Test",
      icon: "openai",
      latency_ms: 25,
    },
    input_check: checkResult("input"),
    output_check: checkResult("output"),
    ...overrides,
  };
}

function tabs() {
  return {
    input: screen.getByRole("tab", { name: /Input Rail/ }),
    output: screen.getByRole("tab", { name: /Output Rail/ }),
  };
}

function clickTab(tab: HTMLElement) {
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
  fireEvent.mouseUp(tab, { button: 0, ctrlKey: false });
  fireEvent.click(tab);
}

describe("StageTabs", () => {
  afterEach(cleanup);

  it("exposes the input checkpoint as the default accessible tab and panel", () => {
    render(<StageTabs result={interaction()} />);

    expect(screen.getByRole("tablist", { name: "Guardrail checkpoints" })).toBeTruthy();
    const { input, output } = tabs();
    const panel = screen.getByRole("tabpanel");

    expect(input.getAttribute("aria-label")).toBeNull();
    expect(input.textContent).toContain("Request sent to model");
    expect(input.textContent).toContain("Allowed");
    expect(output.textContent).toContain("Response received from model");
    expect(output.textContent).toContain("Allowed");
    expect(input.getAttribute("aria-selected")).toBe("true");
    expect(output.getAttribute("aria-selected")).toBe("false");
    expect(input.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("aria-labelledby")).toBe(input.id);
    expect(screen.getByRole("heading", { name: "Request check" })).toBeTruthy();
    expect(screen.getByText("Unique input checkpoint reason")).toBeTruthy();
    expect(screen.queryByText("Unique output checkpoint reason")).toBeNull();
  });

  it("switches to output checkpoint content when the output tab is clicked", () => {
    render(<StageTabs result={interaction()} />);

    const { input, output } = tabs();
    clickTab(output);

    expect(input.getAttribute("aria-selected")).toBe("false");
    expect(output.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "Response check" })).toBeTruthy();
    expect(screen.getByText("Unique output checkpoint reason")).toBeTruthy();
    expect(screen.queryByText("Unique input checkpoint reason")).toBeNull();
  });

  it("uses horizontal arrow keys to focus, select, and reveal the output tab", async () => {
    render(<StageTabs result={interaction()} />);

    const { input, output } = tabs();
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowRight", code: "ArrowRight" });

    await waitFor(() => expect(document.activeElement).toBe(output));
    expect(output.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Unique output checkpoint reason")).toBeTruthy();

    fireEvent.keyDown(output, { key: "ArrowLeft", code: "ArrowLeft" });
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Unique input checkpoint reason")).toBeTruthy();
  });

  it("defaults an output-blocked interaction to the output checkpoint", () => {
    render(
      <StageTabs
        result={interaction({
          interaction_id: "interaction-output-blocked",
          state: "output_blocked",
          assistant_message: null,
          output_check: checkResult("output", {
            decision: "block",
            action: "reject",
          }),
        })}
      />,
    );

    const { input, output } = tabs();
    expect(input.getAttribute("aria-selected")).toBe("false");
    expect(output.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Unique output checkpoint reason")).toBeTruthy();
  });

  it("explains a skipped output checkpoint after an input block", () => {
    render(
      <StageTabs
        result={interaction({
          interaction_id: "interaction-input-blocked",
          state: "input_blocked",
          effective_user_message: null,
          assistant_message: null,
          model: {
            id: "model-1",
            provider: "openai",
            name: "GPT Test",
            icon: "openai",
            latency_ms: null,
          },
          input_check: checkResult("input", {
            decision: "block",
            action: "reject",
          }),
          output_check: null,
        })}
      />,
    );

    expect(tabs().input.textContent).toContain("Request stopped before model");
    expect(tabs().input.textContent).toContain("Blocked");
    expect(tabs().output.textContent).toContain("No model response");
    expect(tabs().output.textContent).toContain("Not run");
    clickTab(tabs().output);

    expect(screen.getByRole("heading", { name: "Response check was not run" })).toBeTruthy();
    expect(
      screen.getByText(
        "The request was blocked before the model, so there was no model response to inspect.",
      ),
    ).toBeTruthy();
  });

  it("exposes a transformed stage with text instead of relying on color", () => {
    render(
      <StageTabs
        result={interaction({
          input_check: checkResult("input", {
            decision: "transform",
            action: "redact",
          }),
        })}
      />,
    );

    expect(tabs().input.textContent).toContain("Transformed");
  });

  it("resets to the correct default tab when a new interaction is rendered", () => {
    const { rerender } = render(<StageTabs result={interaction()} />);
    clickTab(tabs().output);
    expect(tabs().output.getAttribute("aria-selected")).toBe("true");

    rerender(
      <StageTabs
        result={interaction({ interaction_id: "interaction-completed-2" })}
      />,
    );
    expect(tabs().input.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Unique input checkpoint reason")).toBeTruthy();

    rerender(
      <StageTabs
        result={interaction({
          interaction_id: "interaction-output-blocked-2",
          state: "output_blocked",
          output_check: checkResult("output", {
            decision: "block",
            action: "reject",
          }),
        })}
      />,
    );
    expect(tabs().output.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Unique output checkpoint reason")).toBeTruthy();
  });
});
