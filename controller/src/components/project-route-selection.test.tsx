import { StrictMode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectRouteSelection } from "./project-route-selection";

const mocks = vi.hoisted(() => ({ select: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { project_id: "test1" }, refreshSession: mocks.refresh }) }));
vi.mock("@/lib/projects-api", () => ({ selectProject: mocks.select }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let client: QueryClient;
beforeEach(() => { mocks.select.mockReset(); mocks.refresh.mockReset().mockResolvedValue(undefined); });
afterEach(() => { cleanup(); client.clear(); });
function mount() {
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(<StrictMode><QueryClientProvider client={client}><ProjectRouteSelection projectId="test2" /></QueryClientProvider></StrictMode>);
}

it("selects the address's project once and refreshes authority before loading it", async () => {
  let finish!: () => void;
  mocks.select.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  mount();
  await waitFor(() => expect(mocks.select).toHaveBeenCalledExactlyOnceWith("test2"));
  expect(screen.getByRole("status").textContent).toBe("projects.switching");
  expect(mocks.refresh).not.toHaveBeenCalled();
  finish();
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
});

it("keeps denied projects blocked and offers retry or the current project's home", async () => {
  mocks.select.mockRejectedValueOnce(new Error("Project access denied"));
  mount();
  expect(await screen.findByText("Project access denied")).toBeTruthy();
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: "nav.dashboard" }).getAttribute("href")).toBe("/test1");
  mocks.select.mockResolvedValueOnce(undefined);
  fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
});
