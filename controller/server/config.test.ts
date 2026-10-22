import { describe, expect, it } from "vitest";
import { hashPassword } from "better-auth/crypto";

import { loadConfig } from "./config.js";

const requiredEnvironment = {
  NODE_ENV: "test",
  CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller",
  CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
  CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
  BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
};

describe("Controller config", () => {
  it("keeps the production password minimum at 12 by default", () => {
    expect(loadConfig(requiredEnvironment)).toMatchObject({
      minPasswordLength: 12,
      mockSsoEnabled: false,
      metricsToken: null,
    });
  });

  it("enables mock SSO only by explicit local, non-production configuration", () => {
    expect(loadConfig({ ...requiredEnvironment, CONTROLLER_HTTP_HOST: "127.0.0.1", CONTROLLER_MOCK_SSO_ENABLED: "true" }).mockSsoEnabled).toBe(true);
    expect(() => loadConfig({ ...requiredEnvironment, CONTROLLER_MOCK_SSO_ENABLED: "true" })).toThrow(/CONTROLLER_MOCK_SSO_ENABLED|Mock SSO/);
    expect(() => loadConfig({ ...requiredEnvironment, CONTROLLER_HTTP_HOST: "127.0.0.1", NODE_ENV: "production", CONTROLLER_MOCK_SSO_ENABLED: "true", CONTROLLER_METRICS_TOKEN: "metrics-token-that-is-at-least-32-characters" })).toThrow(/CONTROLLER_MOCK_SSO_ENABLED|Mock SSO/);
    expect(() => loadConfig({ ...requiredEnvironment, CONTROLLER_HTTP_HOST: "127.0.0.1", CONTROLLER_PUBLIC_URL: "https://guard.example.test", CONTROLLER_MOCK_SSO_ENABLED: "true" })).toThrow(/CONTROLLER_MOCK_SSO_ENABLED|Mock SSO/);
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

  it.each(["admin@tasklattice.local", "another-admin@tasklattice.local"])("rejects short bootstrap passwords for %s on localhost", (email) => {
    expect(() => loadConfig({
      ...requiredEnvironment,
      NODE_ENV: "development",
      CONTROLLER_PUBLIC_URL: "http://localhost:38081",
      CONTROLLER_BOOTSTRAP_ADMIN_EMAIL: email,
      CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD: "admin",
    })).toThrow(/at least 12 characters/);
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

  it("exposes the selected control-plane and data-plane models without credentials", () => {
    expect(loadConfig(requiredEnvironment).modelConnections).toEqual({
      controlPlane: {
        provider: "Qwen",
        model: "not-configured",
      },
      dataPlane: {
        provider: "Runner",
        models: [],
      },
    });

    expect(loadConfig({
      ...requiredEnvironment,
      MODEL_GUARDRAILS_CONTROL_PLANE_AI_MODEL: "Qwen/Qwen3.5-9B",
      MODEL_GUARDRAILS_MODEL_RUNTIMES_JSON: JSON.stringify([
        { id: "qwen", client: "openai_chat", base_url: "http://qwen/v1", model: "Qwen/Qwen3Guard-Gen-8B" },
        { id: "judge", client: "openai_chat", base_url: "http://judge/v1", model: "Qwen/Qwen3.5-9B" },
      ]),
    }).modelConnections).toMatchObject({
      controlPlane: { provider: "Qwen", model: "Qwen/Qwen3.5-9B" },
      dataPlane: {
        provider: "Runner",
        models: [
          { id: "qwen", model: "Qwen/Qwen3Guard-Gen-8B" },
          { id: "judge", model: "Qwen/Qwen3.5-9B" },
        ],
      },
    });
  });

  it("restores the optional control-plane authoring model contract", () => {
    expect(loadConfig(requiredEnvironment).controlPlaneAi).toBeNull();
    expect(loadConfig({
      ...requiredEnvironment,
      MODEL_GUARDRAILS_CONTROL_PLANE_AI_BASE_URL: "https://api.deepseek.com/v1/",
      MODEL_GUARDRAILS_CONTROL_PLANE_AI_MODEL: "deepseek-test",
      MODEL_GUARDRAILS_CONTROL_PLANE_AI_API_KEY: "secret",
    }).controlPlaneAi).toEqual({
      provider: "Qwen",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-test",
      apiKey: "secret",
      timeoutMs: 45_000,
    });
  });

  it("ignores a partial legacy control-plane model so Settings remains available", () => {
    expect(loadConfig({
      ...requiredEnvironment,
      MODEL_GUARDRAILS_CONTROL_PLANE_AI_BASE_URL: "https://api.deepseek.com/v1",
    }).controlPlaneAi).toBeNull();
    expect(loadConfig({
      ...requiredEnvironment,
      MODEL_GUARDRAILS_CONTROL_PLANE_AI_API_KEY: "secret",
    }).controlPlaneAi).toBeNull();
  });

  it("ignores invalid legacy Evaluator Bindings before startup", () => {
    const runtimes = JSON.stringify([{
      id: "llama", client: "openai_chat", base_url: "http://llama/v1",
      model: "meta-llama/Llama-Guard-3-8B",
    }]);
    expect(loadConfig({
      ...requiredEnvironment,
      MODEL_GUARDRAILS_MODEL_RUNTIMES_JSON: runtimes,
      MODEL_GUARDRAILS_EVALUATOR_BINDINGS_JSON: JSON.stringify([{
        id: "bad-jailbreak", contract_ref: "tali.guard.jailbreak.v1",
        profile_ref: "tali.llama-guard-3.v1", model_ref: "llama", priority: 10,
      }]),
    }).modelConnections.dataPlane.models).toEqual([{ id: "llama", model: "meta-llama/Llama-Guard-3-8B" }]);
    expect(loadConfig({
      ...requiredEnvironment,
      MODEL_GUARDRAILS_MODEL_RUNTIMES_JSON: runtimes,
      MODEL_GUARDRAILS_EVALUATOR_BINDINGS_JSON: JSON.stringify([{
        id: "unknown-runtime", contract_ref: "tali.guard.content-safety.v1",
        profile_ref: "tali.llama-guard-3.v1", model_ref: "missing", priority: 10,
      }]),
    }).modelConnections.dataPlane.models).toEqual([{ id: "llama", model: "meta-llama/Llama-Guard-3-8B" }]);
  });
});


describe("bootstrap passwordHash configuration", () => {
  it("keeps the user bootstrap opt-in and accepts its separate credentials", async () => {
    expect(loadConfig(requiredEnvironment).bootstrapUser).toBeNull();
    const passwordHash = await hashPassword("password");
    expect(loadConfig({ ...requiredEnvironment, CONTROLLER_BOOTSTRAP_USER_EMAIL: "user@tasklattice.local", CONTROLLER_BOOTSTRAP_USER_PASSWORD_HASH: passwordHash }).bootstrapUser)
      .toEqual({ email: "user@tasklattice.local", passwordHash, name: "User" });
  });
  it.each([
    { CONTROLLER_BOOTSTRAP_USER_EMAIL: "user@tasklattice.local" },
    { CONTROLLER_BOOTSTRAP_USER_PASSWORD_HASH: "invalid" },
    { CONTROLLER_BOOTSTRAP_USER_EMAIL: "user@tasklattice.local", CONTROLLER_BOOTSTRAP_USER_PASSWORD: "password" },
    { CONTROLLER_BOOTSTRAP_USER_EMAIL: "user@tasklattice.local", CONTROLLER_BOOTSTRAP_USER_PASSWORD: "long-enough-password", CONTROLLER_BOOTSTRAP_USER_PASSWORD_HASH: "a".repeat(32) + ":" + "b".repeat(128) },
    { CONTROLLER_BOOTSTRAP_USER_EMAIL: "ADMIN@tasklattice.local", CONTROLLER_BOOTSTRAP_USER_PASSWORD: "long-enough-password", CONTROLLER_BOOTSTRAP_ADMIN_EMAIL: "admin@tasklattice.local", CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD: "long-enough-password" },
  ])("rejects invalid or conflicting bootstrap user configuration: %j", environment => {
    expect(() => loadConfig({ ...requiredEnvironment, ...environment })).toThrow();
  });
  it("accepts a hash without a plaintext password", async () => {
    const passwordHash = await hashPassword("Password");
    const config = loadConfig({ ...requiredEnvironment,
      CONTROLLER_BOOTSTRAP_ADMIN_EMAIL: "admin@example.test",
      CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD_HASH: passwordHash,
    });
    expect(config.bootstrapAdmin).toMatchObject({ email: "admin@example.test", passwordHash });
    expect(config.bootstrapAdmin).not.toHaveProperty("password");
    expect(() => loadConfig({ ...requiredEnvironment,
      CONTROLLER_BOOTSTRAP_ADMIN_EMAIL: "admin@example.test",
      CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD_HASH: passwordHash,
      CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD: "another-password",
    })).toThrow(/mutually exclusive/);
    expect(() => loadConfig({ ...requiredEnvironment,
      CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD_HASH: passwordHash,
    })).toThrow(/Bootstrap email/);
  });

  it("rejects malformed hashes and missing credentials", () => {
    expect(() => loadConfig({ ...requiredEnvironment,
      CONTROLLER_BOOTSTRAP_ADMIN_EMAIL: "admin@example.test",
      CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD_HASH: "not-a-password-hash",
    })).toThrow(/scrypt/);
    expect(() => loadConfig({ ...requiredEnvironment,
      CONTROLLER_BOOTSTRAP_ADMIN_EMAIL: "admin@example.test",
    })).toThrow(/Bootstrap email/);
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
