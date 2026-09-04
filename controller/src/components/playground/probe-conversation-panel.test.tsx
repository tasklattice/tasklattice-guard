import { useCallback, useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { Guardrail, GuardrailVersion, PlaygroundInteraction, PlaygroundModel } from "@/lib/api";

import { ProbeConversationPanel } from "./probe-conversation-panel";

vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
});
Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", exists: () => false },
  }),
}));

vi.mock("@/components/playground/guardrail-result-card", () => ({
  GuardrailResultCard: () => <div data-testid="guardrail-result" />,
}));

vi.mock("@/components/playground/model-mark", () => ({
  ModelMark: () => <span data-testid="model-mark" />,
}));

const model: PlaygroundModel = {
  id: "model-1",
  provider: "Test Provider",
  name: "Test Model",
  icon: "test",
};

const guardrail = {
  id: "guardrail-1",
  name: "Test Guardrail",
  draft_revision: 2,
} as Guardrail;

const version = {
  guardrail_id: guardrail.id,
  version: "20260904-020000.002Z",
  source_draft_version: 2,
  compiler_version: "test",
  plan_checksum: "plan",
  created_at: "2026-08-23T08:00:00Z",
  active: true,
  runtime_engine: "llmrails",
  config_checksum: "config",
  execution_mode: "nemo_only",
} satisfies GuardrailVersion;

function interaction(id: string, userMessage: string, assistantMessage: string): PlaygroundInteraction {
  return {
    interaction_id: id,
    state: "completed",
    user_message: userMessage,
    effective_user_message: userMessage,
    assistant_message: assistantMessage,
    model: { ...model, latency_ms: 25 },
    input_check: {} as PlaygroundInteraction["input_check"],
    output_check: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function ConversationHarness({ request }: { request: (message: string) => Promise<PlaygroundInteraction> }) {
  const [turns, setTurns] = useState([interaction("turn-1", "First question", "First answer")]);
  const [pending, setPending] = useState(false);
  const submit = useCallback(async (message: string) => {
    setPending(true);
    try {
      const result = await request(message);
      setTurns((current) => [...current, result]);
    } finally {
      setPending(false);
    }
  }, [request]);

  return (
    <ProbeConversationPanel
      guardrail={guardrail}
      guardrails={[guardrail]}
      versions={[version]}
      target={{ kind: "published", version: version.version }}
      selectedVersion={version}
      versionsLoading={false}
      canTestDraft
      draftPreparing={false}
      draftError={null}
      turns={turns}
      models={[model]}
      modelId={model.id}
      pending={pending}
      onModelChange={() => undefined}
      onSubmitMessage={submit}
      onClear={() => undefined}
      onGuardrailChange={() => undefined}
      onTargetChange={() => undefined}
      onRetryDraft={() => undefined}
      onViewDetails={() => undefined}
    />
  );
}

describe("ProbeConversationPanel", () => {
  afterAll(() => {
    vi.unstubAllGlobals();
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
  });
  afterEach(cleanup);

  it("shows the submitted user message and assistant waiting state after an existing turn", async () => {
    const response = deferred<PlaygroundInteraction>();
    const request = vi.fn(() => response.promise);
    render(<ConversationHarness request={request} />);

    const input = screen.getByLabelText("playground.messageModel");
    fireEvent.change(input, { target: { value: "Second question" } });
    fireEvent.click(screen.getByRole("button", { name: "playground.sendMessage" }));

    await waitFor(() => expect(request).toHaveBeenCalledWith("Second question"));
    expect(screen.getByText("Second question")).toBeTruthy();
    expect(screen.getByText("playground.processingTurnDescription")).toBeTruthy();
    expect(screen.getByRole("button", { name: "playground.sendMessage" }).querySelector(".animate-spin")).toBeTruthy();

    await act(async () => response.resolve(interaction("turn-2", "Second question", "Second answer")));

    await waitFor(() => expect(screen.queryByText("playground.processingTurnDescription")).toBeNull());
    expect(screen.getAllByText("Second question")).toHaveLength(1);
    expect(screen.getByText("Second answer")).toBeTruthy();
  });

  it("restores the submitted text when the request fails", async () => {
    const response = deferred<PlaygroundInteraction>();
    render(<ConversationHarness request={() => response.promise} />);

    const input = screen.getByLabelText("playground.messageModel") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Please retry this" } });
    fireEvent.click(screen.getByRole("button", { name: "playground.sendMessage" }));

    await waitFor(() => expect(screen.getByText("playground.processingTurnDescription")).toBeTruthy());
    await act(async () => response.reject(new Error("Request failed")));

    await waitFor(() => expect(input.value).toBe("Please retry this"));
    expect(screen.queryByText("playground.processingTurnDescription")).toBeNull();
    expect(screen.queryByText("Please retry this", { selector: "p" })).toBeNull();
  });
});
