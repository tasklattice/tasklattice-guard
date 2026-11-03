import { describe, expect, it, vi } from "vitest";

import type { ControllerAuth } from "./auth.js";
import type { ControllerConfig } from "./config.js";
import type { ControllerDatabase } from "./db/client.js";
import { ensureMockSsoUsers, signInMockSsoIdentity } from "./mock-sso.js";

const config = { mockSsoEnabled: true, betterAuthSecret: "a-test-secret-that-is-at-least-32-characters" } as ControllerConfig;

describe("Mock SSO", () => {
  it("seeds three tenant-local business users and assigns their canonical tenants", async () => {
    const created: Array<Record<string, unknown>> = [];
    const tenantAssignments: string[] = [];
    const demoEndpoints: Array<Record<string, unknown>> = [];
    const auth = { api: { createUser: vi.fn(async ({ body }: { body: Record<string, unknown> }) => {
      created.push(body);
      return { user: { id: `demo-${created.length}` } };
    }) } } as unknown as ControllerAuth;
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
      update: () => ({ set: ({ tenantId }: { tenantId: string }) => {
        tenantAssignments.push(tenantId);
        return { where: async () => undefined };
      } }),
      insert: () => ({ values: (value: Record<string, unknown>) => {
        demoEndpoints.push(value);
        return { onConflictDoNothing: async () => undefined };
      } }),
    } as unknown as ControllerDatabase;

    expect(await ensureMockSsoUsers({ auth, db, config })).toEqual([
      { tenantId: "tenantA", userId: "demo-1" },
      { tenantId: "tenantB", userId: "demo-2" },
      { tenantId: "tenantC", userId: "demo-3" },
    ]);
    expect(created.map((entry) => entry.role)).toEqual(["user", "user", "user"]);
    expect(tenantAssignments).toEqual(["tenantA", "tenantB", "tenantC"]);
    expect(new Set(created.map((entry) => entry.password)).size).toBe(3);
    expect(demoEndpoints).toEqual([
      expect.objectContaining({ id: "mock-sso-endpoint-tenantA", tenantId: "tenantA", status: "disabled" }),
      expect.objectContaining({ id: "mock-sso-endpoint-tenantB", tenantId: "tenantB", status: "disabled" }),
      expect.objectContaining({ id: "mock-sso-endpoint-tenantC", tenantId: "tenantC", status: "disabled" }),
    ]);
  });

  it("leaves existing demo users and Endpoints unchanged on restart", async () => {
    let identityIndex = -1;
    const createUser = vi.fn();
    const insert = vi.fn();
    const db = {
      select: (projection: Record<string, unknown>) => ({ from: () => ({ where: () => {
        let rows: Record<string, unknown>[];
        if ("role" in projection) {
          identityIndex += 1;
          rows = [{ id: `demo-${identityIndex}`, role: "user", tenantId: ["tenantA", "tenantB", "tenantC"][identityIndex], banned: false }];
        } else if ("providerId" in projection) rows = [{ providerId: "credential" }];
        else rows = [{ tenantId: ["tenantA", "tenantB", "tenantC"][identityIndex] }];
        return { limit: async () => rows, then: (resolve: (value: typeof rows) => void) => resolve(rows) };
      } }) }),
      insert,
    } as unknown as ControllerDatabase;
    const auth = { api: { createUser } } as unknown as ControllerAuth;
    expect(await ensureMockSsoUsers({ auth, db, config })).toEqual([
      { tenantId: "tenantA", userId: "demo-0" },
      { tenantId: "tenantB", userId: "demo-1" },
      { tenantId: "tenantC", userId: "demo-2" },
    ]);
    expect(createUser).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("signs in a fixed identity through Better Auth without accepting a tenant claim", async () => {
    const response = new Response("ok", { status: 200 });
    const signInUsername = vi.fn().mockResolvedValue(response);
    const auth = { api: { signInUsername } } as unknown as ControllerAuth;
    expect(await signInMockSsoIdentity(auth, config, "tenantB")).toBe(response);
    expect(signInUsername).toHaveBeenCalledWith({
      body: { username: "mock-tenantb", password: expect.any(String) },
      asResponse: true,
    });
    await expect(signInMockSsoIdentity(auth, config, "other-tenant")).rejects.toThrow("Unknown mock SSO identity");
    await expect(signInMockSsoIdentity(auth, { ...config, mockSsoEnabled: false }, "tenantA")).rejects.toThrow("Mock SSO is disabled");
    expect(signInUsername).toHaveBeenCalledTimes(1);
  });
});
