// @vitest-environment node
import { createCipheriv } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ControlPlaneService } from "./control-plane.js";
vi.mock("../db/read-budget.js", () => ({ boundedRead: (db: unknown, read: (tx: unknown) => unknown) => read(db) }));
const key = Buffer.alloc(32, 7);
const httpRequest = { method: "POST", target: "/evaluate", httpVersion: "1.1", headers: [["content-type", "application/json"]], bodyBase64: Buffer.from('{"private":"body"}').toString("base64"), redactedHeaders: [] };
function ciphertext() {
  const nonce = Buffer.alloc(12, 1);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from("tasklattice-runtime-log-v1"));
  const bytes = Buffer.concat([cipher.update(JSON.stringify({ contentBefore: [], contentAfter: [], httpRequest })), cipher.final()]);
  return ["tasklattice-runtime-log-v1", nonce.toString("base64"), cipher.getAuthTag().toString("base64"), bytes.toString("base64")].join(":");
}
function service() {
  const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: "event", metadata: { contentCiphertext: ciphertext(), httpRequest, trace: [] } }] }) }) }) };
  return Object.assign(Object.create(ControlPlaneService.prototype), { db, runtimeLogEncryptionKey: key }) as ControlPlaneService;
}
describe("HTTP request content permissions", () => {
  it("returns the decrypted HTTP envelope to an authorized admin detail read", async () => {
    const result = await service().getRuntimeEvent("event", true);
    expect(result.metadata.httpRequest).toEqual(httpRequest);
    expect(result.metadata).not.toHaveProperty("contentCiphertext");
  });
  it("excludes HTTP envelopes and encrypted content from non-admin detail reads", async () => {
    const result = await service().getRuntimeEvent("event", false);
    expect(result.metadata).toEqual({ trace: [] });
  });
});
