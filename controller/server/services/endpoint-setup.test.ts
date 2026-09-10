import { describe, expect, it } from "vitest";

import { endpointSetup } from "./control-plane.js";

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

  it("keeps the generic HTTP callback for non-LiteLLM adapters", () => {
    const setup = endpointSetup("https://runtime.example.test", "endpoint-1", "generic-http-guard");

    expect(setup.callback_url).toBe(`${setup.api_base_url}/guardrails/evaluate`);
  });
});
