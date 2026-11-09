import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { queryKeys } from "@/features/query-keys";
import type { ValidationRun } from "@/lib/api";
import { ValidationRunProgress } from "./validation-run-progress";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const run = { id: "exact-run", guardrail_id: "guard", status: "incomplete", execution_status: "running",
  created_at: new Date().toISOString(), metrics: { total: 10 }, results: [] } as unknown as ValidationRun;

function show(canCancel = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><ValidationRunProgress run={run} startedAt={Date.now()} canCancel={canCancel} /></QueryClientProvider>);
  return client;
}

describe("Stop an asynchronous test", () => {
  it("cancels the exact run ID and updates the report cache", async () => {
    const cancelled = { ...run, status: "cancelled", execution_status: "cancelled" } as ValidationRun;
    const stop = vi.spyOn(api, "cancelValidationRun").mockResolvedValue(cancelled);
    const client = show();
    fireEvent.click(screen.getByRole("button", { name: "validationControl.stop" }));
    await waitFor(() => expect(stop).toHaveBeenCalledExactlyOnceWith("exact-run"));
    await screen.findByRole("button", { name: "validationControl.stopped" });
    expect(client.getQueryData(queryKeys.validationRun(run.id))).toEqual(cancelled);
  });

  it("does not expose the action to a read-only caller", () => {
    show(false);
    expect(screen.queryByRole("button", { name: "validationControl.stop" })).toBeNull();
  });

  it("keeps stop available for retry after an API error", async () => {
    const stop = vi.spyOn(api, "cancelValidationRun").mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValueOnce({ ...run, status: "cancelled", execution_status: "cancelled" });
    show();
    fireEvent.click(screen.getByRole("button", { name: "validationControl.stop" }));
    await screen.findByText("Connection lost");
    fireEvent.click(screen.getByRole("button", { name: "validationControl.stop" }));
    await screen.findByRole("button", { name: "validationControl.stopped" });
    expect(stop).toHaveBeenCalledTimes(2);
  });
});
