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
  it("selects the target Policy catalog only in target mode", () => {
    expect(loadConfig(requiredEnvironment).policyCatalogMode).toBe("legacy");
    const target = loadConfig({ ...requiredEnvironment, CONTROLLER_POLICY_CATALOG_MODE: "target" });
    expect(target.policyCatalogMode).toBe("target");
    expect(target.policyCatalogDir).toContain("assets_target");
  });
  it("bounds Endpoint provenance rows and logical payload independently of database disk quotas", () => {
    expect(loadConfig(requiredEnvironment).endpointContextStorage).toEqual({ maxRowsPerPool: 256, maxRowsGlobal: 2048,
      maxPayloadBytesPerContext: 65536, maxPayloadBytesPerPool: 16777216, maxPayloadBytesGlobal: 67108864 });
    expect(loadConfig({ ...requiredEnvironment, CONTROLLER_ENDPOINT_CONTEXT_MAX_ROWS_PER_POOL: "128",
      CONTROLLER_ENDPOINT_CONTEXT_MAX_ROWS_GLOBAL: "512" }).endpointContextStorage.maxRowsGlobal).toBe(512);
    for (const invalid of [
      { CONTROLLER_ENDPOINT_CONTEXT_MAX_ROWS_PER_POOL: "0" },
      { CONTROLLER_ENDPOINT_CONTEXT_MAX_ROWS_GLOBAL: "255" },
      { CONTROLLER_ENDPOINT_CONTEXT_MAX_PAYLOAD_BYTES_PER_POOL: "65535" },
      { CONTROLLER_ENDPOINT_CONTEXT_MAX_PAYLOAD_BYTES_GLOBAL: "NaN" },
      { CONTROLLER_ENDPOINT_CONTEXT_MAX_ROWS_GLOBAL: "1000001" },
      { CONTROLLER_ENDPOINT_CONTEXT_MAX_PAYLOAD_BYTES_GLOBAL: "2147483648" },
    ]) expect(() => loadConfig({ ...requiredEnvironment, ...invalid })).toThrow();
  });
  it("keeps experimental lease responses disabled and requires pool tokens to opt in", () => {
    expect(loadConfig(requiredEnvironment).experimentalRunnerLeaseGrants).toBe(false);
    expect(() => loadConfig({ ...requiredEnvironment, CONTROLLER_EXPERIMENTAL_RUNNER_LEASE_GRANTS: "true" }))
      .toThrow(/CONTROLLER_EXPERIMENTAL_RUNNER_LEASE_GRANTS/);
    expect(loadConfig({ ...requiredEnvironment, CONTROLLER_EXPERIMENTAL_RUNNER_LEASE_GRANTS: "true",
      CONTROLLER_RUNNER_POOL_TOKENS_JSON: JSON.stringify({ default: "test-pool-token-that-is-long-enough-123" }) }).experimentalRunnerLeaseGrants).toBe(true);
  });
  it("requires a pool token mapping for explicitly scoped telemetry", () => {
    const poolTokens = JSON.stringify({ "pool-a": "pool-a-token-that-is-at-least-32-chars" });
    expect(loadConfig({ ...requiredEnvironment, CONTROLLER_RUNNER_POOL_TOKENS_JSON: poolTokens }).runnerScopedTelemetry).toBe(false);
    expect(loadConfig({ ...requiredEnvironment, CONTROLLER_RUNNER_POOL_TOKENS_JSON: poolTokens, CONTROLLER_RUNNER_SCOPED_TELEMETRY: "true" }).runnerScopedTelemetry).toBe(true);
    expect(() => loadConfig({ ...requiredEnvironment, CONTROLLER_RUNNER_SCOPED_TELEMETRY: "true" })).toThrow("requires CONTROLLER_RUNNER_POOL_TOKENS_JSON");
    expect(() => loadConfig({ ...requiredEnvironment, CONTROLLER_RUNNER_SCOPED_TELEMETRY: "yes" })).toThrow();
  });
  it("validates optional distinct pool-scoped control-channel credentials without leaking secrets", () => {
    const a = "pool-a-token-that-is-at-least-32-chars";
    const b = "pool-b-token-that-is-at-least-32-chars";
    expect(loadConfig(requiredEnvironment).runnerPoolTokens).toBeNull();
    expect([...loadConfig({ ...requiredEnvironment, CONTROLLER_RUNNER_POOL_TOKENS_JSON: JSON.stringify({ "pool-a": a, "pool-b": b }) }).runnerPoolTokens!])
      .toEqual([["pool-a", a], ["pool-b", b]]);
    for (const raw of ["", "not-json", "{}", "[]", JSON.stringify({ "BAD POOL": a }), JSON.stringify({ "pool-a": "short" }),
      JSON.stringify({ "pool-a": `${a} token` }), JSON.stringify({ "pool-a": a, "pool-b": a }),
      JSON.stringify({ "pool-a": requiredEnvironment.CONTROLLER_RUNNER_TOKEN })]) {
      try {
        loadConfig({ ...requiredEnvironment, CONTROLLER_RUNNER_POOL_TOKENS_JSON: raw });
        throw new Error("Expected invalid pool token configuration to fail.");
      } catch (error) {
        expect(String(error)).toContain("CONTROLLER_RUNNER_POOL_TOKENS_JSON");
        expect(String(error)).not.toContain(a);
        expect(String(error)).not.toContain(requiredEnvironment.CONTROLLER_RUNNER_TOKEN);
      }
    }
  });
  it("requires a complete, role-separated Controller HTTP token map when opted in", () => {
    const a = "pool-a-control-token-with-at-least-32-characters";
    const b = "pool-b-control-token-with-at-least-32-characters";
    const httpA = "pool-a-inbound-http-token-with-at-least-32-characters";
    const httpB = "pool-b-inbound-http-token-with-at-least-32-characters";
    const environment = { ...requiredEnvironment, CONTROLLER_RUNNER_POOL_TOKENS_JSON: JSON.stringify({ "pool-a": a, "pool-b": b }) };
    expect(loadConfig(environment).runnerHttpTokens).toBeNull();
    expect([...loadConfig({ ...environment, CONTROLLER_RUNNER_HTTP_TOKENS_JSON: JSON.stringify({ "pool-a": httpA, "pool-b": httpB }) }).runnerHttpTokens!])
      .toEqual([["pool-a", httpA], ["pool-b", httpB]]);
    for (const values of [{ "pool-a": httpA }, { "pool-a": httpA, extra: httpB }, { "pool-a": b, "pool-b": httpB },
      { "pool-a": httpA, "pool-b": httpA }, { "pool-a": requiredEnvironment.CONTROLLER_RUNNER_TOKEN, "pool-b": httpB }]) {
      let error: unknown;
      try { loadConfig({ ...environment, CONTROLLER_RUNNER_HTTP_TOKENS_JSON: JSON.stringify(values) }); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      for (const token of [a, b, httpA, httpB, requiredEnvironment.CONTROLLER_RUNNER_TOKEN]) expect(String(error)).not.toContain(token);
    }
    expect(() => loadConfig({ ...requiredEnvironment, CONTROLLER_RUNNER_HTTP_TOKENS_JSON: JSON.stringify({ "pool-a": httpA }) }))
      .toThrow(/requires exactly the pool IDs/);
  });
  it("rejects duplicate decoded pool IDs rather than overwriting secret-map entries", () => {
    const tokenA = "pool-a-control-token-with-at-least-32-characters";
    const tokenB = "pool-b-control-token-with-at-least-32-characters";
    const inbound = "pool-a-inbound-http-token-with-at-least-32-characters";
    const duplicates = [
      `{"pool-a":${JSON.stringify(tokenA)},"pool-a":${JSON.stringify(tokenB)}}`,
      `{"pool-a":${JSON.stringify(tokenA)},"pool\\u002da":${JSON.stringify(tokenB)}}`,
    ];
    for (const raw of duplicates) {
      expect(() => loadConfig({ ...requiredEnvironment, CONTROLLER_RUNNER_POOL_TOKENS_JSON: raw })).toThrow(/CONTROLLER_RUNNER_POOL_TOKENS_JSON/);
      expect(() => loadConfig({ ...requiredEnvironment,
        CONTROLLER_RUNNER_POOL_TOKENS_JSON: JSON.stringify({ "pool-a": tokenA }),
        CONTROLLER_RUNNER_HTTP_TOKENS_JSON: raw.replaceAll(tokenA, inbound) })).toThrow(/CONTROLLER_RUNNER_HTTP_TOKENS_JSON/);
    }
    for (const malformed of ['{"pool-a":1}', '{"pool-a":null}', '{"pool-a":{}}', '{"pool-a":"unterminated}',
      `{"pool-a":${JSON.stringify(tokenA)},}`, `{"pool-a":${JSON.stringify(tokenA)}} trailing`]) {
      expect(() => loadConfig({ ...requiredEnvironment, CONTROLLER_RUNNER_POOL_TOKENS_JSON: malformed })).toThrow(/CONTROLLER_RUNNER_POOL_TOKENS_JSON/);
    }
    const escaped = ` { "pool\\u002da" : ${JSON.stringify(tokenA)} }\n`;
    expect(loadConfig({ ...requiredEnvironment, CONTROLLER_RUNNER_POOL_TOKENS_JSON: escaped }).runnerPoolTokens?.get("pool-a")).toBe(tokenA);
  });
  it("rejects non-ASCII and control characters in both pool credential roles without exposing values", () => {
    const control = "pool-a-control-token-with-at-least-32-characters";
    for (const suffix of ["\u00e9", "\ud800", "\ud801", "\udfff", "\ufffd", "\ud83d\ude00", "\u0000", "\u001f", "\u007f", " ", "\t", "\n"]) {
      const token = `${"s".repeat(32)}${suffix}`;
      for (const setting of ["CONTROLLER_RUNNER_POOL_TOKENS_JSON", "CONTROLLER_RUNNER_HTTP_TOKENS_JSON"]) {
        let error: unknown;
        try {
          loadConfig({ ...requiredEnvironment, CONTROLLER_RUNNER_POOL_TOKENS_JSON: JSON.stringify({ "pool-a": control }),
            [setting]: JSON.stringify({ "pool-a": token }) });
        } catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toContain(setting);
        expect(String(error)).toContain("printable ASCII");
        expect(String(error)).not.toContain(token);
      }
    }
    const ascii = "!" + "a".repeat(30) + "~";
    expect(loadConfig({ ...requiredEnvironment, CONTROLLER_RUNNER_POOL_TOKENS_JSON: JSON.stringify({ "pool-a": control }),
      CONTROLLER_RUNNER_HTTP_TOKENS_JSON: JSON.stringify({ "pool-a": ascii }) }).runnerHttpTokens?.get("pool-a")).toBe(ascii);
  });
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
  it("normalizes an explicit bootstrap Project and rejects the reserved Runner pool name", () => {
    const env = { ...requiredEnvironment, CONTROLLER_BOOTSTRAP_USER_USERNAME: "user", CONTROLLER_BOOTSTRAP_USER_PASSWORD: "password" };
    expect(loadConfig({ ...env, CONTROLLER_BOOTSTRAP_USER_PROJECT: " My_Project " }).bootstrapUser?.project).toBe("my-project");
    expect(() => loadConfig({ ...env, CONTROLLER_BOOTSTRAP_USER_PROJECT: "default" })).toThrow();
  });
  it("accepts separate username/password accounts", () => {
    expect(loadConfig(requiredEnvironment).bootstrapUser).toBeNull();
    expect(loadConfig({ ...requiredEnvironment, CONTROLLER_BOOTSTRAP_USER_USERNAME: " USER ", CONTROLLER_BOOTSTRAP_USER_PASSWORD: "password" }).bootstrapUser)
      .toEqual({ username: "user", password: "password" });
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
