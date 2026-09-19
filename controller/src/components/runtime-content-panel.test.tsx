import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeContentPanel, LogBody } from "./runtime-content-panel";
import { RuntimeCheckpoint } from "./runtime-log-sheet";
import { formattedJsonTokens, httpRequestBytes } from "@/lib/http-log-content";
import * as downloads from "@/lib/http-log-content";
import { runtimeLogInteractions } from "@/lib/api";
import type { RuntimeHttpRequest } from "@/lib/api";
import type { RuntimeEvent } from "@/lib/controller-api";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { exists: () => false } }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const rawBody = '{"message":"你好","id":9007199254740993,"ok":true,"empty":{},"array":[1,null]}\n';
const request: RuntimeHttpRequest = {
  method: "POST", target: "/guardrails/evaluate?q=one%20two", httpVersion: "1.1",
  headers: [["content-type", "application/json"], ["x-tag", "one"], ["x-tag", "two"], ["authorization", "[REDACTED]"]],
  bodyBase64: Buffer.from(rawBody).toString("base64"), redactedHeaders: ["authorization"],
};
const props = { title: "Original request", description: "Description", blocks: null, available: true, downloadId: "event-1", collapsible: true };

describe("HTTP log body and download", () => {
  it("formats JSON and highlights tokens without rounding numbers or changing the downloaded request", async () => {
    const download = vi.spyOn(downloads, "downloadLogFile").mockImplementation(() => {});
    const { container } = render(<RuntimeContentPanel {...props} httpRequest={request} />);
    const toggle = screen.getByRole("button", { name: "Original request" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("code")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "logs.downloadHttpRequest" }));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const code = container.querySelector("code")!;
    expect(code.textContent).toContain('\n  "message": "你好",\n');
    expect(code.textContent).toContain('9007199254740993');
    expect(code.querySelector(".text-primary")?.textContent).toBe('"message"');
    expect(code.textContent).not.toContain("content-type");
    expect(code.textContent).not.toContain("POST");
    fireEvent.click(screen.getByRole("button", { name: "logs.downloadHttpRequest" }));
    await waitFor(() => expect(download).toHaveBeenCalledWith(expect.any(Uint8Array), "event-1.http", "application/octet-stream"));
    fireEvent.click(toggle);
    expect(container.querySelector("code")).toBeNull();
    const bytes = download.mock.calls[0]![0];
    expect(new TextDecoder().decode(bytes)).toBe('POST /guardrails/evaluate?q=one%20two HTTP/1.1\r\ncontent-type: application/json\r\nx-tag: one\r\nx-tag: two\r\nauthorization: [REDACTED]\r\n\r\n' + rawBody);
  });

  it("preserves non-text body and Latin-1 header bytes in downloads", () => {
    const bytes = httpRequestBytes({ ...request, headers: [["x-label", "café"]], bodyBase64: "AP+A" });
    expect(Array.from(bytes.slice(-3))).toEqual([0, 255, 128]);
    expect(bytes).toContain(233);
  });

  it("shows plain text and HTML as literal text, and validates all JSON forms", () => {
    const { container } = render(<LogBody body={'<script>alert("x")</script>'} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toBe('<script>alert("x")</script>');
    for (const value of ['null', 'false', '123', '"hello"', '[]', '{}', '{"escaped":"a\\nb\\\"c","exponent":1e+22}']) {
      const result = formattedJsonTokens(value)!.map(token => token.text).join("");
      expect(JSON.parse(result)).toEqual(JSON.parse(value));
    }
    expect(formattedJsonTokens('{"incomplete":')).toBeNull();
  });

  it("offers an honest body-only fallback for old records", async () => {
    const download = vi.spyOn(downloads, "downloadLogFile").mockImplementation(() => {});
    render(<RuntimeContentPanel {...props} blocks={[{ id: "b", text: "retained text", role: "user_input", source: "user_input", truncated: true }]} />);
    expect(screen.queryByRole("button", { name: "logs.downloadHttpRequest" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Original request" }));
    expect(screen.getByText("logs.legacyBodyOnly")).toBeTruthy();
    expect(screen.getByText("logs.truncated")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "logs.downloadBody" }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(new TextDecoder().decode(download.mock.calls[0]![0])).toBe("retained text");
  });

  it("maps encrypted-content detail and keeps HTTP bodies and download controls hidden from non-admins", () => {
    const event = { id: "event", requestId: "request", guardrailId: "guard", occurredAt: "2026-09-19", direction: "incoming", decision: "block", metadata: { runtimeLogCaptured: true, contentAvailable: true, httpRequest: request } } as unknown as RuntimeEvent;
    const entry = runtimeLogInteractions([event])[0]!.entries[0]!;
    expect(entry.http_request).toEqual(request);
    expect(entry.content_available).toBe(true);
    render(<RuntimeCheckpoint entry={entry} admin={false} />);
    expect(screen.queryByText(/你好/)).toBeNull();
    expect(screen.queryByRole("button", { name: /download/i })).toBeNull();
  });
});


describe("on-demand content", () => {
  it("fetches only on expand, deduplicates pending reads, reuses the loaded body and aborts on unmount", async () => {
    let resolve!: (value: { blocks: null; available: boolean; httpRequest: RuntimeHttpRequest }) => void;
    const load = vi.fn((_signal: AbortSignal) => new Promise<{ blocks: null; available: boolean; httpRequest: RuntimeHttpRequest }>(done => { resolve = done; }));
    const { container, unmount } = render(<RuntimeContentPanel {...props} loadContent={load} />);
    expect(load).not.toHaveBeenCalled();
    const toggle = screen.getByRole("button", { name: "Original request" });
    fireEvent.click(toggle);
    expect(screen.getByRole("status").textContent).toBe("logs.loadingContent");
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ blocks: null, available: true, httpRequest: request }));
    expect(container.querySelector("code")!.textContent).toContain('"message": "你好"');
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(load).toHaveBeenCalledTimes(1);
    unmount();
    const pendingLoad = vi.fn(() => new Promise<never>(() => {}));
    const pendingPanel = render(<RuntimeContentPanel {...props} loadContent={pendingLoad} />);
    fireEvent.click(screen.getByRole("button", { name: "Original request" }));
    const signal = (pendingLoad.mock.calls as unknown as [AbortSignal][])[0]![0];
    pendingPanel.unmount();
    expect(signal.aborted).toBe(true);
  });

  it("loads a collapsed download on demand, with a recoverable failure", async () => {
    const download = vi.spyOn(downloads, "downloadLogFile").mockImplementation(() => {});
    const load = vi.fn().mockRejectedValueOnce(new Error("Body read failed")).mockResolvedValue({ blocks: null, available: true, httpRequest: request });
    const { container } = render(<RuntimeContentPanel {...props} loadContent={load} />);
    fireEvent.click(screen.getByRole("button", { name: "logs.downloadContent" }));
    expect(await screen.findByText("Body read failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(load).toHaveBeenCalledTimes(2);
    expect(container.querySelector("code")).toBeNull();
    expect(screen.getByRole("button", { name: "Original request" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("bounds large previews and excessive JSON token/indentation work without truncating downloads", async () => {
    const raw = JSON.stringify({ text: "x".repeat(200_000) });
    const large = { ...request, bodyBase64: Buffer.from(raw).toString("base64") };
    const download = vi.spyOn(downloads, "downloadLogFile").mockImplementation(() => {});
    const { container } = render(<RuntimeContentPanel {...props} httpRequest={large} />);
    fireEvent.click(screen.getByRole("button", { name: "Original request" }));
    expect(container.querySelector("code")!.textContent!.length).toBeLessThanOrEqual(65536);
    expect(container.querySelectorAll("code span").length).toBe(0);
    expect(screen.getByText("logs.bodyPreviewLimited")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "logs.downloadHttpRequest" }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(new TextDecoder().decode(download.mock.calls[0]![0])).toContain(raw);
    expect(formattedJsonTokens("[".repeat(100) + "0" + "]".repeat(100))).toBeNull();
    expect(formattedJsonTokens(JSON.stringify(Array.from({ length: 5000 }, () => 0)))).toBeNull();
  });
});
