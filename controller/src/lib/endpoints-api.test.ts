import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanRequestCommand } from "../../shared/scan-request-command";
import { createEndpoint, getEndpoint, getEndpoints, setEndpointCredentialRequired } from "./endpoints-api";

const api = vi.hoisted(() => ({
  requestController: vi.fn(), listControllerEndpoints: vi.fn(), createControllerEndpoint: vi.fn(),
}));
vi.mock("./controller-api", () => api);

describe("Endpoint connection scheme", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["https:", "http:"], ["http:", "https:"], ["https:", "https:"], ["http:", "http:"],
  ])("uses the page's %s scheme when the Controller advertises %s", async (pageProtocol, advertisedProtocol) => {
    vi.stubGlobal("window", { location: new URL(`${pageProtocol}//console.example.test/integration/endpoints`) });
    const apiBase = `${advertisedProtocol}//runtime.example.test:8443/guard/runtime/v1/endpoints/endpoint-1`;
    const callback = `${apiBase}/backend/v1/scans?source=console`;
    const resource = {
      id: "endpoint-1", name: "Scan", adapter: "f5-scan", status: "active", credentialRequired: false,
      createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z", credentials: [],
      setup: { api_base_url: apiBase, callback_url: callback, stream_callback_url: null,
        auth_header: "", credential_env_var: "", api_base_env_var: "CALYPSOAI_URL",
        recommended_modes: ["request", "response"], default_on: true, fail_on_error: true,
        unreachable_fallback: "fail_closed", yaml_template: scanRequestCommand(callback, false) },
    };
    api.requestController.mockImplementation(async (path: string) => path.endsWith("endpoint-activity") ? { items: [] } : resource);
    api.listControllerEndpoints.mockResolvedValue({ items: [resource] });
    api.createControllerEndpoint.mockResolvedValue({ ...resource, credential: "tg_test_only" });

    // All paths feeding Connection, including the onboarding dialog, use the same URL.
    const endpoints = [
      await getEndpoint(resource.id), (await getEndpoints()).items[0]!,
      await setEndpointCredentialRequired(resource.id, false),
      (await createEndpoint({ name: "Scan", adapter_id: "f5-scan", credential_required: false })).endpoint,
    ];
    for (const endpoint of endpoints) {
      const expectedBase = `${pageProtocol}//runtime.example.test:8443/guard/runtime/v1/endpoints/endpoint-1`;
      expect(endpoint.setup.api_base_url).toBe(expectedBase);
      expect(endpoint.setup.callback_url).toBe(`${expectedBase}/backend/v1/scans?source=console`);
      expect(endpoint.setup.yaml_template).toBe(scanRequestCommand(endpoint.setup.callback_url, false));
      expect(endpoint.setup.stream_callback_url).toBeNull();
      expect(endpoint.setup.auth_header).toBe("");
    }
    expect(resource.setup.callback_url).toBe(callback);
  });

  it.each(["https:", "http:"])("keeps LiteLLM and WebSocket connection examples consistent with %s", async pageProtocol => {
    vi.stubGlobal("window", { location: new URL(`${pageProtocol}//console.example.test/integration/endpoints`) });
    const base = "http://runtime.example.test:8091/prefix/runtime/v1/endpoints/litellm";
    const stream = "ws://runtime.example.test:8091/prefix/runtime/v1/endpoints/litellm/guardrails/output-stream";
    api.requestController.mockImplementation(async (path: string) => path.endsWith("endpoint-activity") ? { items: [] } : {
      id: "litellm", adapter: "litellm-generic-guardrail", credentialRequired: true, status: "active",
      setup: { api_base_url: base, callback_url: `${base}/beta/litellm_basic_guardrail_api`, stream_callback_url: stream,
        auth_header: "x-api-key", yaml_template: `api_base: ${base}\nstream: ${stream}\nmodel_url: https://model.example.test/v1` },
    });
    const endpoint = await getEndpoint("litellm");
    const expectedBase = `${pageProtocol}//runtime.example.test:8091/prefix/runtime/v1/endpoints/litellm`;
    const expectedStream = `${pageProtocol === "https:" ? "wss:" : "ws:"}//runtime.example.test:8091/prefix/runtime/v1/endpoints/litellm/guardrails/output-stream`;
    expect(endpoint.setup.api_base_url).toBe(expectedBase);
    expect(endpoint.setup.callback_url).toBe(`${expectedBase}/beta/litellm_basic_guardrail_api`);
    expect(endpoint.setup.stream_callback_url).toBe(expectedStream);
    expect(endpoint.setup.yaml_template).toBe(`api_base: ${expectedBase}\nstream: ${expectedStream}\nmodel_url: https://model.example.test/v1`);
    expect(endpoint.setup.auth_header).toBe("x-api-key");
  });
});
