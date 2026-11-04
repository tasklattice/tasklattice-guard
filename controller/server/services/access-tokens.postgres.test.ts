import { seedTestProjects } from "../db/postgres-test-database.js";
// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema.js";
import type { ControllerDatabase } from "../db/client.js";
import { AccessTokenService } from "./access-tokens.js";
const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Personal access tokens in PostgreSQL", () => {
  const namespace = `guard_tokens_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool; let pool: Pool; let service: AccessTokenService;
  beforeAll(async () => {
    expect(["localhost", "127.0.0.1", "[::1]"]).toContain(new URL(url!).hostname);
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA "${namespace}"`);
    pool = new Pool({ connectionString: url, max: 5, options: `-c search_path=${namespace}` });
    const read = (name: string) => readFileSync(new URL(`../db/migrations/${name}`, import.meta.url), "utf8");
    const journal = JSON.parse(read("meta/_journal.json"));
    for (const { tag } of journal.entries) await pool.query(read(`${tag}.sql`).replaceAll('"public".', `"${namespace}".`));
    await seedTestProjects(pool);
    service = new AccessTokenService(drizzle(pool, { schema }));
  });
  afterAll(async () => { await pool?.end(); await admin?.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await admin?.end(); });
  beforeEach(async () => {
    await pool.query("TRUNCATE auth_user CASCADE");
    await pool.query("INSERT INTO auth_user(id,name,email,role) VALUES ('owner','Owner','owner@test.local','admin'),('other','Other','other@test.local','user')");
    await pool.query("INSERT INTO project_member(project_id,user_id) VALUES ('projectA','other')");
  });
  const input = { name: "CI", expiresInDays: 30, permissions: { models: "write", runners: "read" } };
  it("issues unique 256-bit secrets, stores only a hash and returns safe metadata", async () => {
    const first = await service.create("owner", input); const second = await service.create("owner", input);
    expect(first.secret).toMatch(/^tlg_pat_[A-Za-z0-9_-]{43}$/); expect(second.secret).not.toBe(first.secret);
    const stored = (await pool.query("SELECT * FROM personal_access_token WHERE id=$1", [first.token.id])).rows[0];
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(stored)).not.toContain(first.secret);
    expect(Date.parse(first.token.expiresAt) - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect(JSON.stringify(await service.list("owner"))).not.toContain("tokenHash");
    expect(JSON.stringify(await service.list("owner"))).not.toContain(first.secret);
    expect(await service.list("other")).toEqual([]);
    expect(JSON.stringify((await pool.query("SELECT * FROM audit_event")).rows)).not.toContain(first.secret);
    expect(await service.authenticate(first.secret)).toMatchObject({ id: "owner", role: "admin", projectId: null, tokenId: first.token.id, permissions: input.permissions });
    expect((await service.list("owner")).find(t => t.id === first.token.id)?.lastUsedAt).not.toBeNull();
  });
  it("rejects tampered, expired and revoked tokens immediately, with owner-only idempotent revocation", async () => {
    const issued = await service.create("owner", input);
    expect(await service.authenticate(`${issued.secret.slice(0,-1)}!`)).toBeNull();
    await expect(service.revoke("other", issued.token.id)).rejects.toMatchObject({ status: 404 });
    await service.revoke("owner", issued.token.id); await service.revoke("owner", issued.token.id);
    expect(await service.authenticate(issued.secret)).toBeNull();
    const fresh = await service.create("owner", input);
    await pool.query("UPDATE personal_access_token SET expires_at=now()-interval '1 second' WHERE id=$1", [fresh.token.id]);
    expect(await service.authenticate(fresh.secret)).toBeNull();
    expect((await pool.query("SELECT * FROM audit_event WHERE kind='access_token.revoked'")).rowCount).toBe(1);
  });
  it("reads current owner status and role on every authentication", async () => {
    const issued = await service.create("owner", input);
    await pool.query("UPDATE auth_user SET role='user' WHERE id='owner'");
    expect(await service.authenticate(issued.secret)).toBeNull();
    await pool.query("UPDATE auth_user SET banned=true WHERE id='owner'");
    expect(await service.authenticate(issued.secret)).toBeNull();
    await expect(service.create("owner", input)).rejects.toMatchObject({ status: 403 });
    await pool.query("DELETE FROM audit_event");
    await pool.query("DELETE FROM auth_user WHERE id='owner'");
    expect(await service.authenticate(issued.secret)).toBeNull();
    expect(await service.list("owner")).toEqual([]);
  });
  it.each([
    ["role demotion", "UPDATE auth_user SET role='user' WHERE id='owner'"],
    ["account ban", "UPDATE auth_user SET banned=true WHERE id='owner'"],
    ["token expiry", "UPDATE personal_access_token SET expires_at=clock_timestamp()+interval '100 milliseconds' WHERE user_id='owner'; SELECT pg_sleep(0.2)"],
  ])("rejects a token when %s occurs between lookup and touch", async (_change, changeOwner) => {
    const issued = await service.create("owner", input);
    const db = drizzle(pool, { schema });
    // Perform the real lookup, mutate the owner on another query, then allow
    // authenticate() to run its real conditional UPDATE. This deterministically
    // exercises the window between the two database statements.
    const racingDb = {
      select: (...args: Parameters<typeof db.select>) => {
        const selected = db.select(...args);
        return { from: (table: typeof schema.personalAccessTokens) => {
          const from = selected.from(table);
          return { innerJoin: (joined: typeof schema.user, condition: Parameters<typeof from.innerJoin>[1]) => {
            const joinedQuery = from.innerJoin(joined, condition);
            return { where: async (condition: Parameters<typeof joinedQuery.where>[0]) => {
              const rows = await joinedQuery.where(condition);
              await pool.query(changeOwner);
              return rows;
            } };
          } };
        } };
      },
      update: db.update.bind(db),
    } as unknown as ControllerDatabase;
    expect(await new AccessTokenService(racingDb).authenticate(issued.secret)).toBeNull();
    expect((await pool.query("SELECT last_used_at FROM personal_access_token WHERE id=$1", [issued.token.id])).rows[0].last_used_at).toBeNull();
  }, 30000);
  it("fails closed when the persisted owner has an unsupported role", async () => {
    const issued = await service.create("owner", input);
    await pool.query("UPDATE auth_user SET role='viewer' WHERE id='owner'");
    expect(await service.authenticate(issued.secret)).toBeNull();
    await expect(service.create("owner", input)).rejects.toMatchObject({ status: 403 });
  });
  it("revokes project tokens when membership is removed", async () => {
    const issued = await service.create("other", { ...input, permissions: {routers: "read"} }, "projectA");
    await pool.query("DELETE FROM project_member WHERE user_id='other'");
    expect(await service.authenticate(issued.secret)).toBeNull();
    await expect(service.create("other", input)).rejects.toMatchObject({code: "project_required"});
  });
  it("allows user workflow grants and rejects platform grants", async () => {
    const workflowInput = { ...input, permissions: { guardrails: "write", routers: "read" } };
    expect((await service.create("other", workflowInput, "projectA")).token.permissions).toEqual(workflowInput.permissions);
    await expect(service.create("other", { ...input, permissions: { settings: "read" } }, "projectA")).rejects.toMatchObject({ status: 403 });
    const issued = await service.create("other", { ...input, permissions: { routers: "read" } }, "projectA");
    expect(await service.authenticate(issued.secret)).toMatchObject({ id: "other", role: "user", permissions: { routers: "read" } });
  });
  it.each([{ permissions: {} }, { permissions: { users: "write" } }, { permissions: { audit: "write" } }, { expiresInDays: 0 }, { name: " " }, { userId: "other" }])("rejects invalid issuance input %j", async change => {
    await expect(service.create("owner", { ...input, ...change })).rejects.toThrow();
    expect(await service.list("owner")).toEqual([]);
  });
});
