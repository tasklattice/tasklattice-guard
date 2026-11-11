import { afterEach, expect, it, vi } from "vitest";
import { getControllerSystemStatus } from "./controller-api";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("accepts a valid 503 snapshot as unavailable, not a transport failure", async () => {
  const snapshot = { status: "unavailable", reasons: ["no_connected_runners"], observedAt: new Date().toISOString() };
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(snapshot, { status: 503 })));
  expect(await getControllerSystemStatus()).toEqual(snapshot);
});

it.each([null, {}, { status: "healthy", reasons: [] },
  { status: "healthy", reasons: ["unknown_reason"], observedAt: new Date().toISOString() }])(
  "rejects incomplete status evidence %j", async snapshot => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(snapshot)));
    await expect(getControllerSystemStatus()).rejects.toThrow("unavailable or incomplete");
  });

it("rejects a proxy's HTML 503 instead of displaying a health verdict", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Service Unavailable</html>", { status: 503 })));
  await expect(getControllerSystemStatus()).rejects.toThrow();
});

it.each(["timeout", "caller"])("cancels a stalled status request on %s", async source => {
  const timeout = new AbortController(), caller = new AbortController();
  const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
  vi.stubGlobal("fetch", vi.fn((_path, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  })));
  const pending = getControllerSystemStatus(caller.signal);
  const assertion = expect(pending).rejects.toThrow("cancelled");
  (source === "timeout" ? timeout : caller).abort(new Error("cancelled"));
  await assertion;
  expect(timeoutSpy).toHaveBeenCalledWith(3_000);
});
