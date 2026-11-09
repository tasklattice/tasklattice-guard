import { createMemoryHistory, createRootRoute, createRoute, createRouter, Link, Outlet, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Button } from "./button";

afterEach(cleanup);

it("preserves route parameters, search and hash when clicking a button link", async () => {
  const root = createRootRoute({ component: Outlet });
  const home = createRoute({ getParentRoute: () => root, path: "/", component: () => <Button asChild><Link to="/records/$id" params={{ id: "event-1" }} search={{ requestId: "request:1" }} hash="trace">View log</Link></Button> });
  const record = createRoute({ getParentRoute: () => root, path: "/records/$id", validateSearch: (search: Record<string, unknown>) => ({ requestId: search.requestId as string | undefined }), component: () => <p>Record detail</p> });
  const router = createRouter({ routeTree: root.addChildren([home, record]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  render(<RouterProvider router={router} />);
  const link = await screen.findByRole("link", { name: "View log" });
  expect(link.getAttribute("href")).toBe("/records/event-1?requestId=request%3A1#trace");
  fireEvent.click(link);
  await waitFor(() => expect(router.state.location.pathname).toBe("/records/event-1"));
  expect(router.state.location.search).toEqual({ requestId: "request:1" });
  expect(router.state.location.hash).toBe("trace");
});

it("keeps the explicit href of a native anchor", () => {
  render(<Button asChild><a href="/download?id=event-1">Download</a></Button>);
  expect(screen.getByRole("link", { name: "Download" }).getAttribute("href")).toBe("/download?id=event-1");
});
