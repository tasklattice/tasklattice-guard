// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clusterBootstrapEnvironment } from "./cluster-bootstrap.js";
const directories: string[] = [];
function account(fields: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "guard-account-"));
  directories.push(directory);
  for (const [name, value] of Object.entries(fields)) writeFileSync(join(directory, name), value);
  return directory;
}
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
describe("mounted bootstrap accounts", () => {
  it("loads username/password fields and the login policy without mutating the environment", () => {
    const input = { CONTROLLER_BOOTSTRAP_ADMIN_DIRECTORY: account({ username: "admin", name: "Admin", password: "password" }), CONTROLLER_MIN_LOGIN_LENGTH: "16" };
    const result = clusterBootstrapEnvironment(input);
    expect(result.CONTROLLER_BOOTSTRAP_ADMIN_USERNAME).toBe("admin");
    expect(result.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD).toBe("password");
    expect(result.BETTER_AUTH_MIN_PASSWORD_LENGTH).toBe("16");
    expect(input).not.toHaveProperty("CONTROLLER_BOOTSTRAP_ADMIN_USERNAME");
  });
  it("supports custom user fields", () => {
    const result = clusterBootstrapEnvironment({ CONTROLLER_BOOTSTRAP_USER_DIRECTORY: account({ mail: "user", label: "User", login: "key" }), CONTROLLER_BOOTSTRAP_USER_FIELDS: JSON.stringify({ usernameKey: "mail", nameKey: "label", credentialKey: "login" }) });
    expect(result.CONTROLLER_BOOTSTRAP_USER_USERNAME).toBe("user");
    expect(result.CONTROLLER_BOOTSTRAP_USER_PASSWORD).toBe("key");
  });
  it("fails for missing required fields and field traversal", () => {
    const directory = account({ username: "admin" });
    expect(() => clusterBootstrapEnvironment({ CONTROLLER_BOOTSTRAP_ADMIN_DIRECTORY: directory })).toThrow();
    expect(() => clusterBootstrapEnvironment({ CONTROLLER_BOOTSTRAP_ADMIN_DIRECTORY: directory, CONTROLLER_BOOTSTRAP_ADMIN_FIELDS: '{"nameKey":"../name"}' })).toThrow("Invalid bootstrap Secret field");
  });
});
