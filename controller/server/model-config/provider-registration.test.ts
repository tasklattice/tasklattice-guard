import { describe, expect, it, vi } from "vitest";
import type { ControllerDatabase } from "../db/client.js";
import { auditEvents, modelDefinitions, modelProviders } from "../db/schema.js";
import { decryptModelCredential } from "./secret-crypto.js";
import { ModelConfigurationService } from "./service.js";
import { providerRegistrationSchema } from "./domain.js";
import { runWithTenantContext } from "../services/tenant-context.js";

const connection = { name: "Test NVIDIA", kind: "custom-openai-compatible", baseUrl: "https://provider.test/v1/", apiKey: "test-registration-credential" };
const model = (id: string) => ({ name: id, model: id, profile: "generic-chat", timeoutSeconds: 20, maxTokens: 128 });
const secret = "test-root-secret";

function setup(failCatalog = false) {
  const rows = new Map<unknown, Array<Record<string, unknown>>>();
  const tx = { insert: vi.fn((table: unknown) => ({
    values: (values: Record<string, unknown> | Array<Record<string, unknown>>) => {
      const added = Array.isArray(values) ? values : [values];
      rows.set(table, [...(rows.get(table) ?? []), ...added]);
      return { returning: async () => added };
    },
  })) };
  const db = {
    ...tx,
    select: () => ({ from: (table: unknown) => ({ where: async () => rows.get(table) ?? [], orderBy: async () => rows.get(table) ?? [] }) }),
    transaction: vi.fn(async (run: (value: typeof tx) => unknown) => run(tx)),
  };
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/models")) return failCatalog ? new Response("Unavailable", { status: 503 }) : new Response(JSON.stringify({ data: [
      { id: "chat" }, { id: "bad" }, { id: "chat" }, { id: "nvidia/nvidia-nemotron-nano-9b-v2" },
    ] }), { status: 200 });
    const requested = JSON.parse(String(init?.body)) as { model: string };
    return requested.model === "bad" ? new Response("Unavailable", { status: 503 })
      : new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 });
  });
  return { rows, db, fetcher, service: new ModelConfigurationService(db as unknown as ControllerDatabase, secret, "", fetcher as typeof fetch) };
}

describe("Relay-style Provider registration", () => {
  it("returns Provider selection metadata without credentials or credential hints to tenant users", async () => {
    const { service, rows } = setup();
    await service.registerProviderModels({ connection, models: [model("chat")] }, "admin");
    const metadata = await runWithTenantContext({ tenantId: "tenantB", role: "user" }, () => service.listProviders());
    expect(metadata).toHaveLength(1);
    expect(metadata[0]).toMatchObject({ name: connection.name, kind: connection.kind, status: "validated" });
    for (const field of ["credentialCiphertext", "credentialHint", "credentialConfigured", "validationMessage", "createdBy"]) {
      expect(metadata[0]).not.toHaveProperty(field);
    }
    expect(JSON.stringify(metadata)).not.toContain(connection.apiKey);
    expect(rows.get(modelProviders)?.[0]).not.toHaveProperty("tenantId");
    const platform = await service.listProviders();
    expect(platform[0]).toHaveProperty("credentialConfigured", true);
  });

  it("includes NVIDIA's dedicated security endpoint as a candidate without claiming a successful call", async () => {
    const { service, db, fetcher } = setup();
    const result = await service.discoverProviderDraft({ ...connection, baseUrl: "https://integrate.api.nvidia.com/v1" });
    expect(result.models).toContainEqual({ id: "nvidia/nemoguard-jailbreak-detect", name: "nvidia/nemoguard-jailbreak-detect" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("registers a dedicated self-hosted classifier without a /models or chat endpoint", async () => {
    const { service, fetcher } = setup();
    fetcher.mockImplementation(async () => Response.json({ jailbreak: false, score: 0.01 }));
    const dedicated = { ...connection, baseUrl: "https://classifier.test/v1/classify", skipTlsVerify: true };
    const discovery = await service.discoverProviderDraft(dedicated);
    expect(discovery.models[0]?.id).toBe("nvidia/nemoguard-jailbreak-detect");
    const result = await service.registerProviderModels({ connection: dedicated, models: [{ ...model("nvidia/nemoguard-jailbreak-detect"), profile: "tali.nemoguard-jailbreak-detect.v1" }] }, "admin");
    expect(result.provider.status).toBe("validated");
    expect(result.models[0]).toMatchObject({ connectionStatus: "validated", status: "pending", validatedAt: null });
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).toBe(dedicated.baseUrl);
      expect(init).toMatchObject({ headers: { authorization: `Bearer ${connection.apiKey}` }, dispatcher: expect.anything() });
      expect(Object.keys(JSON.parse(String(init?.body)))).toEqual(["input"]);
    }
  });

  it.each([false, true])("persists the explicit TLS setting and reuses it for saved discovery (skip=%s)", async (skipTlsVerify) => {
    const { service, fetcher } = setup();
    const result = await service.registerProviderModels({ connection: { ...connection, skipTlsVerify }, models: [model("chat")] }, "admin");
    expect(result.provider.skipTlsVerify).toBe(skipTlsVerify);
    await service.discoverProviderModels(result.provider.id);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, init] of fetcher.mock.calls) expect(Boolean(init && "dispatcher" in init)).toBe(skipTlsVerify);
  });

  it("does not persist skip TLS for a plain HTTP endpoint", async () => {
    const { service } = setup();
    const result = await service.registerProviderModels({ connection: { ...connection, baseUrl: "http://internal.test/v1", skipTlsVerify: true }, models: [model("chat")] }, "admin");
    expect(result.provider.skipTlsVerify).toBe(false);
  });

  it("discovers with draft credentials without saving or returning them", async () => {
    const { service, db, fetcher } = setup();
    const result = await service.discoverProviderDraft(connection);
    expect(result).toEqual({ providerName: connection.name, models: [{ id: "bad", name: "bad" }, { id: "chat", name: "chat" }] });
    expect(fetcher.mock.calls[0]).toMatchObject(["https://provider.test/v1/models", { headers: { authorization: `Bearer ${connection.apiKey}` } }]);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(connection.apiKey);
  });

  it("checks every selected model with an actual call without validating any capability", async () => {
    const { service, db, rows, fetcher } = setup();
    const result = await service.registerProviderModels({ connection, models: [model("chat"), model("bad")] }, "admin");
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(result.models.map((item) => item.model)).toEqual(["chat", "bad"]);
    expect(result.models.every((item) => item.tenantId === null)).toBe(true);
    expect(result.models.every((item) => item.status === "pending" && item.validatedAt === null)).toBe(true);
    expect(result.failures).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.models.map((item) => item.connectionStatus)).toEqual(["validated", "failed"]);
    expect(result.models.every((item) => item.connectionCheckedAt instanceof Date)).toBe(true);
    expect(result.models[1]?.connectionMessage).toContain("HTTP 503");
    expect(fetcher.mock.calls.every(([url]) => String(url).endsWith("/chat/completions"))).toBe(true);
    expect(result.provider).toMatchObject({ status: "validated", validationMessage: expect.stringContaining("actual call to chat") });
    expect(rows.get(modelProviders)).toHaveLength(1);
    expect(rows.get(modelDefinitions)).toHaveLength(2);
    expect(rows.get(auditEvents)).toHaveLength(1);
    const encrypted = rows.get(modelProviders)![0]!.credentialCiphertext as string;
    expect(encrypted).not.toContain(connection.apiKey);
    expect(decryptModelCredential(encrypted, secret)).toBe(connection.apiKey);
    expect(JSON.stringify(result)).not.toContain(connection.apiKey);
    expect(result.provider).not.toHaveProperty("credentialCiphertext");
  });

  it.each(["tenantA", "tenantB"])("prevents tenant %s users from changing or discovering global Providers", async (tenantId) => {
    const { service, rows, fetcher } = setup();
    const operations = [
      () => service.createProvider(connection, "group_b"),
      () => service.updateProvider("provider-1", { name: "Modified" }, "group_b"),
      () => service.revalidateProvider("provider-1", "group_b"),
      () => service.discoverProviderModels("provider-1"),
      () => service.discoverProviderDraft(connection),
      () => service.registerProviderModels({ connection, models: [model("chat")] }, "group_b"),
      () => service.deleteProvider("provider-1", "group_b"),
    ];
    for (const operation of operations) {
      await expect(runWithTenantContext({ tenantId, actorId: "group_b", role: "user" }, operation))
        .rejects.toMatchObject({ code: "forbidden" });
    }
    expect(rows.get(modelProviders)).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("can prove a manual model is callable even when the Provider catalog is unavailable", async () => {
    const { service, db, fetcher } = setup(true);
    const result = await service.registerProviderModels({ connection, models: [model("example/jailbreak-judge")] }, "admin");
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(result.provider.status).toBe("validated");
    expect(result.models[0]).toMatchObject({ model: "example/jailbreak-judge", status: "pending", validatedAt: null, connectionStatus: "validated" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("registers a pinned Jev version directly through System One without fetching the catalog", async () => {
    const { service, fetcher } = setup();
    fetcher.mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return Response.json({ model: "jev-1.13.0", answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul", noul: 0.99 }])) });
    });
    const result = await service.registerProviderModels({
      connection: { ...connection, kind: "typesafe", baseUrl: "https://api.typesafe.ai/v1" },
      models: [{ ...model("jev-1.13.0"), profile: "tali.typesafe-jev-topic.v1" }],
    }, "admin");
    expect(result.models[0]).toMatchObject({ model: "jev-1.13.0", connectionStatus: "validated", status: "pending" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.typesafe.ai/v1/systemone");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ model: "jev-1.13.0", questions: expect.any(Object) });
  });

  it("does not report a Provider as healthy when its public catalog works but an actual Model call rejects the credential", async () => {
    const { service, fetcher } = setup();
    fetcher.mockImplementation(async (url) => String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "chat" }] })
      : new Response(JSON.stringify({ status: 401, title: "Unauthorized", detail: "Authentication failed" }), { status: 401 }));

    await expect(service.discoverProviderDraft(connection)).resolves.toMatchObject({ models: [{ id: "chat" }] });
    const result = await service.registerProviderModels({ connection, models: [model("chat")] }, "admin");

    expect(result.provider.status).toBe("failed");
    expect(result.provider.validationMessage).toContain("HTTP 401");
    expect(result.models[0]).toMatchObject({ connectionStatus: "failed", connectionMessage: expect.stringContaining("HTTP 401") });
  });

  it("registers a model on a saved Provider without discovery or capability validation", async () => {
    const { service, rows, fetcher } = setup();
    const providerId = "fe3671e8-a707-4d9b-a6a4-ea804ae76ec4";
    rows.set(modelProviders, [{ id: providerId, name: "Saved provider", kind: "custom-openai-compatible", baseUrl: connection.baseUrl, credentialCiphertext: "", skipTlsVerify: false }]);
    const result = await service.createModel({ providerId, ...model("bad") }, "admin");
    expect(result).toMatchObject({ tenantId: null, model: "bad", status: "pending", validatedAt: null, validationLatencyMs: null });
    expect(result.connectionStatus).toBe("failed");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("/chat/completions");
    expect(rows.get(modelDefinitions)).toHaveLength(1);
  });

  it("creates tenant-owned Models on a global platform Provider", async () => {
    const { service, rows } = setup();
    const providerId = "a2b3c4d5-1111-4444-8888-123456789012";
    rows.set(modelProviders, [{ id: providerId, name: "Platform provider", kind: "custom-openai-compatible", baseUrl: connection.baseUrl, credentialCiphertext: "", skipTlsVerify: false }]);
    const created = await runWithTenantContext({ tenantId: "tenantB", actorId: "group_b", role: "user" }, () =>
      service.createModel({ ...model("chat"), providerId }, "group_b"));
    expect(created).toMatchObject({ tenantId: "tenantB", providerId, model: "chat", connectionStatus: "validated" });
    expect(rows.get(modelProviders)?.[0]).not.toHaveProperty("tenantId");
    expect(rows.get(modelDefinitions)?.[0]?.tenantId).toBe("tenantB");
  });

  it("rejects empty and duplicate selections before making external requests", async () => {
    const { service, fetcher } = setup();
    await expect(service.registerProviderModels({ connection, models: [] }, "admin")).rejects.toThrow();
    await expect(service.registerProviderModels({ connection, models: [model("chat"), model("chat")] }, "admin")).rejects.toThrow("Select each Model only once");
    expect(fetcher).not.toHaveBeenCalled();
    expect(providerRegistrationSchema.safeParse({ connection, models: Array.from({ length: 51 }, (_, i) => model(`model-${i}`)) }).success).toBe(false);
    expect(providerRegistrationSchema.safeParse({ connection, models: [model("nvidia/nvidia-nemotron-nano-9b-v2")] }).success).toBe(false);
  });

  it.each(["tali.qwen3guard.v1", "tali.openai-compatible-jailbreak.v1", "tali.nemoguard-topic-control.v1"])("does not demand capability-specific output when checking %s callability", async (profile) => {
    const { service } = setup();
    const result = await service.registerProviderModels({ connection, models: [{ ...model("guard"), profile }] }, "admin");
    // The mock returns 'OK', which is callable but not a valid detector label.
    expect(result.models[0]).toMatchObject({ connectionStatus: "validated", status: "pending", validatedAt: null });
  });

  it("bounds batch call concurrency and preserves the user's model order", async () => {
    const { service, fetcher } = setup();
    let inFlight = 0;
    let maximum = 0;
    fetcher.mockImplementation(async (url) => {
      if (String(url).endsWith("/models")) return Response.json({ data: [] });
      maximum = Math.max(maximum, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return Response.json({ choices: [{ message: { content: "OK" } }] });
    });
    const models = Array.from({ length: 10 }, (_, index) => model(`model-${index}`));
    const result = await service.registerProviderModels({ connection, models }, "admin");
    expect(maximum).toBe(4);
    expect(result.models.map((item) => item.model)).toEqual(models.map((item) => item.model));
  });
});
