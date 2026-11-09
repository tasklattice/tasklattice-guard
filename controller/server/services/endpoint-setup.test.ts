import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";

import { loadConfig } from "../config.js";
import type { ControllerDatabase } from "../db/client.js";
import { ControlPlaneService, endpointSetup } from "./control-plane.js";

it("provides the Endpoint-scoped Scan URL and Bearer examples while preserving the deployment prefix", () => {
  const endpointId = "11111111-1111-4111-8111-111111111111";
  const setup = endpointSetup("https://runtime.example.test/base/", endpointId, "f5-scan");
  expect(setup.api_base_url).toBe(`https://runtime.example.test/base/runtime/v1/endpoints/${endpointId}`);
  expect(setup.callback_url).toBe(`${setup.api_base_url}/backend/v1/scans`);
  expect(setup.auth_header).toBe("Authorization: Bearer");
  expect(setup.stream_callback_url).toBeNull();
  // Parse the copied command in a real shell, capturing arguments without sending traffic.
  const args = execFileSync("sh", ["-c", `curl() { printf '%s\\0' "$@"; }\n${setup.yaml_template}`], { encoding: "utf8" }).split("\0");
  expect(args).toContain(setup.callback_url);
  expect(args).toContain("Authorization: Bearer <CALYPSOAI_TOKEN>");
  expect(args).toContain("Content-Type: application/json");
  expect(JSON.parse(args[args.indexOf("--data") + 1]!)).toEqual({
    input: "Hello, can you help me?", scanDirection: "request", verbose: false,
  });
});

describe("Endpoint setup", () => {
  describe.each(["f5-scan", "litellm-generic-guardrail"])("%s advertised address", (adapter) => {
    it.each([undefined, "", "https://guard.example.test:8443/", "https://guard.example.test:8443/guard/"])(
      "uses the configured runtime public URL or falls back to the Controller origin: %j",
      async (publicUrl) => {
        const config = loadConfig({
          NODE_ENV: "test",
          CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller",
          CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
          CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
          BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
          CONTROLLER_PUBLIC_URL: "https://ui.example.test:8443/console",
          CONTROLLER_RUNTIME_SERVICE_URL: "http://guard-runtime.uat.svc.cluster.local:8091",
          CONTROLLER_RUNTIME_PUBLIC_URL: publicUrl,
        });
        const endpointId = "11111111-1111-4111-8111-111111111111";
        const row = { id: endpointId, adapter, verification: { credentials: [] } };
        const query = {
          from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(),
          then: (resolve: (rows: unknown[]) => void) => resolve([row]),
        };
        const db = { select: () => query } as unknown as ControllerDatabase;
        const service = new ControlPlaneService(db, config);
        const detail = await service.getEndpoint(endpointId);
        expect((await service.listEndpoints())[0]!.setup).toEqual(detail.setup);
        const advertisedBase = (publicUrl || "https://ui.example.test:8443").replace(/\/+$/, "");
        expect(detail.setup.api_base_url).toBe(`${advertisedBase}/runtime/v1/endpoints/${endpointId}`);
        expect(detail.setup.callback_url).toBe(`${detail.setup.api_base_url}${adapter === "f5-scan" ? "/backend/v1/scans" : "/beta/litellm_basic_guardrail_api"}`);
        if (adapter === "f5-scan") expect(detail.setup.yaml_template).toContain(detail.setup.callback_url);
      },
    );
  });

  it("uses LiteLLM's Basic Guardrail API callback for the LiteLLM adapter", () => {
    const setup = endpointSetup(
      "http://tali-guard-runtime.tali.svc.cluster.local:8091",
      "endpoint-1",
      "litellm-generic-guardrail",
    );

    expect(setup.api_base_url).toBe(
      "http://tali-guard-runtime.tali.svc.cluster.local:8091/runtime/v1/endpoints/endpoint-1",
    );
    expect(setup.callback_url).toBe(
      `${setup.api_base_url}/beta/litellm_basic_guardrail_api`,
    );
    expect(setup.yaml_template).toContain("guardrail: tasklattice_guard");
    expect(setup.yaml_template).toContain("api_base: os.environ/TASKLATTICE_GUARD_API_BASE");
    expect(setup.yaml_template).not.toContain("callback_url:");
    expect(setup.yaml_template).not.toContain("litellm_settings:");
    expect(setup.yaml_template).toContain("\ncredential_list:\n  - credential_name: tasklattice-guard\n    credential_info:\n      custom_llm_provider: tasklattice_guard\n    credential_values:\n      api_key: os.environ/TASKLATTICE_GUARD_API_KEY\n");
    expect(setup.yaml_template).toContain("\nguardrails:\n");
    expect(setup.yaml_template).toContain("      credential_name: tasklattice-guard\n");
    expect(setup.yaml_template).toContain("      mode: [pre_call, post_call]\n");
    expect(setup.yaml_template).toContain("      unreachable_fallback: fail_closed\n");
  });

  it("rejects unsupported adapters instead of producing an implicit callback", () => {
    expect(() => endpointSetup("https://runtime.example.test", "ep", "unknown")).toThrow("Unsupported Endpoint adapter");
  });
});
