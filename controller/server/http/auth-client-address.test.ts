// @vitest-environment node
import { serve, type ServerType } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import type { ControllerAuth } from "../auth.js";
import type { RunnerControlServer } from "../control-channel/control-server.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import type { ControllerMetrics } from "../metrics.js";
import { createHttpApp } from "./app.js";

const base = {
  NODE_ENV: "test" as const,
  CONTROLLER_DATABASE_URL: "postgresql://test:test@localhost/test",
  CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
  CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key.pem",
  BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
};

let server: ServerType | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  server = undefined;
});

/** Serves the real HTTP app on a real socket so the peer address is observable. */
async function listen(trustedProxyCidrs: string) {
  const seen: Array<{ forwardedFor: string | undefined; body: string }> = [];
  const auth = {
    handler: async (request: Request) => {
      seen.push({ forwardedFor: request.headers.get("x-forwarded-for") ?? undefined, body: await request.text() });
      return Response.json({ ok: true });
    },
  } as unknown as ControllerAuth;
  const app = createHttpApp({
    config: loadConfig({ ...base, CONTROLLER_TRUSTED_PROXY_CIDRS: trustedProxyCidrs }),
    auth, service: {} as ControlPlaneService, runnerControl: {} as RunnerControlServer, metrics: {} as ControllerMetrics,
  });
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server!.listening ? resolve() : server!.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener.");
  return { seen, origin: `http://127.0.0.1:${address.port}` };
}

describe("auth client address", () => {
  it("replaces a client-supplied forwarding chain with the socket peer and keeps the body", async () => {
    const { seen, origin } = await listen("");
    const response = await fetch(`${origin}/api/auth/sign-in/username`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify({ username: "admin", password: "password" }),
    });
    expect(response.status).toBe(200);
    // A spoofed address must never become the throttle key's only input.
    expect(seen[0]?.forwardedFor).toBe("127.0.0.1");
    expect(JSON.parse(seen[0]!.body)).toEqual({ username: "admin", password: "password" });
  });

  it("preserves the chain when the deployment declares trusted proxies", async () => {
    const { seen, origin } = await listen("127.0.0.0/8");
    await fetch(`${origin}/api/auth/sign-in/username`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify({ username: "admin", password: "password" }),
    });
    expect(seen[0]?.forwardedFor).toBe("203.0.113.9");
  });
});
