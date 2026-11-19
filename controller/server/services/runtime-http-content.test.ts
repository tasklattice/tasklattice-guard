// @vitest-environment node
import { createCipheriv } from "node:crypto";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneService } from "./control-plane.js";
vi.mock("../db/read-budget.js", () => ({ boundedRead: (db: unknown, read: (tx: unknown) => unknown) => read(db) }));
afterEach(() => vi.restoreAllMocks());
const key = Buffer.alloc(32, 7);
const httpRequest = { method: "POST", target: "/evaluate", httpVersion: "1.1", headers: [["content-type", "application/json"]], bodyBase64: Buffer.from('{"private":"body"}').toString("base64"), redactedHeaders: [] };
const modelExchanges = [{ modelCallId: "rpc", request: { bodyBase64: "cHJpdmF0ZQ==", headers: [["authorization", "[REDACTED]"]] }, response: { status: 429, headers: [["x-rate-limit", "0"]] } }];
function ciphertext() {
  const nonce = Buffer.alloc(12, 1);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from("tasklattice-runtime-log-v1"));
  const bytes = Buffer.concat([cipher.update(JSON.stringify({ contentBefore: [], contentAfter: [], httpRequest, modelExchanges })), cipher.final()]);
  return ["tasklattice-runtime-log-v1", nonce.toString("base64"), cipher.getAuthTag().toString("base64"), bytes.toString("base64")].join(":");
}
function service(occurredAt = new Date()) {
  const select = vi.fn((_columns: { metadata: SQL }) => ({ from: () => ({ where: () => ({ limit: async () => [{
    id: "event", occurredAt, metadata: { contentCiphertext: ciphertext(), httpRequest, modelExchanges, trace: [] },
  }] }) }) }));
  const controlPlane = Object.assign(Object.create(ControlPlaneService.prototype), { db: { select }, runtimeLogEncryptionKey: key }) as ControlPlaneService;
  return { controlPlane, select };
}
describe("HTTP request content permissions", () => {
  it("returns the decrypted HTTP envelope to an authorized admin detail read", async () => {
    const result = await service().controlPlane.getRuntimeEvent("event", true);
    expect(result.metadata.httpRequest).toEqual(httpRequest);
    expect(result.metadata.modelExchanges).toEqual(modelExchanges);
    expect(result.metadata).not.toHaveProperty("contentCiphertext");
  });
  it("excludes HTTP envelopes and encrypted content from non-admin detail reads", async () => {
    const result = await service().controlPlane.getRuntimeEvent("event", false);
    expect(result.metadata).toEqual({ trace: [] });
  });

  it.each([false, true])("expires bodies and preserves trace at 30 days with includeContent=%s", async includeContent => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-18T12:00:00Z"));
    const { controlPlane, select } = service(new Date("2026-10-19T12:00:00Z"));

    const result = await controlPlane.getRuntimeEvent("event", includeContent);
    expect(result.metadata).toEqual({ trace: [], contentAvailable: false });

    const query = new PgDialect().sqlToQuery(select.mock.calls[0]![0].metadata);
    expect(query.sql).toContain('"runtime_event"."occurred_at" >');
    expect(query.sql).toContain('::text[]');
    expect(query.params).toContain("2026-10-19T12:00:00.000Z");
    expect(query.params).toContainEqual(["contentCiphertext", "contentBefore", "contentAfter", "httpRequest", "modelExchanges"]);
    if (includeContent) expect(query.sql).toMatch(/^case when .* else .* end$/s);
  });
});
