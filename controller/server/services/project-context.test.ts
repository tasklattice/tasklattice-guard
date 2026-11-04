// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import * as schema from "../db/schema.js";
import {
  currentProjectId,
  currentAuthorityScope,
  runWithUserContext,
  resourceReadPredicate,
  resourceWritePredicate,
  runWithProjectContext,
  projectOwnerForCreate,
} from "./project-context.js";

describe("request project context", () => {
  it("keeps concurrent request identities separate across awaits", async () => {
    const request = (projectId: string) => runWithProjectContext({ projectId }, async () => {
      await Promise.resolve();
      return [currentProjectId(), projectOwnerForCreate()];
    });
    expect(await Promise.all([request("projectB"), request("projectC")])).toEqual([
      ["projectB", "projectB"],
      ["projectC", "projectC"],
    ]);
    expect(currentProjectId()).toBeNull();
    expect(() => projectOwnerForCreate()).toThrow("project");
  });

  it("keeps User recovery authority separate from Platform and Project resources", () => {
    runWithUserContext("new-human", "user", () => {
      expect(currentAuthorityScope()).toBe("user");
      expect(() => currentProjectId()).toThrow("Project authority");
      expect(() => projectOwnerForCreate()).toThrow("Project authority");
    });
    runWithProjectContext({ role: "admin", projectId: null }, () => expect(currentAuthorityScope()).toBe("platform"));
    runWithProjectContext({ role: "user", projectId: "explicit-project" }, () => expect(currentAuthorityScope()).toBe("project"));
  });

  it("requires matching ownership or an owner-bound share in resource reads", async () => {
    const pool = new Pool({ connectionString: "postgres://unused:unused@localhost/unused" });
    try {
      const db = drizzle(pool, { schema });
      const read = runWithProjectContext({ projectId: "projectB" }, () => db.select()
        .from(schema.guardrails)
        .where(resourceReadPredicate("guardrail", schema.guardrails.id, schema.guardrails.projectId))
        .toSQL());
      expect(read.sql).toContain('"guardrail"."project_id" =');
      expect(read.sql).toContain('from "resource_share"');
      expect(read.sql).toContain('"resource_share"."owner_project_id" = "guardrail"."project_id"');
      expect(read.params).toEqual(["projectB", "guardrail", "projectB"]);

      const write = runWithProjectContext({ projectId: "projectB" }, () => db.select()
        .from(schema.guardrails)
        .where(resourceWritePredicate(schema.guardrails.projectId))
        .toSQL());
      expect(write.sql).not.toContain('"resource_share"');
      expect(write.params).toEqual(["projectB"]);
    } finally {
      await pool.end();
    }
  });
});
