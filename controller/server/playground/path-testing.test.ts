import { describe, it, expect, vi } from "vitest";
import { RunnerPlaygroundClient } from "./service";
import { pathTestSchema } from "../../shared/playground-path";
const base = {
  target: "router",
  targetId: "router-1",
  endpointId: "endpoint-1",
  expectedRevision: 3,
  callId: "call-1",
  request: "POST /chat HTTP/1.1\nX-Channel: partner\n\nhello",
};
describe("Runner path test transport", () => {
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
          'POST https://untrusted.example/runtime/v1/endpoints/endpoint-1/guardrails/evaluate HTTP/1.1\nAuthorization: attacker\n\n{"texts":["hello"]}',
      }),
    );
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(
      "http://runner:8091/runtime/v1/endpoints/endpoint-1/guardrails/evaluate",
    );
    expect(init.headers["x-api-key"]).toBe("user-key");
    expect(init.headers).not.toHaveProperty("authorization");
    expect(init.redirect).toBe("error");
    expect(result.status).toBe(401);
  });
  it.each([
    "/internal/v1/guardrails/g/evaluate",
    "/runtime/v1/endpoints/other/guardrails/evaluate",
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
