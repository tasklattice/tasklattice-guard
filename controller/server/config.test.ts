import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

const requiredEnvironment = {
  NODE_ENV: "test",
  CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller",
  CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
  CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
  BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
};

describe("Controller config", () => {
  it("supplies finite database budgets and validates the Runner synchronization limit", () => {
    expect(loadConfig(requiredEnvironment)).toMatchObject({ databaseTimeouts: { statementMs: 30000, lockMs: 5000, idleTransactionMs: 30000 }, runnerSyncConcurrency: 4 });
    for (const key of ["CONTROLLER_DATABASE_STATEMENT_TIMEOUT_MS", "CONTROLLER_DATABASE_LOCK_TIMEOUT_MS", "CONTROLLER_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS", "CONTROLLER_RUNNER_SYNC_CONCURRENCY"]) {
      expect(() => loadConfig({ ...requiredEnvironment, [key]: "0" })).toThrow();
    }
    expect(() => loadConfig({ ...requiredEnvironment, CONTROLLER_RUNNER_SYNC_CONCURRENCY: "9" })).toThrow();
  });
  it("keeps the password minimum at 8 by default", () => {
    expect(loadConfig(requiredEnvironment)).toMatchObject({
      minPasswordLength: 8,
      metricsToken: null,
    });
  });

  it("accepts only a non-trivial optional metrics token", () => {
    expect(loadConfig({
      ...requiredEnvironment,
      CONTROLLER_METRICS_TOKEN: "metrics-token-that-is-at-least-32-characters",
    }).metricsToken).toBe("metrics-token-that-is-at-least-32-characters");
    expect(() => loadConfig({
      ...requiredEnvironment,
      CONTROLLER_METRICS_TOKEN: "short",
    })).toThrow();
  });

  it("requires metrics authentication in production", () => {
    expect(() => loadConfig({ ...requiredEnvironment, NODE_ENV: "production" })).toThrow(
      /CONTROLLER_METRICS_TOKEN/,
    );
  });

  it.each(["admin", "another-admin"])("rejects short bootstrap passwords for %s", (username) => {
    expect(() => loadConfig({
      ...requiredEnvironment,
      NODE_ENV: "development",
      CONTROLLER_PUBLIC_URL: "http://localhost:38081",
      CONTROLLER_BOOTSTRAP_ADMIN_USERNAME: username,
      CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD: "admin",
    })).toThrow(/at least 8 characters/);
  });

  it("exposes a configurable Policy catalog directory", () => {
    expect(loadConfig({
      ...requiredEnvironment,
      CONTROLLER_POLICY_CATALOG_DIR: "/var/lib/tasklattice/policies",
    }).policyCatalogDir).toBe("/var/lib/tasklattice/policies");
  });

  it("uses the Runner toolkit assets for local development by default", () => {
    expect(loadConfig(requiredEnvironment).policyCatalogDir).toBe("../runner/toolkit/policy_library/assets");
  });

  it("keeps the stable Runtime Service origin separate from the Controller origin", () => {
    expect(loadConfig(requiredEnvironment).runtimeServiceUrl).toBe("http://localhost:8091");
    expect(loadConfig({
      ...requiredEnvironment,
      CONTROLLER_PUBLIC_URL: "https://controller.example.test/",
      CONTROLLER_RUNTIME_SERVICE_URL: "https://runtime.example.test/",
    })).toMatchObject({
      publicUrl: "https://controller.example.test",
      runtimeServiceUrl: "https://runtime.example.test",
    });
  });

  it.each([undefined, "", "   "])("leaves the public Runtime URL optional: %j", (value) => {
    expect(loadConfig({ ...requiredEnvironment, CONTROLLER_RUNTIME_PUBLIC_URL: value }).runtimePublicUrl).toBeNull();
  });

  it("normalizes the public Runtime base URL without changing internal calls", () => {
    expect(loadConfig({
      ...requiredEnvironment,
      CONTROLLER_RUNTIME_PUBLIC_URL: " https://guard.example.test:8443/guard/// ",
      CONTROLLER_RUNTIME_SERVICE_URL: "http://guard-runtime.uat.svc.cluster.local:8091/",
    })).toMatchObject({
      runtimePublicUrl: "https://guard.example.test:8443/guard",
      runtimeServiceUrl: "http://guard-runtime.uat.svc.cluster.local:8091",
    });
  });

  it.each([
    "guard.example.test", "https://", "ftp://guard.example.test", "https://user:password@guard.example.test",
    "https://guard.example.test?token=secret", "https://guard.example.test/#endpoint",
  ])("rejects an invalid public Runtime base URL: %s", (value) => {
    expect(() => loadConfig({ ...requiredEnvironment, CONTROLLER_RUNTIME_PUBLIC_URL: value }))
      .toThrow(/CONTROLLER_RUNTIME_PUBLIC_URL/);
  });


});


describe("bootstrap username/password configuration", () => {
  it("accepts separate username/password accounts", () => {
    expect(loadConfig(requiredEnvironment).bootstrapUser).toBeNull();
    expect(loadConfig({ ...requiredEnvironment, CONTROLLER_BOOTSTRAP_USER_USERNAME: " USER ", CONTROLLER_BOOTSTRAP_USER_PASSWORD: "password" }).bootstrapUser)
      .toEqual({ username: "user", password: "password", name: "User" });
  });
  it.each([
    { CONTROLLER_BOOTSTRAP_USER_USERNAME: "user" },
    { CONTROLLER_BOOTSTRAP_USER_PASSWORD: "password" },
    { CONTROLLER_BOOTSTRAP_USER_USERNAME: "user@example.com", CONTROLLER_BOOTSTRAP_USER_PASSWORD: "password" },
    { CONTROLLER_BOOTSTRAP_USER_USERNAME: "user", CONTROLLER_BOOTSTRAP_USER_PASSWORD: "short" },
    { CONTROLLER_BOOTSTRAP_USER_USERNAME: "ADMIN", CONTROLLER_BOOTSTRAP_USER_PASSWORD: "password", CONTROLLER_BOOTSTRAP_ADMIN_USERNAME: "admin", CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD: "password" },
  ])("rejects invalid or conflicting accounts: %j", environment => {
    expect(() => loadConfig({ ...requiredEnvironment, ...environment })).toThrow();
  });
});

describe("explicit control-channel transport", () => {
  it("defaults production to mTLS and allows an explicit plaintext choice", () => {
    const environment = { ...requiredEnvironment, NODE_ENV: "production", CONTROLLER_METRICS_TOKEN: "metrics-token-at-least-32-characters" };
    expect(loadConfig(environment).grpcTransport).toBe("mtls");
    expect(loadConfig({ ...environment, CONTROLLER_GRPC_TRANSPORT: "plaintext" })).toMatchObject({ grpcTransport: "plaintext", grpcTls: null, nodeEnv: "production" });
  });

  it("rejects incomplete certificates and conflicting plaintext settings", () => {
    expect(() => loadConfig({ ...requiredEnvironment, CONTROLLER_GRPC_TLS_CERT_PATH: "/cert" })).toThrow(/configured together/);
    expect(() => loadConfig({ ...requiredEnvironment, CONTROLLER_GRPC_TRANSPORT: "plaintext", CONTROLLER_GRPC_TLS_CERT_PATH: "/cert", CONTROLLER_GRPC_TLS_KEY_PATH: "/key", CONTROLLER_GRPC_TLS_CLIENT_CA_PATH: "/ca" })).toThrow(/Plaintext gRPC/);
  });
});
