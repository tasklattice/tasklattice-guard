vi.mock("@/components/settings-navigation", () => ({ SettingsNavigation: () => null }));
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectRunnerPage, RunnerPage } from "./runner";

const invalidateQueries = vi.fn().mockResolvedValue(undefined);

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...original,
    useIsFetching: () => 0,
    useQueryClient: () => ({ invalidateQueries }),
  };
});



vi.mock("@/components/runner-capacity", () => ({
  runnerPoolKey: ["resources", "runner-pools"],
  ProjectRunnerCapacity: () => <section aria-label="Project Runner details">Assigned Runner details</section>,
  RunnerCapacitySection: ({ showHeader }: { showHeader?: boolean }) => (
    <section aria-label="Runner capacity" data-show-header={String(showHeader)}>Runner fleet details</section>
  ),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      "runners.pageTitle": "Runner",
      "runnerView.description": "Inspect Runner capacity and convergence.",
      "runnerView.refresh": "Refresh Runner",
      "runnerView.refreshing": "Refreshing Runner…",
    } as Record<string, string>)[key] ?? key,
  }),
}));

describe("RunnerPage", () => {
  afterEach(() => {
    cleanup();
    invalidateQueries.mockClear();
  });

  it("keeps Runner detail separate from global Health and refreshes its own query", async () => {
    const client = new QueryClient();
    render(<QueryClientProvider client={client}><RunnerPage /></QueryClientProvider>);

    expect(screen.getByRole("heading", { name: "Runner", level: 1 })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Runner capacity" }).getAttribute("data-show-header")).toBe("false");
    expect(screen.queryByText("Platform services are ready")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Refresh Runner" }));
    await waitFor(() => expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["resources", "runner-pools"] }));
  });

  it("uses project details on the tenant page and refreshes the same Runner data", async () => {
    render(<ProjectRunnerPage />);
    expect(screen.getByRole("region", { name: "Project Runner details" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Runner capacity" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh Runner" }));
    await waitFor(() => expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["resources", "runner-pools"] }));
  });
});
