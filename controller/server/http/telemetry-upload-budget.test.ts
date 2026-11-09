// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readBoundedTelemetryBody as read, TelemetryUploadAdmission } from "./telemetry-upload-budget.js";

const encode = (text: string) => new TextEncoder().encode(text);
function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    if (chunks.length) controller.enqueue(chunks.shift()!); else controller.close();
  }, cancel() { canceled = true; } });
  return { request: new Request("http://localhost/telemetry", { method: "POST", headers, body: stream, duplex: "half" } as RequestInit), canceled: () => canceled };
}

describe("authenticated telemetry upload resource budgets", () => {
  it("reserves capacity for another pool and releases permits idempotently", () => {
    const gate = new TelemetryUploadAdmission(4, 2), a = gate.acquire("a"), a2 = gate.acquire("a");
    expect(() => gate.acquire("a")).toThrow("Telemetry upload capacity");
    const b = gate.acquire("b"), c = gate.acquire("c");
    expect(() => gate.acquire("d")).toThrow("Telemetry upload capacity");
    a.release(); a.release();
    const d = gate.acquire("d");
    expect(() => gate.acquire("e")).toThrow();
    for (const permit of [a2, b, c, d]) permit.release();
    const permits = Array.from({ length: 4 }, (_, index) => gate.acquire(String(index)));
    permits.forEach(permit => permit.release());
  });
  it("preserves exact UTF-8 bytes across chunk boundaries for batch hashing", async () => {
    const text = '{"message":"é☃😀\\\"[]{}"}', bytes = encode(text);
    const { request } = streamed([...bytes].map(byte => Uint8Array.of(byte)));
    expect(await read(request, { maxBytes: bytes.length })).toBe(text);
  });
  it("counts actual bytes even with a false small Content-Length and cancels excess input", async () => {
    const upload = streamed([encode("1234"), encode("5678"), encode("ignored")], { "content-length": "1" });
    await expect(read(upload.request, { maxBytes: 7 })).rejects.toMatchObject({ status: 413 });
    expect(upload.canceled()).toBe(true);
  });
  it("rejects declared oversize without consuming the stream", async () => {
    const upload = streamed([], { "content-length": "100" });
    await expect(read(upload.request, { maxBytes: 99 })).rejects.toMatchObject({ status: 413 });
    expect(upload.canceled()).toBe(true);
  });
  it("does not interpret string punctuation/escaped quotes as JSON nesting", async () => {
    const body = JSON.stringify({ literal: '[{}]\\"\\\\' });
    expect(await read(new Request("http://localhost", { method: "POST", body }), { maxDepth: 1, maxStructuralTokens: 3 })).toBe(body);
  });
  it.each(["[[[0]]]", '[0,0,0,0,0,0]'])("bounds structures before JSON parsing: %s", async body => {
    await expect(read(new Request("http://localhost", { method: "POST", body }), { maxDepth: 2, maxStructuralTokens: 4 })).rejects.toMatchObject({ status: 413 });
  });
  it("rejects invalid UTF-8 rather than normalizing the signed upload", async () => {
    const { request } = streamed([Uint8Array.of(0xc0, 0xaf)]);
    await expect(read(request)).rejects.toMatchObject({ status: 400 });
  });
  it("handles many tiny chunks with the same fixed byte budget", async () => {
    const text = JSON.stringify({ text: "x".repeat(25_000) }), bytes = encode(text);
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset < bytes.length) controller.enqueue(bytes.subarray(offset, ++offset)); else controller.close();
    } });
    expect(await read(new Request("http://localhost", { method: "POST", body, duplex: "half" } as RequestInit),
      { maxBytes: bytes.length })).toBe(text);
  });
  it("cancels a stalled upload at its absolute read deadline", async () => {
    let canceled = false;
    const body = new ReadableStream({ cancel() { canceled = true; } });
    const request = new Request("http://localhost", { method: "POST", body, duplex: "half" } as RequestInit);
    await expect(read(request, { timeoutMs: 10 })).rejects.toMatchObject({ status: 408 });
    expect(canceled).toBe(true);
  });
  it.each([{ maxBytes: 0 }, { maxBytes: 8388609 }, { timeoutMs: NaN }, { maxDepth: 65 }])("rejects invalid server budgets %j", async limits => {
    await expect(read(new Request("http://localhost"), limits)).rejects.toThrow("Telemetry body budgets");
  });
});
