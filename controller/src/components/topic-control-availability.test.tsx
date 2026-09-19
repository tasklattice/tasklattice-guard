import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopicControlUnavailable, useTopicControlAvailability } from "./topic-control-availability";

const getModels = vi.hoisted(() => vi.fn());
vi.mock("@/lib/controller-api", () => ({ getModelConfiguration: getModels }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); getModels.mockReset(); });

const revision = (status = "passed") => ({ assignments: { bindings: { "topic_control.input": "topic" } },
  validationReport: { checks: [{ id: "probe:topic_control.input:topic", status, evidenceKind: "nemo-rail-v1" }] } });
const view = { models: [{ id: "topic", name: "Topic model" }], active: null, draft: null, activating: null };
function show() {
  function Probe() {
    const availability = useTopicControlAvailability(true);
    return availability.ready ? <button>Configure Topic Control</button> : <TopicControlUnavailable availability={availability} />;
  }
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Probe /></QueryClientProvider>);
}

describe("Topic Control runtime availability", () => {
  it.each([
    ["missing", view],
    ["validated", { ...view, draft: revision() }],
    ["activating", { ...view, activating: revision() }],
    ["failed", { ...view, active: revision("failed") }],
    ["unverified", { ...view, active: revision(), models: [] }],
  ])("does not enable configuration for %s assignments", async (state, config) => {
    getModels.mockResolvedValue(config);
    show();
    await screen.findByText(`topicControl.availability.${state}`);
    expect(screen.queryByRole("button", { name: "Configure Topic Control" })).toBeNull();
  });

  it("keeps loading unavailable and allows retry after a settings fetch failure", async () => {
    getModels.mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce({ ...view, active: revision() });
    show();
    expect(screen.getByText("topicControl.availability.loading")).toBeTruthy();
    await screen.findByText("topicControl.availability.error");
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    expect(await screen.findByRole("button", { name: "Configure Topic Control" })).toBeTruthy();
  });

  it("uses the active model even when a newer draft fails", async () => {
    getModels.mockResolvedValue({ ...view, active: revision(), draft: revision("failed") });
    show();
    expect(await screen.findByRole("button", { name: "Configure Topic Control" })).toBeTruthy();
  });
});
