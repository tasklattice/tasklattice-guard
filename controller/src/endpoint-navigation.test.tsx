import { createMemoryHistory, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routeTree } from "./app-router";

vi.mock("@/routes/layout", () => ({ ControlPlaneLayout: () => <Outlet /> }));
vi.mock("@/routes/router-detail", () => ({ RouterDetailPage: () => <h1>Router detail</h1> }));
// Exercise the actual route's URL/selection contract independently of Endpoint API loading.
vi.mock("@/routes/endpoints", () => ({
  EndpointsPage: ({ endpointId, onEndpointChange }: { endpointId?: string; onEndpointChange: (id?: string) => void }) => <>
    <h1>Endpoints</h1>
    <button onClick={() => onEndpointChange("source")}>Open endpoint</button>
    {endpointId && <div role="dialog" aria-label={endpointId}><button onClick={() => onEndpointChange(undefined)}>Close endpoint</button></div>}
  </>,
}));
afterEach(cleanup);

async function setup(path = "/integration/routers/router-test") {
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({ routeTree, history });
  await router.load();
  render(<RouterProvider router={router} />);
  return { router, history };
}

describe("Endpoint detail history", () => {
  it("Back closes a detail entered from Router; Forward reopens the same endpoint", async () => {
    const { router, history } = await setup();
    await router.navigate({ to: "/integration/endpoint", search: { endpointId: "source" } });
    await screen.findByRole("dialog", { name: "source" });
    history.back();
    await screen.findByRole("heading", { name: "Router detail" });
    expect(screen.queryByRole("dialog")).toBeNull();
    history.forward();
    await screen.findByRole("dialog", { name: "source" });
  });

  it("explicit Close does not reopen the sheet on the next Back", async () => {
    const { router, history } = await setup();
    await router.navigate({ to: "/integration/endpoint", search: { endpointId: "source" } });
    fireEvent.click(await screen.findByRole("button", { name: "Close endpoint" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(router.state.location.search.endpointId).toBeUndefined();
    history.back();
    await screen.findByRole("heading", { name: "Router detail" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Back closes a detail opened from the Endpoint list", async () => {
    const { history } = await setup("/integration/endpoint");
    fireEvent.click(await screen.findByRole("button", { name: "Open endpoint" }));
    await screen.findByRole("dialog", { name: "source" });
    history.back();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("heading", { name: "Endpoints" })).toBeTruthy();
  });

  it("a directly opened detail closes in place without leaving the app", async () => {
    const { router, history } = await setup("/integration/endpoint?endpointId=source");
    fireEvent.click(await screen.findByRole("button", { name: "Close endpoint" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(router.state.location.pathname).toBe("/integration/endpoint");
    expect(history.length).toBe(1);
  });
});
