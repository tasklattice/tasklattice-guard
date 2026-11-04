// @vitest-environment node
import { expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { createHttpApp } from "./app.js";
import { passwordPolicySchema } from "../../shared/password-policy.js";

it("publishes the configured password requirements without caching them", async () => {
  const config = loadConfig({ NODE_ENV: "test", CONTROLLER_DATABASE_URL: "postgresql://test:test@localhost/test",
    CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters", CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/test-key.pem",
    BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters", BETTER_AUTH_MIN_PASSWORD_LENGTH: "16" });
  type Dependencies = Parameters<typeof createHttpApp>[0];
  const app = createHttpApp({ config, auth: {} as Dependencies["auth"], service: {} as Dependencies["service"],
    runnerControl: {} as Dependencies["runnerControl"], metrics: {} as Dependencies["metrics"] });
  const response = await app.request("/api/sign-in/options");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(passwordPolicySchema.parse(body.passwordPolicy)).toEqual({ minLength: 16, maxLength: 128 });
});
