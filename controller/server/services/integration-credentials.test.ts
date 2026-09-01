import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  activeIntegrationCredentials,
  appendIntegrationCredential,
  issueIntegrationCredential,
  publicIntegrationCredentials,
  revokeIntegrationCredential,
} from "./integration-credentials.js";

const createdAt = new Date("2026-08-20T01:02:03.000Z");

describe("Integration credential verification", () => {
  it("issues a one-time value while keeping digests out of the public credential", () => {
    const issued = issueIntegrationCredential(createdAt);

    expect(issued.value).toMatch(/^tg_/);
    expect(issued.stored.sha256).toBe(createHash("sha256").update(issued.value).digest("hex"));
    expect(issued.publicCredential).toEqual({
      id: issued.stored.id,
      keyHint: issued.stored.keyHint,
      createdAt: createdAt.toISOString(),
    });
    expect(JSON.stringify(issued.publicCredential)).not.toContain(issued.stored.sha256);
  });

  it("projects active credentials without exposing their digests", () => {
    const firstDigest = "a".repeat(64);
    const secondDigest = "b".repeat(64);
    const verification = {
      credentials: [{
        id: "credential-1",
        sha256: firstDigest,
        keyHint: "tg_first…1234",
        createdAt: createdAt.toISOString(),
        revokedAt: null,
      }, {
        id: "credential-2",
        sha256: secondDigest,
        keyHint: "tg_next…abcd",
        createdAt: "2026-08-20T02:00:00.000Z",
        revokedAt: null,
      }],
    };

    expect(publicIntegrationCredentials(verification)).toEqual([
      { id: "credential-2", keyHint: "tg_next…abcd", createdAt: "2026-08-20T02:00:00.000Z" },
      { id: "credential-1", keyHint: "tg_first…1234", createdAt: createdAt.toISOString() },
    ]);
    expect(JSON.stringify(publicIntegrationCredentials(verification))).not.toContain(firstDigest);
    expect(JSON.stringify(publicIntegrationCredentials(verification))).not.toContain(secondDigest);
  });

  it("retains revoked records internally and excludes them from active credentials", () => {
    const issued = issueIntegrationCredential(createdAt);
    const verification = appendIntegrationCredential({}, issued.stored);
    const revoked = revokeIntegrationCredential(verification, issued.stored.id, new Date("2026-08-20T03:00:00.000Z"));

    expect(revoked).not.toBeNull();
    expect(activeIntegrationCredentials(revoked ?? {})).toEqual([]);
    expect(revoked).toMatchObject({
      credentials: [expect.objectContaining({ id: issued.stored.id, revokedAt: "2026-08-20T03:00:00.000Z" })],
    });
  });

  it("returns null when the requested credential does not exist", () => {
    expect(revokeIntegrationCredential({}, "missing", createdAt)).toBeNull();
  });
});
