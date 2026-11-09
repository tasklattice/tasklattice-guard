// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pageUpdateBlocked, startPageUpdates, usePageUpdateBlocker } from "./page-updates";
import { EntitySheet } from "@/components/entity-sheet";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
  stop?.();
  cleanup();
  document.body.innerHTML = "";
  document.head.querySelector('meta[name="tali-ui-build"]')?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Open-page deployment updates", () => {
  it("reloads an already open page after a deployment, without user refresh", async () => {
    const fetchVersion = vi.fn().mockResolvedValue("old");
    const reload = vi.fn();
    stop = startPageUpdates({ buildId: "old", fetchVersion, reload });
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).not.toHaveBeenCalled();
    fetchVersion.mockResolvedValue("new");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(reload).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reload).toHaveBeenCalledOnce();
  });

  it.each(["focus", "online", "pageshow", "vite:preloadError"])("checks a changed build on %s", async name => {
    const fetchVersion = vi.fn().mockResolvedValue("old");
    const reload = vi.fn();
    stop = startPageUpdates({ buildId: "old", fetchVersion, reload });
    await vi.advanceTimersByTimeAsync(0);
    fetchVersion.mockResolvedValue("new");
    const event = new Event(name, { cancelable: true });
    window.dispatchEvent(event);
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(false);
  });

  it("waits for a background tab to become visible", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const fetchVersion = vi.fn().mockResolvedValue("new");
    const reload = vi.fn();
    stop = startPageUpdates({ buildId: "old", fetchVersion, reload });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchVersion).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("preserves editor contents and waits for pending mutations before reloading", async () => {
    const reload = vi.fn();
    let busy = true;
    function Editor({ dirty }: { dirty: boolean }) {
      usePageUpdateBlocker(dirty);
      return <textarea defaultValue="unsaved policy" />;
    }
    const editor = render(<Editor dirty />);
    stop = startPageUpdates({ buildId: "old", fetchVersion: async () => "new", reload, isBusy: () => busy });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(reload).not.toHaveBeenCalled();
    expect(document.querySelector("textarea")?.value).toBe("unsaved policy");
    editor.rerender(<Editor dirty={false} />);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reload).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("protects open editing sheets but allows a read-only testing report to update", () => {
    const props = { open: true, onOpenChange: vi.fn(), eyebrow: "Test", title: "Test", description: "Test", footer: null };
    const view = render(<EntitySheet {...props}>Editor</EntitySheet>);
    expect(pageUpdateBlocked()).toBe(true);
    view.rerender(<EntitySheet {...props} allowPageUpdates>Report</EntitySheet>);
    expect(pageUpdateBlocked()).toBe(false);
    view.rerender(<EntitySheet {...props} open={false}>Editor</EntitySheet>);
    expect(pageUpdateBlocked()).toBe(false);
  });

  it("does not refresh on offline, HTTP failures, SPA fallbacks or invalid manifests", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    const reload = vi.fn();
    stop = startPageUpdates({ buildId: "old", reload });
    await vi.advanceTimersByTimeAsync(0);
    for (const response of [
      new Response("unavailable", { status: 503 }),
      new Response("<html>old server</html>", { headers: { "content-type": "text/html" } }),
      Response.json({ buildId: "" }),
      new Response("{", { headers: { "content-type": "application/json" } }),
    ]) {
      fetchMock.mockResolvedValue(response);
      await vi.advanceTimersByTimeAsync(15_000);
    }
    expect(reload).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(Response.json({ buildId: "d9df1e3e-7be9-4044-a84a-cefa87243579" }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(reload).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenLastCalledWith("/ui-version.json", expect.objectContaining({ cache: "no-store" }));
  });

  it("bounds reloads across documents during a rolling upgrade", async () => {
    const reload = vi.fn();
    stop = startPageUpdates({ buildId: "old", fetchVersion: async () => "new", reload });
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).toHaveBeenCalledOnce();
    stop();
    stop = startPageUpdates({ buildId: "new", fetchVersion: async () => "old", reload });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(reload).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not apply a deferred update after the server becomes unavailable", async () => {
    const reload = vi.fn();
    const form = document.createElement("form");
    document.body.append(form);
    const fetchVersion = vi.fn().mockResolvedValue("new");
    stop = startPageUpdates({ buildId: "old", fetchVersion, reload });
    await vi.advanceTimersByTimeAsync(0);
    fetchVersion.mockRejectedValue(new Error("deploying"));
    await vi.advanceTimersByTimeAsync(15_000);
    form.remove();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reload).not.toHaveBeenCalled();
    fetchVersion.mockResolvedValue("new");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("ignores a stale in-flight response after cleanup and leaves development HMR alone", async () => {
    const reload = vi.fn();
    let finish!: (value: string) => void;
    stop = startPageUpdates({ buildId: "old", reload, fetchVersion: () => new Promise(resolve => { finish = resolve; }) });
    stop();
    finish("new");
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).not.toHaveBeenCalled();
    const fetchVersion = vi.fn();
    stop = startPageUpdates({ fetchVersion, reload });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchVersion).not.toHaveBeenCalled();
  });
});
