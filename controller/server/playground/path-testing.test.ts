import { describe, it, expect, vi } from "vitest";
import { RunnerPlaygroundClient } from "./service";
import { pathTestSchema } from "../../shared/playground-path";
import { loadConfig } from "../config";
const base = {
  target: "router",
  targetId: "router-1",
  endpointId: "endpoint-1",
  expectedRevision: 3,
  callId: "call-1",
  request: "POST /chat HTTP/1.1\nX-Channel: partner\n\nhello",
};
describe("Runner path test transport", () => {
  it("sends tenant-group path tests to the selected pool without changing their credentials", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({}));
    const root = new RunnerPlaygroundClient({ baseUrl: "http://default:8091", token: "internal", fetcher });
    await root.forBaseUrl("http://group-b:8091").testPath(pathTestSchema.parse({ ...base, target: "endpoint", targetId: "endpoint-1", credential: "group-b-key",
      request: 'POST /runtime/v1/endpoints/endpoint-1/beta/litellm_basic_guardrail_api HTTP/1.1\n\n{"texts":["hello"]}' }), "litellm-generic-guardrail");
    expect(fetcher.mock.calls[0]![0]).toBe("http://group-b:8091/runtime/v1/endpoints/endpoint-1/beta/litellm_basic_guardrail_api");
    expect(fetcher.mock.calls[0]![1].headers["x-api-key"]).toBe("group-b-key");
  });
  it.each(["f5-scan", "litellm-generic-guardrail"] as const)("keeps %s Playground traffic on Service DNS when an external address is advertised", async (adapter) => {
    const config = loadConfig({
      NODE_ENV: "test",
      CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller",
      CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
      CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
      BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
      CONTROLLER_RUNTIME_SERVICE_URL: "http://guard-runtime.uat.svc.cluster.local:8091",
      CONTROLLER_RUNTIME_PUBLIC_URL: "https://guard.example.test:8443",
    });
    const fetcher = vi.fn().mockResolvedValue(Response.json({}));
    const client = new RunnerPlaygroundClient({ baseUrl: config.runtimeServiceUrl, token: config.runnerToken, fetcher });
    const path = `/runtime/v1/endpoints/endpoint-1/${adapter === "f5-scan" ? "backend/v1/scans" : "beta/litellm_basic_guardrail_api"}`;
    await client.testPath(pathTestSchema.parse({ ...base, target: "endpoint", targetId: "endpoint-1", credential: "endpoint-key",
      request: `POST ${config.runtimePublicUrl}${path} HTTP/1.1\n\n{"input":"hello","texts":["hello"]}`,
    }), adapter);
    expect(fetcher.mock.calls[0]![0]).toBe(`${config.runtimeServiceUrl}${path}`);
  });
  it("uses the selected Scan Endpoint's path and Bearer credential only for an approved Scan target", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ result: { outcome: "cleared" }, redactedInput: "hello" }));
    const client = new RunnerPlaygroundClient({ baseUrl: "http://runner:8091", token: "internal", fetcher });
    const input = pathTestSchema.parse({ ...base, target: "endpoint", targetId: "endpoint-1", credential: "scan-key",
      request: 'POST /runtime/v1/endpoints/endpoint-1/backend/v1/scans HTTP/1.1\nAuthorization: attacker\n\n{"input":"hello"}' });
    await expect(client.testPath(input)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    const result = await client.testPath(input, "f5-scan");
    expect(fetcher.mock.calls[0]![0]).toBe("http://runner:8091/runtime/v1/endpoints/endpoint-1/backend/v1/scans");
    expect(fetcher.mock.calls[0]![1].headers).toEqual({ authorization: "Bearer scan-key", "content-type": "application/json" });
    expect(result.body.result).toEqual({ outcome: "cleared" });
  });
  it.each(["/backend/v1/scans", "/runtime/v1/endpoints/other/backend/v1/scans"])("rejects Scan requests outside the selected Endpoint: %s", async (path) => {
    const fetcher = vi.fn();
    const client = new RunnerPlaygroundClient({ baseUrl: "http://runner:8091", token: "internal", fetcher });
    const input = pathTestSchema.parse({ ...base, target: "endpoint", targetId: "endpoint-1", credential: "scan-key",
      request: `POST ${path} HTTP/1.1\n\n{"input":"hello"}` });
    await expect(client.testPath(input, "f5-scan")).rejects.toThrow("selected Endpoint");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("runs published routing on Runner with a revision fence and no client credentials in selector inputs", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json({ runnerId: "r1", assignment: { guardrailId: "g1" } }),
      );
    const client = new RunnerPlaygroundClient({
      baseUrl: "http://runner:8091",
      token: "internal",
      fetcher,
    });
    const result = await client.testPath(pathTestSchema.parse(base));
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(
      "http://runner:8091/internal/v1/playground/routers/router-1/test",
    );
    expect(JSON.parse(init.body)).toMatchObject({
      revision: 3,
      text: "hello",
      endpoint_id: "endpoint-1",
      business_request: { "x-channel": ["partner"] },
    });
    expect(init.headers.authorization).toBe("Bearer internal");
    expect(result.body.runnerId).toBe("r1");
  });
  it("uses Endpoint credentials and preserves real authentication failures", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { detail: "Endpoint credential is invalid." },
          { status: 401 },
        ),
      );
    const client = new RunnerPlaygroundClient({
      baseUrl: "http://runner:8091",
      token: "internal",
      fetcher,
    });
    const result = await client.testPath(
      pathTestSchema.parse({
        ...base,
        target: "endpoint",
        targetId: "endpoint-1",
        action: "execute",
        credential: "user-key",
        request:
          'POST https://untrusted.example/runtime/v1/endpoints/endpoint-1/beta/litellm_basic_guardrail_api HTTP/1.1\nAuthorization: attacker\n\n{"texts":["hello"]}',
      }), "litellm-generic-guardrail",
    );
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(
      "http://runner:8091/runtime/v1/endpoints/endpoint-1/beta/litellm_basic_guardrail_api",
    );
    expect(init.headers["x-api-key"]).toBe("user-key");
    expect(init.headers).not.toHaveProperty("authorization");
    expect(init.redirect).toBe("error");
    expect(result.status).toBe(401);
  });
  it.each([
    "/internal/v1/guardrails/g/evaluate",
    "/runtime/v1/endpoints/other/beta/litellm_basic_guardrail_api",
    "//evil.test/",
  ])("rejects paths outside the selected Endpoint: %s", async (path) => {
    const fetcher = vi.fn();
    const client = new RunnerPlaygroundClient({
      baseUrl: "http://runner",
      token: "internal",
      fetcher,
    });
    await expect(
      client.testPath(
        pathTestSchema.parse({
          ...base,
          target: "endpoint",
          request: `POST ${path} HTTP/1.1\n\n{}`,
        }),
      ),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
