// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { Registry } from "prom-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import * as schema from "../db/schema.js";
import { ensureMockSsoUsers } from "../mock-sso.js";
import type { ControllerMetrics } from "../metrics.js";
import { AccessTokenService } from "../services/access-tokens.js";
import { ControlPlaneService } from "../services/control-plane.js";
import { TenantShareService } from "../services/tenant-shares.js";
import { createHttpApp } from "./app.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;

describe.skipIf(!url)("multi-tenant mock SSO HTTP flow in PostgreSQL", () => {
  const namespace = `guard_tenants_${randomUUID().replaceAll("-", "")}`;
  const demoEndpoint = (tenantId: string) => `mock-sso-endpoint-${tenantId}`;
  let admin: Pool;
  let pool: Pool;
  let app: ReturnType<typeof createHttpApp>;

  beforeAll(async () => {
    expect(["localhost", "127.0.0.1", "[::1]"]).toContain(new URL(url!).hostname);
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA "${namespace}"`);
    pool = new Pool({ connectionString: url, max: 5, options: `-c search_path=${namespace}` });
    const migration = (name: string) => readFileSync(new URL(`../db/migrations/${name}`, import.meta.url), "utf8");
    const journal = JSON.parse(migration("meta/_journal.json")) as { entries: Array<{ tag: string }> };
    for (const { tag } of journal.entries) {
      await pool.query(migration(`${tag}.sql`).replaceAll('"public".', `"${namespace}".`));
    }

    const db = drizzle(pool, { schema });
    const config = loadConfig({
      NODE_ENV: "test",
      CONTROLLER_DATABASE_URL: url!,
      CONTROLLER_HTTP_HOST: "127.0.0.1",
      CONTROLLER_PUBLIC_URL: "http://localhost:8080",
      CONTROLLER_MOCK_SSO_ENABLED: "true",
      CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
      CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
      CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"),
      BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
    });
    const auth = createAuth(config, db);
    await ensureMockSsoUsers({ auth, db, config });
    app = createHttpApp({
      config,
      auth,
      accessTokens: new AccessTokenService(db),
      tenantShares: new TenantShareService(db),
      service: new ControlPlaneService(db, config),
      runnerControl: { distributionStatus: async () => ({}) } as RunnerControlServer,
      metrics: { registry: new Registry() } as ControllerMetrics,
    });
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await admin?.end();
  });

  it("isolates tenant inventories, shares an endpoint read-only, then revokes access", async () => {
    async function signIn(identity: "tenantA" | "tenantB" | "tenantC") {
      const response = await app.request("/api/mock-sso/sign-in", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:8080" },
        body: JSON.stringify({ identity }),
      });
      expect(response.status).toBe(200);
      const cookie = response.headers.get("set-cookie")?.match(/tali-guard\.session_token=[^;]+/)?.[0];
      expect(cookie).toBeTruthy();
      return (path: string, init?: RequestInit) => app.request(path, {
        ...init,
        headers: { cookie: cookie!, ...init?.headers },
      });
    }

    const tenantA = await signIn("tenantA");
    const tenantB = await signIn("tenantB");
    const tenantC = await signIn("tenantC");
    for (const [identity, request] of [["tenantA", tenantA], ["tenantB", tenantB], ["tenantC", tenantC]] as const) {
      const session = await request("/api/v1/account/identity");
      expect(session.status).toBe(200);
      expect(await session.json()).toMatchObject({ tenantId: identity, role: "user", authentication: "session" });
      const endpoints = await request("/api/v1/endpoints?tenantId=tenantC", { headers: { "x-tenant-id": "tenantC", "x-role": "admin" } });
      expect(endpoints.status).toBe(200);
      expect((await endpoints.json()).items.map((item: { id: string }) => item.id)).toEqual([demoEndpoint(identity)]);
      const shareable = await request("/api/v1/account/shareable-resources");
      expect(shareable.status).toBe(200);
      expect((await shareable.json()).items.filter((item: { resourceType: string }) => item.resourceType === "endpoint"))
        .toMatchObject([{ resourceType: "endpoint", resourceId: demoEndpoint(identity) }]);
    }

    const issuedToken = await tenantB("/api/v1/account/access-tokens", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:8080" },
      body: JSON.stringify({ name: "Tenant B inventory", expiresInDays: 7, permissions: { endpoints: "read" } }),
    });
    expect(issuedToken.status).toBe(201);
    const { secret } = await issuedToken.json() as { secret: string };
    const patHeaders = { authorization: `Bearer ${secret}`, "x-tenant-id": "tenantC", "x-role": "admin" };
    expect(await (await app.request("/api/v1/account/identity", { headers: patHeaders })).json())
      .toMatchObject({ tenantId: "tenantB", role: "user", authentication: "access_token" });
    expect((await (await app.request("/api/v1/endpoints", { headers: patHeaders })).json()).items.map((item: { id: string }) => item.id))
      .toEqual([demoEndpoint("tenantB")]);
    expect((await app.request("/api/v1/account/shares", { headers: patHeaders })).status).toBe(403);

    const share = await tenantA("/api/v1/account/shares", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:8080" },
      body: JSON.stringify({ resourceType: "endpoint", resourceId: demoEndpoint("tenantA"), recipientTenantId: "tenantB" }),
    });
    expect(share.status).toBe(201);
    const shareId = (await share.json()).share.id as string;
    expect((await (await tenantB("/api/v1/endpoints")).json()).items.map((item: { id: string }) => item.id).sort())
      .toEqual([demoEndpoint("tenantA"), demoEndpoint("tenantB")]);
    expect((await tenantB(`/api/v1/endpoints/${demoEndpoint("tenantA")}`)).status).toBe(200);
    expect((await tenantC(`/api/v1/endpoints/${demoEndpoint("tenantA")}`)).status).toBe(404);

    const edit = await tenantB(`/api/v1/endpoints/${demoEndpoint("tenantA")}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }),
    });
    expect(edit.status).toBe(404);
    const reShare = await tenantB("/api/v1/account/shares", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceType: "endpoint", resourceId: demoEndpoint("tenantA"), recipientTenantId: "tenantC" }),
    });
    expect(reShare.status).toBe(404);

    expect((await tenantA(`/api/v1/account/shares/${shareId}`, { method: "DELETE", headers: { origin: "http://localhost:8080" } })).status).toBe(204);
    expect((await tenantB(`/api/v1/endpoints/${demoEndpoint("tenantA")}`)).status).toBe(404);
    expect((await (await tenantB("/api/v1/endpoints")).json()).items.map((item: { id: string }) => item.id))
      .toEqual([demoEndpoint("tenantB")]);
    expect((await (await tenantA("/api/v1/account/shares")).json()).items).toEqual([]);
    const audit = await pool.query("SELECT kind, tenant_id FROM audit_event WHERE resource_id=$1 ORDER BY occurred_at", [demoEndpoint("tenantA")]);
    expect(audit.rows).toEqual([
      { kind: "resource.shared", tenant_id: "tenantA" },
      { kind: "resource.share_revoked", tenant_id: "tenantA" },
    ]);
  });
});
