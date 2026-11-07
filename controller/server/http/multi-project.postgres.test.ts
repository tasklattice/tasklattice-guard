import { seedTestProjects } from "../db/postgres-test-database.js";
import { seedProfiles } from "../db/seed-profiles.js";
// @vitest-environment node
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { Registry } from "prom-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAuth } from "../auth.js";
import { loadConfig } from "../config.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import * as schema from "../db/schema.js";
import type { ControllerMetrics } from "../metrics.js";
import { ProjectService } from "../services/projects.js";
import { AccessTokenService } from "../services/access-tokens.js";
import { ControlPlaneService } from "../services/control-plane.js";
import { emptyPolicyDefinition } from "../../shared/policy-definition.js";
import { createHttpApp } from "./app.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;

describe.skipIf(!url)("multi-project password authentication and sharing in PostgreSQL", () => {
  const namespace = `guard_projects_${randomUUID().replaceAll("-", "")}`;
  const signingKey = `/tmp/${namespace}.pem`;
  const fixtureEndpoint = (projectId: string) => `fixture-endpoint-${projectId}`;
  let admin: Pool;
  let pool: Pool;
  let app: ReturnType<typeof createHttpApp>;
  let auth: ReturnType<typeof createAuth>;

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
    await seedTestProjects(pool);
    // Match a bootstrapped deployment: migrations seed the reviewed Profiles,
    // and Default provisioning resolves its pinned Profile from those rows.
    await seedProfiles(drizzle(pool, { schema }));
    writeFileSync(signingKey, generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    // Match a bootstrapped deployment: Endpoint responses resolve a project's
    // Runner group against its registered pool before returning distribution.
    await pool.query("INSERT INTO runner_pool (id, name) VALUES ('default', 'Default')");

    const db = drizzle(pool, { schema });
    const config = loadConfig({
      NODE_ENV: "test",
      CONTROLLER_DATABASE_URL: url!,
      CONTROLLER_HTTP_HOST: "127.0.0.1",
      CONTROLLER_PUBLIC_URL: "http://localhost:8080",
      CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
      CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: signingKey,
      CONTROLLER_POLICY_CATALOG_DIR: resolve("../runner/toolkit/policy_library/assets"),
      BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
    });
    auth = createAuth(config, db);
    for (const projectId of ["projectA", "projectB", "projectC"]) {
      const username = `fixture-${projectId.toLowerCase()}`;
      const created = await auth.api.createUser({ body: {
        email: `${username}@test.example`, password: "test-password-only", name: projectId,
        role: "user", data: { username },
      } });
      await db.delete(schema.projectMembers).where(eq(schema.projectMembers.userId, created.user.id));
      await db.insert(schema.projectMembers).values({projectId: projectId, userId: created.user.id});
      await db.insert(schema.endpoints).values({
        id: fixtureEndpoint(projectId), projectId, name: `${projectId} test endpoint`,
        adapter: "litellm-generic-guardrail", status: "disabled", verification: {},
      });
    }
    const service = new ControlPlaneService(db, config);
    await service.initialize();
    app = createHttpApp({
      config,
      auth,
      accessTokens: new AccessTokenService(db),
      projects: new ProjectService(db, (tx, id) => service.initializeProject(tx, id), config.runtimeServiceUrl),
      service,
      runnerControl: { distributionStatus: async () => ({}) } as RunnerControlServer,
      metrics: { registry: new Registry() } as ControllerMetrics,
    });
  });

  afterAll(async () => {
    rmSync(signingKey, { force: true });
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await admin?.end();
  });

  it("exposes identity sources and multi-project memberships only to platform browser sessions", async () => {
    const created = await auth.api.createUser({ body: { email: "directory-admin@test.example", password: "test-password-only", name: "Directory admin", role: "admin", data: {username: "directory-admin"} } });
    const local = (await pool.query("SELECT id FROM auth_user WHERE username='fixture-projecta'")).rows[0].id;
    const sso = await auth.api.createUser({ body: { email: "directory-sso@test.example", password: "test-password-only", data: {username: "directory-sso"}, name: "Directory SSO", role: "user" } });
    await pool.query("INSERT INTO auth_account (id,user_id,account_id,provider_id,issuer,created_at,updated_at) VALUES ($1,$2,$2,'corporate-sso','https://identity.test',now(),now())", [randomUUID(),sso.user.id]);
    await pool.query("INSERT INTO project_member (project_id,user_id,source) VALUES ('projectA',$1,'sso'),('projectB',$1,'sso')", [sso.user.id]);
    const login = await app.request("/api/auth/sign-in/username", {method:"POST",headers:{"content-type":"application/json",origin:"http://localhost:8080"},body:JSON.stringify({username:"directory-admin",password:"test-password-only"})});
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.match(/tali-guard\.session_token=[^;]+/)![0];
    const response = await app.request("/api/v1/users", {headers:{cookie}});
    expect(response.status).toBe(200);
    const {items} = await response.json();
    expect(items).toContainEqual(expect.objectContaining({id:created.user.id,source:"local",projectCount:0}));
    expect(items).toContainEqual(expect.objectContaining({id:local,source:"local",projectCount:1}));
    expect(items).toContainEqual(expect.objectContaining({id:sso.user.id,source:"sso",projectCount:2}));
    expect(items.every((item:unknown)=>!Object.hasOwn(item as object,"projects"))).toBe(true);
    const detail=await app.request(`/api/v1/users/${sso.user.id}`,{headers:{cookie}});
    expect(detail.status).toBe(200);
    expect((await detail.json()).projects.items).toEqual([{id:"projectA",name:"test-project-a"},{id:"projectB",name:"test-project-b"}]);
    const candidates=await app.request('/api/v1/projects/projectC/member-candidates?limit=1',{headers:{cookie}});
    expect(candidates.status).toBe(200);expect((await candidates.json()).items).toHaveLength(1);
    for (const method of ["PUT", "DELETE"]) {
      const denied = await app.request(`/api/v1/projects/projectA/members/${sso.user.id}`, {method,headers:{cookie,origin:"http://localhost:8080"}});
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({error:{code:"sso_managed_membership"}});
    }
    expect((await app.request("/api/v1/users")).status).toBe(401);
    const memberLogin = await app.request("/api/auth/sign-in/username", {method:"POST",headers:{"content-type":"application/json",origin:"http://localhost:8080"},body:JSON.stringify({username:"fixture-projecta",password:"test-password-only"})});
    const memberCookie = memberLogin.headers.get("set-cookie")!.match(/tali-guard\.session_token=[^;]+/)![0];
    expect((await app.request("/api/v1/users", {headers:{cookie:memberCookie}})).status).toBe(403);
  });


  it("issues administrator entity tokens and isolates list/detail reads to the explicit project", async () => {
    await auth.api.createUser({ body: { email: "scope-admin@test.example", password: "test-password-only", name: "Scope admin", role: "admin", data: { username: "scope-admin" } } });
    const login = await app.request("/api/auth/sign-in/username", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:8080" }, body: JSON.stringify({ username: "scope-admin", password: "test-password-only" }) });
    const cookie = login.headers.get("set-cookie")!.match(/tali-guard\.session_token=[^;]+/)![0];
    const issue = async (permissions: Record<string, string>) => app.request("/api/v1/account/access-tokens", { method: "POST", headers: { cookie, "content-type": "application/json", origin: "http://localhost:8080" }, body: JSON.stringify({ name: "Entity access", expiresInDays: 7, permissions }) });
    expect((await issue({ settings: "write" })).status).toBe(400);
    expect((await issue({ guardrails: "write" })).status).toBe(403);
    const issued = await issue({ guardrails: "read", routers: "read", endpoints: "read", policies: "read", projects: "write" });
    expect(issued.status).toBe(201);
    const { secret } = await issued.json();
    const headers = { authorization: `Bearer ${secret}`, "content-type": "application/json" };
    const request = (path: string, project?: string, method = "GET", body?: unknown) => app.request(`/api/v1${path}`, { method,
      headers: { ...headers, ...(project === undefined ? {} : { "x-project-id": project }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const project of ["projectA", "projectB"]) {
      await pool.query("INSERT INTO guardrail (id,project_id,name,draft_config) VALUES ($1,$2,$1,'{}')", [`scoped-guard-${project}`, project]);
      await pool.query("INSERT INTO traffic_router (id,project_id,name,draft) VALUES ($1,$2,$1,$3)", [`scoped-router-${project}`, project, { routes: [] }]);
      const definition = emptyPolicyDefinition(); definition.metadata.id = `scoped-policy-${project}`; definition.metadata.name = `${project} policy`;
      await pool.query("INSERT INTO policy_resource (id,project_id,definition,maintainer) VALUES ($1,$2,$3,'fixture')", [definition.metadata.id, project, definition]);
    }
      for (const path of ["/guardrails", "/routers", "/endpoints", "/policies"]) {
        expect((await request(path)).status).toBe(400);
        expect((await request(path, "missing")).status).toBe(404);
        const response = await request(path, "projectB");
        expect(response.status, path).toBe(200);
        const data = await response.json();
        expect(data.items.some((item: { id: string }) => item.id.endsWith("projectA")), path).toBe(false);
        expect(data.items.some((item: { id: string }) => item.id.endsWith("projectB")), path).toBe(true);
      }
      for (const path of ["/guardrails/scoped-guard-projectA", "/routers/scoped-router-projectA", `/endpoints/${fixtureEndpoint("projectA")}`, "/policies/scoped-policy-projectA/definition"]) {
        expect((await request(path, "projectB")).status, path).toBe(404);
        expect((await request(path, "projectA")).status, path).toBe(200);
      }
      expect((await request("/guardrails/scoped-guard-projectB", "projectB", "PATCH", { name: "forbidden" })).status).toBe(403);
      expect((await request("/projects")).status).toBe(200);
      const created = await request("/projects", undefined, "POST", { name: "token-managed-project" });
      expect(created.status).toBe(201);
      const memberId = (await pool.query("SELECT id FROM auth_user WHERE username='fixture-projectb'")).rows[0].id;
      const path = `/projects/token-managed-project/members/${memberId}`;
      expect((await request(path, undefined, "PUT")).status).toBe(204);
      expect((await (await request("/projects/token-managed-project/members")).json()).items).toContainEqual(expect.objectContaining({ userId: memberId }));
      expect((await request(path, undefined, "DELETE")).status).toBe(204);
      expect((await (await request("/projects/token-managed-project/members")).json()).items).toEqual([]);
      expect((await request("/users")).status).toBe(403);
      const audit = await pool.query("SELECT detail FROM audit_event WHERE kind='access_token.request' AND detail->>'route'='/api/v1/projects'");
      expect(audit.rows).toContainEqual({ detail: expect.objectContaining({ method: "POST", status: 201 }) });
  }, 30_000);

  it("switches only to member projects and keeps personal credentials bound to their issued project", async () => {
    const login = await app.request("/api/auth/sign-in/username", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:8080" },
      body: JSON.stringify({ username: "fixture-projecta", password: "test-password-only" }) });
    const cookie = login.headers.get("set-cookie")!.match(/tali-guard\.session_token=[^;]+/)![0];
    const request = (path: string, method = "GET", body?: unknown, headers: Record<string,string> = {}) => app.request(path, {
      method, headers: { cookie, origin: "http://localhost:8080", "content-type": "application/json", ...headers }, ...(body ? {body:JSON.stringify(body)} : {}),
    });
    const identity = await (await request("/api/v1/account/identity")).json();
    expect((await request("/api/v1/account/project", "PUT", {projectId:"projectB"})).status).toBe(403);
    expect((await request("/api/v1/projects", "POST", {name:"forbidden"})).status).toBe(403);
    const issued = await (await request("/api/v1/account/access-tokens", "POST", {name:"Project A",expiresInDays:7,permissions:{endpoints:"read"}})).json();
    await pool.query("INSERT INTO project_member(project_id,user_id) VALUES ('projectB',$1)", [identity.userId]);
    expect((await request("/api/v1/account/project", "PUT", {projectId:"projectB"})).status).toBe(200);
    expect(await (await request("/api/v1/account/identity")).json()).toMatchObject({projectId:"projectB"});
    expect((await request("/api/v1/endpoints", "GET", undefined, {"x-project-id":"projectA"})).status).toBe(409);
    const tokenIdentity = await app.request("/api/v1/account/identity", {headers:{authorization:`Bearer ${issued.secret}`}});
    expect(await tokenIdentity.json()).toMatchObject({projectId:"projectA"});
    await pool.query("UPDATE project_member SET access='read' WHERE project_id='projectB' AND user_id=$1", [identity.userId]);
    expect((await request("/api/v1/endpoints", "POST", {name:"forbidden"})).status).toBe(403);
    expect((await request("/api/v1/endpoints")).status).toBe(200);
    await pool.query("DELETE FROM project_member WHERE project_id='projectA' AND user_id=$1", [identity.userId]);
    expect((await app.request("/api/v1/account/identity", {headers:{authorization:`Bearer ${issued.secret}`}})).status).toBe(401);
  });
});
