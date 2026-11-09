// @vitest-environment node
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth, createSsoHandler } from "./auth.js";
import { loadConfig } from "./config.js";
import * as schema from "./db/schema.js";
import { ProjectService } from "./services/projects.js";
import { AccessTokenService } from "./services/access-tokens.js";

const databaseUrl = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!databaseUrl)("OIDC authorization code flow and Relay project grants", () => {
  const namespace = `guard_oidc_${randomUUID().replaceAll("-", "")}`;
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let admin: Pool; let pool: Pool; let idp: Server; let issuer: string;
  let auth: ReturnType<typeof createAuth>; let handleSso: ReturnType<typeof createSsoHandler>;
  let projects: ProjectService; let tokens: AccessTokenService;
  let overrides: Record<string, unknown> = {};
  let invalidSignature = false;
  const codes = new Map<string, { nonce: string; challenge: string }>();
  const origin = "http://localhost:8080";
  const path = "/tali/d/dep1/p/project1/r/ROLE_PROJECT_ADMIN";
  const cookie = (response: Response) => response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  beforeAll(async () => {
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(new URL(databaseUrl!).hostname);
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${namespace}"`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${namespace}` });
    const read = (name: string) => readFileSync(new URL(`./db/migrations/${name}`, import.meta.url), "utf8");
    for (const { tag } of JSON.parse(read("meta/_journal.json")).entries) await pool.query(read(`${tag}.sql`).replaceAll('"public".', `"${namespace}".`));
    idp = createServer(async (req, res) => {
      const url = new URL(req.url!, issuer);
      res.setHeader("content-type", "application/json");
      if (url.pathname.endsWith("openid-configuration")) return void res.end(JSON.stringify({ issuer,
        authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
        id_token_signing_alg_values_supported: ["RS256"], response_types_supported: ["code"] }));
      if (url.pathname === "/jwks") return void res.end(JSON.stringify({ keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" }] }));
      if (url.pathname === "/authorize") {
        const code = randomUUID();
        codes.set(code, { nonce: url.searchParams.get("nonce")!, challenge: url.searchParams.get("code_challenge")! });
        const callback = new URL(url.searchParams.get("redirect_uri")!);
        callback.searchParams.set("code", code); callback.searchParams.set("state", url.searchParams.get("state")!);
        res.writeHead(302, { location: callback.toString() }); return void res.end();
      }
      if (url.pathname === "/token") {
        let body = ""; for await (const chunk of req) body += chunk;
        const form = new URLSearchParams(body); const code = form.get("code")!; const request = codes.get(code); codes.delete(code);
        if (!request || createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== request.challenge
          || form.get("client_secret") !== "fixture-client-secret") { res.statusCode = 400; return void res.end('{}'); }
        const now = Math.floor(Date.now() / 1000);
        const claims = { iss: issuer, aud: "guard-test", sub: "human-1", email: "alice@example.test", email_verified: true,
          name: "Alice", groups: [path], role: "admin", iat: now, exp: now + 300, nonce: request.nonce, ...overrides };
        const data = [ { alg: "RS256", kid: "test-key" }, claims ].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
        const signature = sign("RSA-SHA256", Buffer.from(data), keys.privateKey).toString("base64url");
        return void res.end(JSON.stringify({ access_token: "fixture-access-token", token_type: "Bearer", expires_in: 300,
          id_token: `${data}.${invalidSignature ? 'bad-signature' : signature}` }));
      }
      res.statusCode = 404; res.end('{}');
    });
    await new Promise<void>(resolve => idp.listen(0, "127.0.0.1", resolve));
    issuer = `http://127.0.0.1:${(idp.address() as {port:number}).port}`;
    const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: databaseUrl!, CONTROLLER_PUBLIC_URL: origin,
      CONTROLLER_RUNNER_TOKEN: "test-runner-token-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key.pem",
      BETTER_AUTH_SECRET: "test-auth-secret-at-least-32-characters", CONTROLLER_SSO_ENABLED: "true", CONTROLLER_SSO_ISSUER: issuer,
      CONTROLLER_SSO_CLIENT_ID: "guard-test", CONTROLLER_SSO_CLIENT_SECRET: "fixture-client-secret", CONTROLLER_SSO_ALLOWED_EMAIL_DOMAINS: "example.test" });
    const db = drizzle(pool, { schema }); auth = createAuth(config, db); handleSso = createSsoHandler(config, db);
    projects = new ProjectService(db, async () => {}); tokens = new AccessTokenService(db);
  });
  afterAll(async () => { await new Promise<void>(resolve => idp?.close(() => resolve())); await pool?.end(); await admin?.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await admin?.end(); });

  async function login() {
    const start = await handleSso(new Request(`${origin}/api/auth/sign-in/social`, { method: "POST",
      headers: { origin, "content-type": "application/json", "x-forwarded-for": `127.0.0.${Math.ceil(Math.random()*200)}` },
      body: JSON.stringify({ provider: "corporate-sso", callbackURL: "/dashboard", errorCallbackURL: "/dashboard?sso_error=1" }) }));
    expect(start.status, await start.clone().text()).toBe(200);
    const authorization = await fetch((await start.json()).url, { redirect: "manual" });
    const callback = await handleSso(new Request(authorization.headers.get("location")!, { headers: { cookie: cookie(start) } }));
    const result = await auth.api.getSession({ headers: new Headers({ cookie: cookie(callback) }) });
    return { callback, result };
  }
  it("signs in a real human, syncs projects from full paths, and freezes token project scope", async () => {
    const { callback, result } = await login();
    expect(callback.headers.get("location")).toBe("/dashboard");
    expect(result?.user).toMatchObject({ username: "alice", email: "alice@example.test", role: "user" });
    expect((await pool.query("SELECT id_token,access_token,refresh_token FROM auth_account")).rows)
      .toEqual([{ id_token: null, access_token: null, refresh_token: null }]);
    expect(result?.session.activeProjectId).toBeNull();
    const userId = result!.user.id;
    expect((new Date(result!.session.expiresAt).getTime() - Date.now()) / 1000).toBeLessThanOrEqual(3600);
    expect(await projects.accessStatus(userId, null)).toMatchObject({state: "project_missing", missingProjects: [{projectId: "project1", departmentId: "dep1"}]});
    expect((await pool.query('SELECT id FROM project')).rows).toEqual([]);
    await projects.create(userId, {name: "project1", externalDepartmentId: "dep1"});
    expect(await projects.refreshAccess(userId, result!.session.id)).toMatchObject({state: "runner_uninitialized", projectId: "project1"});
    await pool.query("INSERT INTO runner_pool (id,name,runtime_url) VALUES ('default','Default','http://runner.invalid')");
    expect(await projects.accessStatus(userId, "project1")).toMatchObject({state: "ready"});
    expect((await projects.list({q:"",limit:25},userId)).items).toMatchObject([{id:"project1"}]);
    expect(await projects.membership(userId,"project1")).toMatchObject({access:"write",roles:["ROLE_PROJECT_ADMIN"]});
    const issued = await tokens.create(userId, { name: "Test", expiresInDays: 7, permissions: { endpoints: "read" } }, "project1");
    overrides = { groups: ["/tali/d/dep1/p/project2/r/ROLE_AUDITOR"] };
    await projects.create(userId, {name: "project2", externalDepartmentId: "dep1"});
    const next = await login(); expect(next.result?.user.id).toBe(userId);
    expect(next.result?.session.activeProjectId).toBe("project2");
    expect(await tokens.authenticate(issued.secret)).toBeNull();
    expect((await projects.list({q:"",limit:25},userId)).items).toMatchObject([{id:"project2"}]);
    expect(await projects.membership(userId,"project2")).toMatchObject({access:"read"});
    await expect(tokens.create(userId, { name: "Escalate", expiresInDays: 7, permissions: { endpoints: "write" } }, "project2")).rejects.toMatchObject({ code: "project_read_only" });
    overrides = { groups: [] }; const noGrants = await login();
    expect(noGrants.result?.session.activeProjectId).toBeNull(); expect((await projects.list({q:"",limit:25},userId)).items).toEqual([]);
  });
  it.each([
    { nonce: "wrong" }, { aud: "another-client" }, { iss: "https://wrong.example" }, { exp: 1 }, { email_verified: false },
    { email: "alice@outside.test" }, { groups: { role: "admin" } },
  ])("rejects invalid identity claims without creating a session: %j", async claims => {
    overrides = claims;
    expect((await login()).result).toBeNull();
  });
  it("rejects an invalid signature", async () => { overrides = {}; invalidSignature = true; expect((await login()).result).toBeNull(); invalidSignature = false; });
  it("does not merge a different subject by matching email", async () => { overrides = { sub: "different-human" }; expect((await login()).result).toBeNull(); });
  it("grants and revokes platform authority only from the exact platform path", async () => {
    overrides = { groups: ["/tali/r/ROLE_PLATFORM_ADMIN"] };
    const administrator = await login();
    expect(administrator.result?.user.role).toBe("admin");
    const userId = administrator.result!.user.id;
    const beforeRefresh = (await pool.query('SELECT role,sso_verified_at FROM auth_user WHERE id=$1', [userId])).rows[0];
    await projects.refreshAccess(userId, administrator.result!.session.id);
    expect((await pool.query('SELECT role,sso_verified_at FROM auth_user WHERE id=$1', [userId])).rows[0]).toEqual(beforeRefresh);
    await expect(auth.api.setRole({ headers: new Headers({cookie: cookie(administrator.callback)}),
      body: {userId: administrator.result!.user.id, role: "user"} })).rejects.toMatchObject({status:"FORBIDDEN",body:{message:"Manage SSO roles through Keycloak group paths."}});
    overrides = { groups: ["/tali/d/dep1/r/ROLE_DEPARTMENT_ADMIN", "/tali/r/ROLE_PLATFORM_ADMIN/child"] };
    expect((await login()).result?.user.role).toBe("user");
  });
  it("requires a new login before refreshing expired SSO grants", async () => {
    overrides = { groups: [path] };
    const { result } = await login();
    await pool.query("UPDATE auth_user SET sso_verified_at=now()-interval '2 hours' WHERE id=$1", [result!.user.id]);
    await expect(projects.refreshAccess(result!.user.id, result!.session.id))
      .rejects.toMatchObject({ code: "reauthentication_required" });
  });
});
