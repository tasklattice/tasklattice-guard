import { createMemoryHistory, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
async function setup(path = "/logs", items = [event()]) {
  vi.spyOn(api, "getGuardrails").mockResolvedValue({ items: [], count: 0 });
  vi.spyOn(api, "getRouters").mockResolvedValue({ items: [], count: 0 });
  vi.spyOn(api, "getGuardrailLoggingSettings").mockResolvedValue({ level: "info" } as Awaited<ReturnType<typeof api.getGuardrailLoggingSettings>>);
  const list = vi.spyOn(controllerApi, "listRuntimeEvents").mockResolvedValue({ items, nextCursor: null });
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
    expect(await screen.findByRole("button", { name: /logs.executionTrace/ })).toBeTruthy();
    expect(router.state.location.search).toMatchObject({ requestId: "request:1", guardrailId: "guardrail-1", checkpointId: "checkpoint-1" });
    expect(detail).toHaveBeenCalledWith("checkpoint-1", expect.any(AbortSignal));
    history.back();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    history.forward();
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(await screen.findByRole("button", { name: /logs.executionTrace/ })).toBeTruthy();
  });

  it("restores an exact checkpoint outside the list page and preserves routing filters on close", async () => {
    const { router, detail, list, history } = await setup("/logs?requestId=request%3A1&checkpointId=older-checkpoint&guardrailId=guardrail-1&routerId=router-1");
    expect(await screen.findByRole("button", { name: /logs.executionTrace/ })).toBeTruthy();
    expect(detail).toHaveBeenCalledWith("older-checkpoint", expect.any(AbortSignal));
    expect(list).toHaveBeenCalledWith(100, { requestId: "request:1", guardrailId: "guardrail-1" }, expect.any(AbortSignal));
    fireEvent.click(screen.getAllByRole("button", { name: "common.close" }).at(-1)!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(router.state.location.search).toMatchObject({ guardrailId: "guardrail-1", routerId: "router-1" });
    expect(router.state.location.search.requestId).toBeUndefined();
    expect(router.state.location.search.checkpointId).toBeUndefined();
    expect(history.length).toBe(1);
  });

  it("resolves a request-only link and writes the automatically selected checkpoint to its URL", async () => {
    const { router } = await setup("/logs?requestId=request%3A1&guardrailId=guardrail-1");
    await screen.findByRole("button", { name: /logs.executionTrace/ });
    await waitFor(() => expect(router.state.location.search.checkpointId).toBe("checkpoint-1"));
  });

  it("shows one runtime list without tabs and opens the clicked checkpoint", async () => {
    const { router, list } = await setup();
    fireEvent.click(await screen.findByRole("button", { name: "logs.inspectCheckpoint" }));
    await screen.findByRole("dialog");
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(router.state.location.search).toMatchObject({ checkpointId: "checkpoint-1" });
    expect(router.state.location.search).not.toHaveProperty("tab");
    const listFilters = list.mock.calls[0]?.[1];
    expect(listFilters).not.toHaveProperty("captured");
  });

  it.each(["allow", "block", "transform", "error"])("offers enforcement outcomes and Error, and sends %s to the server", async outcome => {
    const { list } = await setup();
    await screen.findByRole("table");
    expect(screen.getAllByRole("combobox")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "logs.windowFilter" })).toBeTruthy();
    fireEvent.click(screen.getByRole("combobox", { name: "logs.outcomeFilter" }));
    expect(screen.getAllByRole("option").map(option => option.textContent)).toEqual([
      "logs.allOutcomes", "logs.outcomes.allow", "logs.outcomes.block", "logs.outcomes.transform", "logs.executionErrorOutcome",
    ]);
    fireEvent.click(screen.getByRole("option", { name: outcome === "error" ? "logs.executionErrorOutcome" : `logs.outcomes.${outcome}` }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(100, expect.objectContaining({ outcome }), expect.any(AbortSignal)));
  });

  it("restores the Error filter and exact monitoring window from a link", async () => {
    const { list, router } = await setup("/logs?outcome=error&routerId=router-1&endpointId=endpoint-1&routerRevision=2&since=2026-09-19T00%3A00%3A00Z&until=2026-09-20T00%3A00%3A00Z", [
      { ...event(), metadata: { executionStatus: "error" } },
    ]);
    await screen.findByRole("table");
    expect(list).toHaveBeenCalledWith(100, expect.objectContaining({ outcome: "error", routerId: "router-1", endpointId: "endpoint-1", routerRevision: 2, since: "2026-09-19T00:00:00Z", until: "2026-09-20T00:00:00Z" }), expect.any(AbortSignal));
    expect(router.state.location.search.outcome).toBe("error");
    expect(screen.getByRole("button", { name: "logs.windowFilter" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "logs.windowFilter" }).textContent).toContain("09/19");
    expect(screen.getByText("logs.outcomes.block")).toBeTruthy();
  });

  it("keeps metadata-only and unassigned records in the same inspectable list", async () => {
    const metadataOnly = { ...event("metadata-only"), requestId: "unassigned-request", guardrailId: null, decision: "allow", metadata: { runtimeLogCaptured: false, protocol: "http" } };
    const { detail } = await setup("/logs", [event(), metadataOnly]);
    await screen.findByRole("cell", { name: /http.*unassigned-request/ });
    expect(screen.getAllByRole("row")).toHaveLength(3);
    detail.mockResolvedValue(metadataOnly);
    const row = screen.getByRole("cell", { name: /http.*unassigned-request/ });
    fireEvent.click(row);
    expect(await screen.findByRole("button", { name: /logs.executionTrace/ })).toBeTruthy();
    expect(detail).toHaveBeenCalledWith("metadata-only", expect.any(AbortSignal));
    expect(screen.queryByText("logs.recordUnavailable")).toBeNull();
  });

  it("keeps an exact event filter after closing detail, even outside the default time window", async () => {
    const { router, list, detail } = await setup("/logs?eventId=older-checkpoint&requestId=request%3A1&checkpointId=older-checkpoint&guardrailId=guardrail-1");
    const traceToggle = await screen.findByRole("button", { name: /logs.executionTrace/ });
    expect(traceToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "logs.inspectSpan" })).toBeNull();
    expect(detail).toHaveBeenCalledWith("older-checkpoint", expect.any(AbortSignal));
    // The only paginated query is for related checkpoints, never for the main list.
    expect(list.mock.calls.every(([, filters]) => filters?.requestId === "request:1" && !filters.since)).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "common.close" }).at(-1)!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(router.state.location.search.eventId).toBe("older-checkpoint");
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "logs.windowFilter" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "logs.clearEventFilter" }));
    await waitFor(() => expect(router.state.location.search.eventId).toBeUndefined());
    await waitFor(() => expect(list).toHaveBeenCalledWith(100, expect.objectContaining({ since: expect.any(String), guardrailId: "guardrail-1" }), expect.any(AbortSignal)));
  });

  it("shows a recoverable error for an unavailable exact event instead of displaying unrelated logs", async () => {
    const { router, detail, list } = await setup();
    await screen.findByRole("table");
    detail.mockRejectedValueOnce(new Error("Record not found"));
    list.mockClear();
    await router.navigate({ to: "/logs", search: { eventId: "missing-event" } });
    expect(await screen.findByText("Record not found")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(list).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    expect(await screen.findByRole("table")).toBeTruthy();
  });

  it("preserves each checkpoint's own version and protocol within one request", async () => {
    await setup("/logs", [
      { ...event("input"), guardrailVersion: "v1", metadata: { protocol: "litellm" } },
      { ...event("output"), guardrailVersion: "v2", direction: "outgoing", metadata: { protocol: "litellm-stream" } },
    ]);
    expect(await screen.findByRole("cell", { name: /guardrail-1\s*v1/ })).toBeTruthy();
    expect(screen.getByRole("cell", { name: /guardrail-1\s*v2/ })).toBeTruthy();
    expect(screen.getByRole("cell", { name: /litellm · request:1/ })).toBeTruthy();
    expect(screen.getByRole("cell", { name: /litellm-stream · request:1/ })).toBeTruthy();
  });
});

function openTimeRange() {
  if (!screen.queryByLabelText("logs.startDate")) fireEvent.click(screen.getByRole("button", { name: "logs.windowFilter" }));
}

function setTimeBound(field: "start" | "end", value: string) {
  openTimeRange();
  const [date, time] = value.split("T");
  fireEvent.change(screen.getByLabelText(`logs.${field}Date`), { target: { value: date } });
  fireEvent.change(screen.getByLabelText(`logs.${field}Time`), { target: { value: time } });
}

function timeBound(field: "start" | "end") {
  openTimeRange();
  const date = (screen.getByLabelText(`logs.${field}Date`) as HTMLInputElement).value;
  const time = (screen.getByLabelText(`logs.${field}Time`) as HTMLInputElement).value;
  return `${date}T${time}`;
}

describe("minute-precision log filtering", () => {
  it("stages edits, then sends UTC bounds including the whole end minute and keeps routing filters", async () => {
    const { list, router } = await setup("/logs?routerId=router-1&routeId=route-1&outcome=block");
    await screen.findByRole("table");
    list.mockClear();
    expect(screen.queryByLabelText("logs.startDate")).toBeNull();
    setTimeBound("start", "2026-09-19T14:02");
    setTimeBound("end", "2026-09-19T14:05");
    expect(list).not.toHaveBeenCalled();
    const since = new Date("2026-09-19T14:02:00").toISOString();
    const until = new Date("2026-09-19T14:05:59.999").toISOString();
    fireEvent.click(screen.getByRole("button", { name: "logs.applyTimeRange" }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(100, expect.objectContaining({ since, until, routerId: "router-1", routeId: "route-1", outcome: "block" }), expect.any(AbortSignal)));
    expect(router.state.location.search).toMatchObject({ since, until, routerId: "router-1", routeId: "route-1", outcome: "block" });
    expect(screen.getByRole("button", { name: "logs.windowFilter" }).textContent).toContain("09/19 14:02 – 14:05");
    expect(screen.queryByRole("dialog", { name: "logs.preciseTimeRange" })).toBeNull();
  });

  it("selects a calendar day without dismissing the editor or losing its minute value", async () => {
    const { list } = await setup("/logs?since=2026-09-19T06%3A02%3A00Z&until=2026-09-21T06%3A05%3A59.999Z");
    await screen.findByRole("table");
    list.mockClear();
    openTimeRange();
    const selectedStart = `2026-09-20T${timeBound("start").split("T")[1]}`;
    // jsdom does not load the SCSS positioning required by Carbon's calendar.
    screen.getByLabelText("logs.startDate").closest("form")!.style.position = "relative";
    fireEvent.focus(screen.getByLabelText("logs.startDate"));
    const calendar = document.querySelector<HTMLElement>(".flatpickr-calendar.open")!;
    const day = await within(calendar).findByRole("button", { name: "Sunday, September 20, 2026" });
    fireEvent.mouseDown(day);
    fireEvent.click(day);
    expect(screen.getByRole("dialog", { name: "logs.preciseTimeRange" })).toBeTruthy();
    expect(timeBound("start")).toBe(selectedStart);
    expect(list).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "logs.applyTimeRange" }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(100, expect.objectContaining({ since: new Date(selectedStart).toISOString() }), expect.any(AbortSignal)));
  });

  it.each(["cancel", "escape", "outside"])("discards unapplied edits when dismissed via %s", async method => {
    const { list } = await setup("/logs?since=2026-09-19T06%3A02%3A00Z&until=2026-09-19T06%3A05%3A59.999Z");
    await screen.findByRole("table");
    list.mockClear();
    const originalStart = timeBound("start");
    const originalLabel = screen.getByRole("button", { name: "logs.windowFilter" }).textContent;
    setTimeBound("start", "2026-09-20T14:02");
    if (method === "cancel") fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    else if (method === "escape") fireEvent.keyDown(screen.getByLabelText("logs.startTime"), { key: "Escape" });
    else fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "logs.preciseTimeRange" })).toBeNull();
    expect(screen.getByRole("button", { name: "logs.windowFilter" }).textContent).toBe(originalLabel);
    expect(timeBound("start")).toBe(originalStart);
    expect(list).not.toHaveBeenCalled();
  });

  it("accepts a single minute and disables invalid or incomplete intervals without querying", async () => {
    const { list } = await setup();
    await screen.findByRole("table");
    list.mockClear();
    setTimeBound("start", "2026-09-19T14:05");
    setTimeBound("end", "2026-09-19T14:02");
    expect(screen.getByRole("alert").textContent).toBe("logs.timeRangeReversed");
    expect(screen.getByRole("button", { name: "logs.applyTimeRange" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("logs.endTime"), { target: { value: "" } });
    expect(screen.getByRole("alert").textContent).toBe("logs.timeRangeRequired");
    expect(list).not.toHaveBeenCalled();
    setTimeBound("end", "2026-09-19T24:05");
    expect(screen.getByRole("alert").textContent).toBe("logs.timeRangeInvalid");
    expect(screen.getByRole("button", { name: "logs.applyTimeRange" }).hasAttribute("disabled")).toBe(true);
    setTimeBound("end", "2026-09-19T14:05");
    fireEvent.click(screen.getByRole("button", { name: "logs.applyTimeRange" }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(100, expect.objectContaining({ since: new Date("2026-09-19T14:05:00").toISOString(), until: new Date("2026-09-19T14:05:59.999").toISOString() }), expect.any(AbortSignal)));
  });

  it("fills a one-hour preset, clears fixed bounds, and restores them with Back", async () => {
    const { list, router, history } = await setup("/logs?since=2026-09-19T06%3A02%3A00Z&until=2026-09-19T06%3A05%3A59.999Z&routerId=router-1");
    await screen.findByRole("table");
    const originalStart = timeBound("start");
    const originalEnd = timeBound("end");
    const originalLabel = screen.getByRole("button", { name: "logs.windowFilter" }).textContent;
    openTimeRange();
    fireEvent.click(screen.getByRole("button", { name: "dashboard.windows.1h" }));
    await waitFor(() => expect(router.state.location.search.since).toBeUndefined());
    expect(router.state.location.search.until).toBeUndefined();
    expect(router.state.location.search.routerId).toBe("router-1");
    const start = new Date(timeBound("start"));
    const end = new Date(timeBound("end"));
    expect(end.getTime() - start.getTime()).toBe(3_600_000);
    expect(list.mock.calls.at(-1)?.[1]?.until).toBeUndefined();
    history.back();
    await waitFor(() => expect(timeBound("start")).toBe(originalStart));
    expect(timeBound("end")).toBe(originalEnd);
    expect(screen.getByRole("button", { name: "logs.windowFilter" }).textContent).toBe(originalLabel);
  });

  it("starts from the first page when a precise interval changes", async () => {
    const { list } = await setup();
    await screen.findByRole("table");
    list.mockResolvedValue({ items: [event()], nextCursor: "older" });
    fireEvent.click(screen.getByRole("combobox", { name: "logs.outcomeFilter" }));
    fireEvent.click(screen.getByRole("option", { name: "logs.outcomes.block" }));
    const next = screen.getByRole("button", { name: "eventPagination.next" });
    await waitFor(() => expect(next.hasAttribute("disabled")).toBe(false));
    fireEvent.click(next);
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(100, expect.objectContaining({ cursor: "older" }), expect.any(AbortSignal)));
    setTimeBound("start", "2026-09-19T14:02");
    setTimeBound("end", "2026-09-19T14:05");
    fireEvent.click(screen.getByRole("button", { name: "logs.applyTimeRange" }));
    await waitFor(() => expect(list.mock.calls.at(-1)?.[1]?.until).toBe(new Date("2026-09-19T14:05:59.999").toISOString()));
    expect(list.mock.calls.at(-1)?.[1]).not.toHaveProperty("cursor");
    expect(screen.getByRole("button", { name: "eventPagination.previous" }).hasAttribute("disabled")).toBe(true);
  });
});
