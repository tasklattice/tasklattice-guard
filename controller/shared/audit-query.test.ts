import { describe, expect, it } from "vitest";
import { auditLogSearch, auditQuerySchema } from "./audit-query.js";
describe("audit query", () => {
  it("restores valid URL values and defaults invalid fields independently", () => {
    expect(auditLogSearch({ q: " production ", actor: "invalid", window: "30d", page: "3", limit: "-1", before: "invalid" })).toMatchObject({ q: "production", actor: "all", window: "30d", page: 3, limit: 25, before: undefined });
  });
  it("rejects malformed API parameters instead of silently widening queries", () => {
    for (const input of [{ page: 0 }, { limit: 501 }, { actor: "person" }, { before: "not-a-date" }, { q: "x".repeat(301) }]) expect(auditQuerySchema.safeParse(input).success).toBe(false);
  });
});
