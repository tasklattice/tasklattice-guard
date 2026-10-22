// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import * as schema from "../db/schema.js";
import {
  currentTenantId,
  resourceReadPredicate,
  resourceWritePredicate,
  runWithTenantContext,
  tenantOwnerForCreate,
} from "./tenant-context.js";

describe("request tenant context", () => {
  it("keeps concurrent request identities separate across awaits", async () => {
    const request = (tenantId: string) => runWithTenantContext({ tenantId }, async () => {
      await Promise.resolve();
      return [currentTenantId(), tenantOwnerForCreate()];
    });
    expect(await Promise.all([request("tenantB"), request("tenantC")])).toEqual([
      ["tenantB", "tenantB"],
      ["tenantC", "tenantC"],
    ]);
    expect(currentTenantId()).toBeNull();
    expect(tenantOwnerForCreate()).toBe("tenantA");
  });

  it("requires matching ownership or an owner-bound share in resource reads", async () => {
    const pool = new Pool({ connectionString: "postgres://unused:unused@localhost/unused" });
    try {
      const db = drizzle(pool, { schema });
      const read = runWithTenantContext({ tenantId: "tenantB" }, () => db.select()
        .from(schema.guardrails)
        .where(resourceReadPredicate("guardrail", schema.guardrails.id, schema.guardrails.tenantId))
        .toSQL());
      expect(read.sql).toContain('"guardrail"."tenant_id" =');
      expect(read.sql).toContain('from "resource_share"');
      expect(read.sql).toContain('"resource_share"."owner_tenant_id" = "guardrail"."tenant_id"');
      expect(read.params).toEqual(["tenantB", "guardrail", "tenantB"]);

      const write = runWithTenantContext({ tenantId: "tenantB" }, () => db.select()
        .from(schema.guardrails)
        .where(resourceWritePredicate(schema.guardrails.tenantId))
        .toSQL());
      expect(write.sql).not.toContain('"resource_share"');
      expect(write.params).toEqual(["tenantB"]);
    } finally {
      await pool.end();
    }
  });
});
