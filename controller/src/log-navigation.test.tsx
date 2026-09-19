import { createMemoryHistory, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import * as controllerApi from "@/lib/controller-api";
import { routeTree } from "./app-router";

vi.mock("@/routes/layout", () => ({ ControlPlaneLayout: () => <Outlet /> }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "admin" } }) }));
vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US", exists: () => false } }),
}));
const event = (id = "checkpoint-1"): controllerApi.RuntimeEvent => ({
  id, requestId: "request:1", guardrailId: "guardrail-1", guardrailVersion: "20260919-111605.962Z",
  occurredAt: "2026-09-19T12:00:00Z", runnerId: "runner", routerId: null, endpointId: null,
  direction: "incoming", decision: "block", durationMs: 42,
  metadata: { runtimeLogCaptured: true, protocol: "playground", trace: [{ id: "span", name: "Recorded span", kind: "rail", outcome: "block", durationMs: 42 }] },
});
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); });
async function setup(path = "/logs") {
  vi.spyOn(api, "getGuardrails").mockResolvedValue({ items: [], count: 0 });
  vi.spyOn(api, "getRouters").mockResolvedValue({ items: [], count: 0 });
  vi.spyOn(api, "getGuardrailLoggingSettings").mockResolvedValue({ level: "info" } as Awaited<ReturnType<typeof api.getGuardrailLoggingSettings>>);
  const list = vi.spyOn(controllerApi, "listRuntimeEvents").mockResolvedValue({ items: [event()], nextCursor: null });
  const detail = vi.spyOn(controllerApi, "getRuntimeEvent").mockImplementation(async id => event(id));
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({ routeTree, history });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  await router.load();
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return { router, history, list, detail };
}

describe("URL-driven log inspection", () => {
  it("opens a row in one click, updates the URL, and supports Back/Forward", async () => {
    const { router, history, detail } = await setup();
    fireEvent.click(await screen.findByRole("cell", { name: /playground.*request:1/ }));
    expect(await screen.findByRole("button", { name: "logs.inspectSpan" })).toBeTruthy();
    expect(router.state.location.search).toMatchObject({ requestId: "request:1", guardrailId: "guardrail-1", checkpointId: "checkpoint-1" });
    expect(detail).toHaveBeenCalledWith("checkpoint-1", expect.any(AbortSignal));
    history.back();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    history.forward();
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "logs.inspectSpan" })).toBeTruthy();
  });

  it("restores an exact checkpoint outside the list page and preserves tab/routing filters on close", async () => {
    const { router, detail, list, history } = await setup("/logs?tab=checkpoints&requestId=request%3A1&checkpointId=older-checkpoint&guardrailId=guardrail-1&routerId=router-1");
    expect(await screen.findByRole("button", { name: "logs.inspectSpan" })).toBeTruthy();
    expect(detail).toHaveBeenCalledWith("older-checkpoint", expect.any(AbortSignal));
    expect(list).toHaveBeenCalledWith(100, { requestId: "request:1", guardrailId: "guardrail-1" }, expect.any(AbortSignal));
    fireEvent.click(screen.getAllByRole("button", { name: "common.close" }).at(-1)!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(router.state.location.search).toMatchObject({ tab: "checkpoints", guardrailId: "guardrail-1", routerId: "router-1" });
    expect(router.state.location.search.requestId).toBeUndefined();
    expect(router.state.location.search.checkpointId).toBeUndefined();
    expect(history.length).toBe(1);
  });

  it("resolves a request-only link and writes the automatically selected checkpoint to its URL", async () => {
    const { router } = await setup("/logs?requestId=request%3A1&guardrailId=guardrail-1");
    await screen.findByRole("button", { name: "logs.inspectSpan" });
    await waitFor(() => expect(router.state.location.search.checkpointId).toBe("checkpoint-1"));
  });

  it("stores the selected Logs tab and opens the clicked checkpoint", async () => {
    const { router } = await setup();
    const checkpointTab = await screen.findByRole("tab", { name: "logs.checkpoints" });
    fireEvent.mouseDown(checkpointTab, { button: 0, ctrlKey: false });
    fireEvent.click(checkpointTab);
    fireEvent.click(await screen.findByRole("button", { name: "logs.inspectCheckpoint" }));
    await screen.findByRole("dialog");
    expect(router.state.location.search).toMatchObject({ tab: "checkpoints", checkpointId: "checkpoint-1" });
  });
});
