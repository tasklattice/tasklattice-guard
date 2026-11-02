import { createHmac } from "node:crypto";

import { eq } from "drizzle-orm";

import { isMockSsoIdentity, mockSsoIdentities, type MockSsoIdentity } from "../shared/mock-sso.js";
import { internalAccountEmail } from "../shared/username.js";
import type { ControllerAuth } from "./auth.js";
import type { ControllerConfig } from "./config.js";
import type { ControllerDatabase } from "./db/client.js";
import { account, endpoints, user } from "./db/schema.js";

const demoUsername = (identity: MockSsoIdentity) => `mock-${identity.toLowerCase()}`;

function demoPassword(config: ControllerConfig, identity: MockSsoIdentity) {
  // This password never leaves the server. The selector signs in through
  // Better Auth rather than minting a session or accepting a tenant claim.
  return createHmac("sha256", config.betterAuthSecret)
    .update(`tasklattice-mock-sso:v1:${identity}`)
    .digest("base64url");
}

export async function ensureMockSsoUsers(input: {
  auth: ControllerAuth;
  db: ControllerDatabase;
  config: ControllerConfig;
}): Promise<Array<{ tenantId: MockSsoIdentity; userId: string }>> {
  if (!input.config.mockSsoEnabled) return [];
  const provisioned: Array<{ tenantId: MockSsoIdentity; userId: string }> = [];
  for (const identity of mockSsoIdentities) {
    const username = demoUsername(identity.id);
    const [existing] = await input.db.select({
      id: user.id, role: user.role, tenantId: user.tenantId, banned: user.banned,
    }).from(user).where(eq(user.username, username)).limit(1);
    if (existing) {
      const linked = await input.db.select({ providerId: account.providerId }).from(account).where(eq(account.userId, existing.id));
      if (existing.tenantId !== identity.tenantId || existing.role !== "user" || existing.banned
        || !linked.some((item) => item.providerId === "credential")) {
        throw new Error(`Mock SSO identity ${identity.id} conflicts with an existing account.`);
      }
      provisioned.push({ tenantId: identity.tenantId, userId: existing.id });
      await ensureDemoEndpoint(input.db, identity);
      continue;
    }

    const created = await input.auth.api.createUser({ body: {
      email: internalAccountEmail(username),
      password: demoPassword(input.config, identity.id),
      name: identity.displayName,
      role: "user",
      data: { username },
    } });
    await input.db.update(user).set({ tenantId: identity.tenantId }).where(eq(user.id, created.user.id));
    provisioned.push({ tenantId: identity.tenantId, userId: created.user.id });
    await ensureDemoEndpoint(input.db, identity);
  }
  return provisioned;
}

async function ensureDemoEndpoint(db: ControllerDatabase, identity: (typeof mockSsoIdentities)[number]) {
  const id = `mock-sso-endpoint-${identity.id}`;
  const [existing] = await db.select({ tenantId: endpoints.tenantId }).from(endpoints).where(eq(endpoints.id, id)).limit(1);
  if (existing) {
    if (existing.tenantId !== identity.tenantId) throw new Error(`Mock SSO endpoint ${id} belongs to another tenant.`);
    return;
  }
  await db.insert(endpoints).values({
    id,
    tenantId: identity.tenantId,
    name: `${identity.tenantId} Demo Endpoint`,
    adapter: "litellm-generic-guardrail",
    status: "disabled",
    verification: {},
  }).onConflictDoNothing();
}

export async function signInMockSsoIdentity(
  auth: ControllerAuth,
  config: ControllerConfig,
  identity: unknown,
): Promise<Response> {
  if (!config.mockSsoEnabled) throw new Error("Mock SSO is disabled.");
  if (!isMockSsoIdentity(identity)) throw new Error("Unknown mock SSO identity.");
  return auth.api.signInUsername({
    body: { username: demoUsername(identity), password: demoPassword(config, identity) },
    asResponse: true,
  });
}
