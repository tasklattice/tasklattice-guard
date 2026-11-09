import { describe, expect, it, vi } from "vitest";
import type { ControllerDatabase } from "../db/client.js";
import { auditEvents, controllerState, modelDefinitions, modelProviders, outboxEvents } from "../db/schema.js";
import { decryptModelCredential } from "./secret-crypto.js";
import { ModelConfigurationService } from "./service.js";
import { providerRegistrationSchema } from "./domain.js";
import { runWithProjectContext } from "../services/project-context.js";

const connection = { name: "Test NVIDIA", kind: "custom-openai-compatible", baseUrl: "https://provider.test/v1/", apiKey: "test-registration-credential" };
const model = (id: string) => ({ name: id, model: id, profile: "generic-chat", timeoutSeconds: 20, maxTokens: 128 });
const secret = "test-root-secret";

function setup(failCatalog = false) {
  const rows = new Map<unknown, Array<Record<string, unknown>>>();
  rows.set(controllerState, [{ id: "singleton", desiredGeneration: 0 }]);
  const query = (table: unknown) => {
    const result = rows.get(table) ?? [];
    return Object.assign(Promise.resolve(result), {
      where: () => query(table), orderBy: () => query(table), limit: () => Promise.resolve(result),
    });
  };
  const select = () => ({ from: query });
  const tx = {
    select,
    execute: vi.fn(async () => {}),
    update: vi.fn((table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({ where: () => {
        // The service increments the singleton through a SQL expression; emulate
        // that increment instead of copying the raw patch value.
        const updated = table === controllerState
          ? [{ ...(rows.get(controllerState)?.[0] ?? { id: "singleton" }),
            desiredGeneration: Number(rows.get(controllerState)?.[0]?.desiredGeneration ?? 0) + 1, updatedAt: patch.updatedAt }]
          : (rows.get(table) ?? []).map((row) => ({ ...row, ...patch }));
        rows.set(table, updated);
        return Object.assign(Promise.resolve(updated), { returning: async () => updated });
      } }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: (values: Record<string, unknown> | Array<Record<string, unknown>>) => {
        const added = Array.isArray(values) ? values : [values];
        rows.set(table, [...(rows.get(table) ?? []), ...added]);
        return { returning: async () => added };
      },
    })),
  };
  const db = {
    ...tx,
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

/** Desired-state generation plus the outbox events that asked Runners to reload. */
function desiredState(rows: Map<unknown, Array<Record<string, unknown>>>) {
  return {
    generation: Number(rows.get(controllerState)?.[0]?.desiredGeneration ?? 0),
    events: rows.get(outboxEvents) ?? [],
  };
}

describe("Relay-style Provider registration", () => {
  it("returns Provider selection metadata without credentials or credential hints to project users", async () => {
    const { service, rows } = setup();
    await service.registerProviderModels({ connection, models: [model("chat")] }, "admin");
    const metadata = await runWithProjectContext({ projectId: "projectB", role: "user" }, () => service.listProviders());
    expect(metadata).toHaveLength(1);
    expect(metadata[0]).toMatchObject({ name: connection.name, kind: connection.kind, status: "validated" });
    for (const field of ["credentialCiphertext", "credentialHint", "credentialConfigured", "validationMessage", "createdBy"]) {
      expect(metadata[0]).not.toHaveProperty(field);
    }
    expect(JSON.stringify(metadata)).not.toContain(connection.apiKey);
    expect(rows.get(modelProviders)?.[0]).not.toHaveProperty("projectId");
    const platform = await service.listProviders();
    expect(platform[0]).toHaveProperty("credentialConfigured", true);
  });

  it.each(["tali.laya.v1", "tali.laya-topic.v1"] as const)("registers Laya through its own System One profile %s and stores the native request mode", async profile => {
    const { service, fetcher } = setup();
    fetcher.mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return Response.json({ model: "laya", answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, { type: "noul", noul: 0.99 }])) });
    });
    const result = await service.registerProviderModels({
      connection: { ...connection, kind: "laya", baseUrl: "https://laya.test/v1" },
      models: [{ ...model("laya"), profile }],
    }, "admin");
    expect(result.provider.kind).toBe("laya");
    expect(result.models[0]).toMatchObject({ model: "laya", profile, connectionStatus: "validated", status: "pending", layaRequestMode: "native" });
    expect(result.models[0]?.connectionMessage).toContain("native");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://laya.test/v1/systemone");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ model: "laya", state: "Hello", questions: {
      greeting: { type: "noul", instructions: "Does the text contain a greeting?" },
    }, max_len: 1024, head_max_len: 512 });
  });

  it("discovers the independent Laya catalog without probing or persisting models", async () => {
    const { service, fetcher, db } = setup();
    fetcher.mockResolvedValueOnce(Response.json({ models: [{ name: "laya" }, { name: "laya-preview" }] }));
    const result = await service.discoverProviderDraft({ ...connection, kind: "laya", baseUrl: "https://laya.test/v1" });
    expect(result.models).toEqual([{ id: "laya", name: "laya" }, { id: "laya-preview", name: "laya-preview" }]);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://laya.test/v1/models");
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it.each(["tali.laya.v1", "tali.laya-topic.v1"] as const)("preserves Laya's rejected field for %s without echoing input or credentials", async profile => {
    const { service, fetcher } = setup();
    const privateInput = "private-upstream-input";
    fetcher.mockResolvedValue(Response.json({ detail: [{
      type: "dict_type", loc: ["body", "questions", "greeting", "instructions"],
      msg: "Input should be a valid dictionary", input: privateInput,
      ctx: { authorization: connection.apiKey },
    }] }, { status: 422 }));
    const result = await service.registerProviderModels({
      connection: { ...connection, kind: "laya" }, models: [{ ...model("auto"), profile }],
    }, "admin");
    expect(result.models[0]).toMatchObject({ connectionStatus: "failed", status: "pending", validatedAt: null });
    expect(result.models[0]?.connectionMessage).toContain("HTTP 422");
    expect(result.models[0]?.connectionMessage).toContain("body.questions.greeting.instructions");
    expect(result.models[0]?.connectionMessage).toContain("Input should be a valid dictionary");
    expect(JSON.stringify(result)).not.toContain(privateInput);
    expect(JSON.stringify(result)).not.toContain(connection.apiKey);
    expect(result.provider.status).toBe("failed");
  });

  it.each([true, false])("preserves Laya error text and redacts the submitted credential (JSON=%s)", async json => {
    const { service, fetcher } = setup();
    const message = `max_len exceeds server limit (1024 > 512); credential=${connection.apiKey}`;
    fetcher.mockResolvedValue(json ? Response.json({ detail: message }, { status: 422 }) : new Response(message, { status: 422 }));
    const result = await service.registerProviderModels({
      connection: { ...connection, kind: "laya" }, models: [{ ...model("auto"), profile: "tali.laya.v1" }],
    }, "admin");
    expect(result.models[0]?.connectionMessage).toContain("max_len exceeds server limit (1024 > 512)");
    expect(JSON.stringify(result)).not.toContain(connection.apiKey);
  });

  it.each(["tali.laya.v1", "tali.laya-topic.v1"] as const)("registers auto against a strict Laya server using %s after exactly one compatible retry", async profile => {
    const { service, fetcher } = setup();
    const bodies: Array<Record<string, unknown>> = [];
    fetcher.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) return Response.json({ detail: [{
        loc: ["body", "head_max_len"], type: "extra_forbidden", msg: "Extra inputs are not permitted",
      }] }, { status: 422 });
      expect(Object.keys(body).sort()).toEqual(["max_len", "model", "questions", "state"]);
      expect(body.model).toBe("auto");
      expect(body.questions).toHaveProperty("greeting.instructions");
      return Response.json({ model: "multilingual", answers: { greeting: { type: "noul", noul: 0.95 } } });
    });
    const result = await service.registerProviderModels({
      connection: { ...connection, kind: "laya" }, models: [{ ...model("auto"), profile }],
    }, "admin");
    expect(result.models[0]).toMatchObject({ model: "auto", connectionStatus: "validated", status: "pending", layaRequestMode: "compatible" });
    expect(result.models[0]?.connectionMessage).toContain("compatible");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(bodies[0]).toMatchObject({ model: "auto", max_len: 1024, head_max_len: 512 });
    expect(bodies[1]).not.toHaveProperty("head_max_len");
  });

  it("retries with the compatible shape only for the strict 1Panel VALIDATION_ERROR envelope", async () => {
    const { service, fetcher } = setup();
    const bodies: Array<Record<string, unknown>> = [];
    fetcher.mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) return Response.json({ detail: { code: "VALIDATION_ERROR", message: "Request validation failed", errors: [
        { loc: ["body", "head_max_len"], type: "extra_forbidden", message: "Extra inputs are not permitted" },
      ] } }, { status: 422 });
      return Response.json({ model: "laya", answers: { greeting: { type: "noul", noul: 0.9 } } });
    });
    const result = await service.registerProviderModels({
      connection: { ...connection, kind: "laya" }, models: [{ ...model("laya"), profile: "tali.laya.v1" }],
    }, "admin");
    expect(result.models[0]).toMatchObject({ layaRequestMode: "compatible", connectionStatus: "validated" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(bodies[0]).toHaveProperty("head_max_len", 512);
    expect(bodies[1]).not.toHaveProperty("head_max_len");
  });

  it("keeps the failed result and stores no mode when the compatible probe also fails", async () => {
    const { service, fetcher, rows } = setup();
    fetcher.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.head_max_len !== undefined) return Response.json({ detail: [{
        loc: ["body", "head_max_len"], type: "extra_forbidden", msg: "Extra inputs are not permitted",
      }] }, { status: 422 });
      return Response.json({ detail: { code: "MODEL_NOT_AVAILABLE", message: `Only multilingual is installed; credential=${connection.apiKey}` } }, { status: 422 });
    });
    const result = await service.registerProviderModels({
      connection: { ...connection, kind: "laya" }, models: [{ ...model("english"), profile: "tali.laya.v1" }],
    }, "admin");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.models[0]).toMatchObject({ connectionStatus: "failed", status: "pending" });
    expect(result.models[0]?.connectionMessage).toContain("MODEL_NOT_AVAILABLE");
    expect(JSON.stringify(result)).not.toContain(connection.apiKey);
    expect(rows.get(modelDefinitions)?.[0]).not.toHaveProperty("layaRequestMode");
  });

  it("shows nested Laya server validation errors without silently remapping the model", async () => {
    const { service, fetcher } = setup();
    fetcher.mockResolvedValue(Response.json({ detail: {
      code: "VALIDATION_ERROR", message: "Request validation failed", errors: [
        { loc: ["body", "model"], type: "literal_error", message: "Input should be 'auto', 'english', 'multilingual' or 'typed-decisions'", input: "private-input" },
        { loc: ["body", "head_max_len"], type: "extra_forbidden", message: "Extra inputs are not permitted", ctx: { key: connection.apiKey } },
      ],
    } }, { status: 422 }));
    const result = await service.registerProviderModels({
      connection: { ...connection, kind: "laya" }, models: [{ ...model("laya"), profile: "tali.laya.v1" }],
    }, "admin");
    expect(result.models[0]).toMatchObject({ model: "laya", connectionStatus: "failed" });
    expect(result.models[0]?.connectionMessage).toContain("body.model: Input should be 'auto'");
    expect(result.models[0]?.connectionMessage).toContain("body.head_max_len: Extra inputs are not permitted");
    expect(JSON.stringify(result)).not.toContain("private-input");
    expect(JSON.stringify(result)).not.toContain(connection.apiKey);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(result.models[0]).not.toHaveProperty("layaRequestMode");
  });

  it("preserves nested model-unavailable errors and redacts their message", async () => {
    const { service, fetcher } = setup();
    fetcher.mockResolvedValue(Response.json({ detail: {
      code: "MODEL_NOT_AVAILABLE", message: `Only multilingual is installed; credential=${connection.apiKey}`,
    } }, { status: 422 }));
    const result = await service.registerProviderModels({
      connection: { ...connection, kind: "laya" }, models: [{ ...model("english"), profile: "tali.laya.v1" }],
    }, "admin");
    expect(result.models[0]?.connectionMessage).toContain("MODEL_NOT_AVAILABLE: Only multilingual is installed");
    expect(JSON.stringify(result)).not.toContain(connection.apiKey);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["native", "compatible"] as const)("re-detects and persists the %s Laya request mode on a connection test", async mode => {
    const { service, rows, fetcher } = setup();
    const providerId = "fe3671e8-a707-4d9b-a6a4-ea804ae76ec4", modelId = "7471c0eb-a533-449a-8814-98c3bc23aa98";
    rows.set(modelProviders, [{ id: providerId, name: "Laya", kind: "laya", baseUrl: "https://laya.test/v1",
      credentialCiphertext: "", skipTlsVerify: false }]);
    rows.set(modelDefinitions, [{ id: modelId, projectId: null, providerId, name: "laya", model: "laya",
      profile: "tali.laya.v1", timeoutSeconds: 20, maxTokens: 64, layaRequestMode: mode === "native" ? "compatible" : "native" }]);
    let calls = 0;
    fetcher.mockImplementation(async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (mode === "compatible" && body.head_max_len !== undefined) return Response.json({ detail: [{
        loc: ["body", "head_max_len"], type: "extra_forbidden", msg: "Extra inputs are not permitted",
      }] }, { status: 422 });
      return Response.json({ model: "laya", answers: { greeting: { type: "noul", noul: 0.9 } } });
    });
    const result = await service.testModelConnection(modelId, "admin");
    expect(result).toMatchObject({ connectionStatus: "validated", layaRequestMode: mode });
    expect(result.connectionMessage).toContain(mode);
    expect(fetcher).toHaveBeenCalledTimes(mode === "native" ? 1 : 2);
    expect(rows.get(modelDefinitions)?.[0]?.layaRequestMode).toBe(mode);
    // A changed transport mode must reload Runner desired state once.
    const { generation, events } = desiredState(rows);
    expect(generation).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "runner.desired_state_changed", aggregateId: modelId });
    expect(events[0]?.payload).toMatchObject({ resourceType: "model_definition", modelId, generation: 1 });
  });

  it("does not downgrade a stored Laya mode or retry after an unrelated probe failure", async () => {
    const { service, rows, fetcher } = setup();
    const providerId = "fe3671e8-a707-4d9b-a6a4-ea804ae76ec4", modelId = "7471c0eb-a533-449a-8814-98c3bc23aa98";
    rows.set(modelProviders, [{ id: providerId, name: "Laya", kind: "laya", baseUrl: "https://laya.test/v1",
      credentialCiphertext: "", skipTlsVerify: false }]);
    rows.set(modelDefinitions, [{ id: modelId, projectId: null, providerId, name: "laya", model: "laya",
      profile: "tali.laya.v1", timeoutSeconds: 20, maxTokens: 64, connectionStatus: "validated", layaRequestMode: "native" }]);
    fetcher.mockResolvedValue(new Response("Server busy", { status: 503 }));
    const result = await service.testModelConnection(modelId, "admin");
    expect(result).toMatchObject({ connectionStatus: "failed" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(rows.get(modelDefinitions)?.[0]?.layaRequestMode).toBe("native");
  });

  it.each(["native", "compatible"] as const)("persists the detected %s Laya mode through revalidation", async mode => {
    const { service, rows, fetcher } = setup();
    const providerId = "fe3671e8-a707-4d9b-a6a4-ea804ae76ec4", modelId = "7471c0eb-a533-449a-8814-98c3bc23aa98";
    rows.set(modelProviders, [{ id: providerId, name: "Laya", kind: "laya", baseUrl: "https://laya.test/v1",
      credentialCiphertext: "", skipTlsVerify: false }]);
    rows.set(modelDefinitions, [{ id: modelId, projectId: null, providerId, name: "laya", model: "laya",
      profile: "tali.laya.v1", timeoutSeconds: 20, maxTokens: 64, status: "pending", layaRequestMode: null }]);
    fetcher.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (mode === "compatible" && body.head_max_len !== undefined) return Response.json({ detail: [{
        loc: ["body", "head_max_len"], type: "extra_forbidden", msg: "Extra inputs are not permitted",
      }] }, { status: 422 });
      return Response.json({ model: "laya", answers: { greeting: { type: "noul", noul: 0.9 } } });
    });
    const result = await service.revalidateModel(modelId, "admin");
    expect(result).toMatchObject({ status: "validated", layaRequestMode: mode });
    expect(rows.get(modelDefinitions)?.[0]?.layaRequestMode).toBe(mode);
    // A changed transport mode must reload Runner desired state once.
    const { generation, events } = desiredState(rows);
    expect(generation).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "runner.desired_state_changed", aggregateId: modelId });
    expect(events[0]?.payload).toMatchObject({ resourceType: "model_definition", modelId, generation: 1 });
  });

  it.each(["connection test", "revalidation"] as const)("does not reload Runner desired state when %s re-detects the same Laya mode", async operation => {
    const { service, rows, fetcher } = setup();
    const providerId = "fe3671e8-a707-4d9b-a6a4-ea804ae76ec4", modelId = "7471c0eb-a533-449a-8814-98c3bc23aa98";
    rows.set(modelProviders, [{ id: providerId, name: "Laya", kind: "laya", baseUrl: "https://laya.test/v1",
      credentialCiphertext: "", skipTlsVerify: false }]);
    rows.set(modelDefinitions, [{ id: modelId, projectId: null, providerId, name: "laya", model: "laya",
      profile: "tali.laya.v1", timeoutSeconds: 20, maxTokens: 64, status: "validated", connectionStatus: "validated",
      layaRequestMode: "native" }]);
    fetcher.mockImplementation(async () => Response.json({ model: "laya", answers: { greeting: { type: "noul", noul: 0.9 } } }));
    if (operation === "connection test") await service.testModelConnection(modelId, "admin");
    else await service.revalidateModel(modelId, "admin");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(rows.get(modelDefinitions)?.[0]?.layaRequestMode).toBe("native");
    // Native -> native changes nothing in the plan, so no reload is needed.
    expect(desiredState(rows).generation).toBe(0);
    expect(rows.get(outboxEvents) ?? []).toEqual([]);
  });

  it("clears the detected Laya mode and reloads desired state when Provider connection settings change", async () => {
    const { service, rows, fetcher } = setup();
    const providerId = "fe3671e8-a707-4d9b-a6a4-ea804ae76ec4", modelId = "7471c0eb-a533-449a-8814-98c3bc23aa98";
    rows.set(modelProviders, [{ id: providerId, name: "Laya", kind: "laya", baseUrl: "https://laya.test/v1",
      credentialCiphertext: "", skipTlsVerify: false, status: "validated" }]);
    rows.set(modelDefinitions, [{ id: modelId, projectId: null, providerId, name: "laya", model: "laya",
      profile: "tali.laya.v1", timeoutSeconds: 20, maxTokens: 64, connectionStatus: "validated", layaRequestMode: "native" }]);
    // A failed probe leaves the mode undetected, so the stale native shape is cleared.
    fetcher.mockResolvedValue(new Response("Unavailable", { status: 503 }));
    await service.updateProvider(providerId, { baseUrl: "https://laya-new.test/v1" }, "admin");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(rows.get(modelDefinitions)?.[0]?.layaRequestMode).toBeNull();
    const { generation, events } = desiredState(rows);
    expect(generation).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "runner.desired_state_changed", aggregateId: providerId });
    expect(events[0]?.payload).toMatchObject({ resourceType: "model_provider", providerId, generation: 1 });
  });

  it("creates a Laya model with the probed request mode", async () => {
    const { service, rows, fetcher } = setup();
    const providerId = "a2b3c4d5-1111-4444-8888-123456789012";
    rows.set(modelProviders, [{ id: providerId, name: "Laya", kind: "laya", baseUrl: "https://laya.test/v1",
      credentialCiphertext: "", skipTlsVerify: false }]);
    fetcher.mockImplementation(async () => Response.json({ model: "laya", answers: { greeting: { type: "noul", noul: 0.9 } } }));
    const created = await service.createModel({ providerId, ...model("laya"), profile: "tali.laya.v1" }, "admin");
    expect(created).toMatchObject({ profile: "tali.laya.v1", connectionStatus: "validated", layaRequestMode: "native" });
    expect(rows.get(modelDefinitions)?.[0]?.layaRequestMode).toBe("native");
  });

  it("clears the detected Laya mode when the model protocol is reconfigured", async () => {
    const { service, rows } = setup();
    const providerId = "fe3671e8-a707-4d9b-a6a4-ea804ae76ec4", modelId = "7471c0eb-a533-449a-8814-98c3bc23aa98";
    rows.set(modelProviders, [{ id: providerId, name: "Laya", kind: "laya", baseUrl: "https://laya.test/v1",
      credentialCiphertext: "", skipTlsVerify: false }]);
    rows.set(modelDefinitions, [{ id: modelId, projectId: null, providerId, name: "laya", model: "laya",
      profile: "tali.laya.v1", timeoutSeconds: 20, maxTokens: 64, layaRequestMode: "native" }]);
    const result = await service.configureModel(modelId, { profile: "tali.laya-topic.v1", timeoutSeconds: 30, maxTokens: 512 }, "admin");
    expect(result).toMatchObject({ profile: "tali.laya-topic.v1", layaRequestMode: null, connectionStatus: "pending" });
    expect(rows.get(modelDefinitions)?.[0]?.layaRequestMode).toBeNull();
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
    expect(result.models.every((item) => item.projectId === null)).toBe(true);
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

  it.each(["projectA", "projectB"])("prevents project %s users from changing or discovering global Providers", async (projectId) => {
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
      await expect(runWithProjectContext({ projectId, actorId: "group_b", role: "user" }, operation))
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

  it.each(["tali.typesafe-jev-topic.v1", "tali.typesafe-jev.v1"] as const)("registers a pinned Jev version with %s through System One without fetching the catalog", async profile => {
    const { service, fetcher } = setup();
    fetcher.mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return Response.json({ model: "jev-1.13.0", answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul", noul: 0.99 }])) });
    });
    const result = await service.registerProviderModels({
      connection: { ...connection, kind: "typesafe", baseUrl: "https://api.typesafe.ai/v1" },
      models: [{ ...model("jev-1.13.0"), profile }],
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
    expect(result).toMatchObject({ projectId: null, model: "bad", status: "pending", validatedAt: null, validationLatencyMs: null });
    expect(result.connectionStatus).toBe("failed");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("/chat/completions");
    expect(rows.get(modelDefinitions)).toHaveLength(1);
  });

  it("creates project-owned Models on a global platform Provider", async () => {
    const { service, rows } = setup();
    const providerId = "a2b3c4d5-1111-4444-8888-123456789012";
    rows.set(modelProviders, [{ id: providerId, name: "Platform provider", kind: "custom-openai-compatible", baseUrl: connection.baseUrl, credentialCiphertext: "", skipTlsVerify: false }]);
    const created = await runWithProjectContext({ projectId: "projectB", actorId: "group_b", role: "user" }, () =>
      service.createModel({ ...model("chat"), providerId }, "group_b"));
    expect(created).toMatchObject({ projectId: "projectB", providerId, model: "chat", connectionStatus: "validated" });
    expect(rows.get(modelProviders)?.[0]).not.toHaveProperty("projectId");
    expect(rows.get(modelDefinitions)?.[0]?.projectId).toBe("projectB");
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
