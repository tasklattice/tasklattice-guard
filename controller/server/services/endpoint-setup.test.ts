import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

import { endpointSetup } from "./control-plane.js";

it("provides the root Scan URL and Bearer examples without a streaming callback", () => {
  const setup = endpointSetup("https://runtime.example.test/base/", "ep", "f5-scan");
  expect(setup.callback_url).toBe("https://runtime.example.test/backend/v1/scans");
  expect(setup.api_base_url).toBe("https://runtime.example.test");
  expect(setup.auth_header).toBe("Authorization: Bearer");
  expect(setup.stream_callback_url).toBeNull();
  // Parse the copied command in a real shell, capturing arguments without sending traffic.
  const args = execFileSync("sh", ["-c", `curl() { printf '%s\\0' "$@"; }\n${setup.yaml_template}`], { encoding: "utf8" }).split("\0");
  expect(args).toContain(setup.callback_url);
  expect(args).toContain("Authorization: Bearer <CALYPSOAI_TOKEN>");
  expect(args).toContain("Content-Type: application/json");
  expect(JSON.parse(args[args.indexOf("--data") + 1]!)).toEqual({
    input: "Hello, can you help me?", scanDirection: "request", flagOnly: true, verbose: false,
  });
});

describe("Endpoint setup", () => {
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
