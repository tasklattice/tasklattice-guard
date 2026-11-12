// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { ModelPricingService } from "./model-pricing.js";
import { parseLiteLLMPrices } from "./model-pricing-domain.js";
import { ControlPlaneService } from "./control-plane.js";
import type { ControllerConfig } from "../config.js";
import type { RuntimeEventInput } from "../domain/models.js";
import { runWithProjectContext } from "./project-context.js";
import { builtinLaya } from "../model-config/builtin-laya.js";
import { ModelConfigurationService } from "../model-config/service.js";
const url = process.env.GUARD_TEST_POSTGRES_URL;
const catalog = (input = 2e-7) => Object.fromEntries(Array.from({ length: 12 }, (_, index) => [index === 0 ? "groq/llama-guard-3-8b" : `model-${index}`, { mode: "chat", input_cost_per_token: input, output_cost_per_token: 6e-7 }]));
describe.skipIf(!url)("global model prices and immutable Guardrail costs", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>; let pricing: ModelPricingService; let service: ControlPlaneService;
  const loader = vi.fn<() => unknown>();
  const snapshot = (input = 2e-7) => ({ version: "2026-10-14", prices: Object.fromEntries(parseLiteLLMPrices(catalog(input))) });
  const event = (id: string, options: Partial<RuntimeEventInput> = {}): RuntimeEventInput => ({ id, occurredAt: new Date(), requestId: id, runnerId: "runner-1", guardrailId: "guard-1", endpointId: "endpoint-a", direction: "incoming", decision: "allow", durationMs: 20, metadata: { usage: { model_calls: [{ call_id: id, runtime_ref: "model-1", provider: "provider-1", model: "llama-guard-3-8b", usage_known: true, input_tokens: 1000, output_tokens: 100, cached_input_tokens: 0 }] } }, ...options });
  beforeAll(async () => {
    database = await createTestDatabase(url!, "model_costs");
    await database.pool.query("INSERT INTO auth_user(id,username,email,role) VALUES ('admin','Admin','costs@test.local','admin')");
    await database.pool.query("INSERT INTO guardrail (project_id,id,name,draft_config) VALUES ('projectA','guard-1','Costs','{}')");
    await database.pool.query("INSERT INTO endpoint(id,project_id,name,adapter) VALUES ('endpoint-a','projectA','A Gateway','http')");
    await database.pool.query("INSERT INTO model_provider(id,name,kind,base_url,credential_ciphertext) VALUES ('provider-1','Groq','openai-compatible','https://api.groq.com/openai/v1','encrypted')");
    await database.pool.query("INSERT INTO model_definition(id,provider_id,name,model,profile) VALUES ('model-1','provider-1','Safety','llama-guard-3-8b','generic-chat'), ('model-2','provider-1','Safety profile','llama-guard-3-8b','tali.llama-guard-3.v1')");
    service = new ControlPlaneService(database.db, {} as ControllerConfig);
    pricing = new ModelPricingService(database.db, loader);
    loader.mockImplementation(() => snapshot());
  });
  afterAll(async () => { await pricing?.stop(); await database?.drop(); });
  it("loads bundled rates offline and skips unchanged revisions on restart", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network unavailable"));
    await pricing.start();
    expect(await pricing.status()).toMatchObject({ catalogVersion: "2026-10-14", entries: 12, error: null });
    expect((await pricing.view()).models[0]).toMatchObject({ source: "litellm", rates: { input: 0.2 } });
    await pricing.synchronize();
    expect(network).not.toHaveBeenCalled();
    network.mockRestore();
    expect((await database.pool.query("SELECT count(*)::int AS n FROM model_price_revision")).rows[0].n).toBe(12);
  });
  it("counts replayed events once and stores costs at the effective historical price", async () => {
    const original = event("runtime-call");
    await service.recordRuntimeEvents([original, original]);
    const totals = await pricing.guardrailUsage("guard-1", { window: "month", source: "all" });
    expect(totals).toMatchObject({ calls: 1, unpriced: 0, totals: [{ currency: "USD", cost: 0.00026 }] });
    await pricing.configure("model-1", { mode: "manual", rates: { unit: "request", currency: "USD", request: 5 } }, "admin");
    expect((await pricing.view()).models.every(model => model.source === "manual")).toBe(true);
    await service.recordRuntimeEvents([event("testing-call", { metadata: { ...original.metadata, costSource: "testing", costOnly: true } }), original]);
    expect(await pricing.guardrailUsage("guard-1", { window: "month", source: "runtime" })).toMatchObject({ calls: 1, totals: [{ currency: "USD", cost: 0.00026 }] });
    expect(await pricing.guardrailUsage("guard-1", { window: "month", source: "testing" })).toMatchObject({ calls: 1, totals: [{ currency: "USD", cost: 0.005 }] });
    expect((await database.pool.query("SELECT count(*)::int AS n FROM runtime_event")).rows[0].n).toBe(1);
  });
  it("retains last good prices after an invalid local snapshot and never overwrites a manual rule", async () => {
    loader.mockReturnValueOnce({ version: "invalid", prices: {} });
    expect(await pricing.synchronize()).toMatchObject({ entries: 12, error: expect.stringContaining("valid USD prices") });
    expect((await pricing.view()).models[0]?.rates).toEqual({ unit: "request", currency: "USD", request: 5 });
    loader.mockReturnValueOnce(snapshot(3e-7)); await pricing.synchronize();
    expect((await pricing.view()).models[0]?.source).toBe("manual");
    await pricing.configure("model-1", { mode: "automatic" }, "admin");
    expect((await pricing.view()).models[0]?.rates).toMatchObject({ input: 0.3 });
  });
  it("separates unknown usage, missing prices and explicit zero without repricing old calls", async () => {
    await service.recordRuntimeEvents([event("no-usage", { metadata: { usage: { model_calls: [{ runtime_ref: "model-1", model: "llama-guard-3-8b" }] } } })]);
    await database.pool.query("UPDATE model_provider SET base_url='https://custom.example/v1'");
    await service.recordRuntimeEvents([event("no-price")]);
    await pricing.configure("model-1", { mode: "manual", rates: { unit: "free", currency: "USD" } }, "admin");
    await service.recordRuntimeEvents([event("free")]);
    const rows = (await database.pool.query("SELECT event_id,amount,reason FROM model_usage_cost WHERE event_id IN ('no-price','no-usage','free') ORDER BY event_id")).rows;
    expect(rows).toEqual([{ event_id: "free", amount: "0.000000000000", reason: "priced" }, { event_id: "no-price", amount: null, reason: "missing_price" }, { event_id: "no-usage", amount: null, reason: "missing_usage" }]);
    expect(await pricing.guardrailUsage("guard-1", { window: "month", source: "all" })).toMatchObject({ calls: 5, unpriced: 2, unknownUsage: 1 });
  });
  it("retires removed or unsupported prices without changing historical costs", async () => {
    await pricing.configure("model-1", { mode: "automatic", catalogKey: "groq/llama-guard-3-8b" }, "admin");
    const updated = catalog(); delete updated["groq/llama-guard-3-8b"];
    loader.mockReturnValueOnce({ version: "2026-10-15", prices: Object.fromEntries(parseLiteLLMPrices(updated)) }); await pricing.synchronize();
    expect((await pricing.view()).models[0]).toMatchObject({ source: null, rates: null });
    expect(await pricing.catalog("llama-guard")).toEqual({ items: [] });
    expect((await database.pool.query("SELECT amount FROM model_usage_cost WHERE event_id='runtime-call'")).rows[0].amount).toBe("0.000260000000");
  });

  it("aggregates one UTC month across versions and sources while preserving unknown totals", async () => {
    const beforeMonth = new Date(); beforeMonth.setUTCDate(1); beforeMonth.setUTCHours(0, 0, 0, 0); beforeMonth.setTime(beforeMonth.getTime() - 1);
    await service.recordRuntimeEvents([event("old-month", { occurredAt: beforeMonth })]);
    await database.pool.query("INSERT INTO guardrail (project_id,id,name,draft_config) VALUES ('projectA','empty','Empty','{}'),('projectA','unknown','Unknown','{}')");
    await service.recordRuntimeEvents([event("unknown-only", { guardrailId: "unknown" })]);
    const monthly = await pricing.monthlyCosts(["guard-1", "empty", "unknown"]);
    expect(monthly.get("guard-1")).toMatchObject({ currency: "USD", calls: 5, cost: 0.00526, unpriced: 2 });
    expect(monthly.get("empty")).toMatchObject({ cost: 0, calls: 0, unpriced: 0 });
    expect(monthly.get("unknown")).toMatchObject({ cost: null, calls: 1, unpriced: 1 });
    expect(monthly.get("guard-1")?.since.slice(8)).toBe("01T00:00:00.000Z");
  });
  it("ships a usable initial catalog and applies it without a network fetch", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Offline"));
    try {
      const bundled = new ModelPricingService(database.db);
      await bundled.start();
      expect(await bundled.status()).toMatchObject({ entries: 2440, catalogVersion: "2026-10-14", error: null });
      expect((await bundled.catalog("groq/llama-guard-3-8b")).items[0]?.rates).toMatchObject({ currency: "USD", input: 0.2, output: 0.2 });
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });

  it("keeps global pricing controls platform-only and scopes project Model prices", async () => {
    await database.pool.query("INSERT INTO model_definition(id,project_id,provider_id,name,model,profile) VALUES ('model-b','projectB','provider-1','B Safety','llama-guard-3-8b','generic-chat')");
    await database.pool.query("UPDATE model_definition SET project_id='projectA' WHERE id='model-2'");
    const view = await runWithProjectContext({ projectId: 'projectB', role: 'user' }, () => pricing.view());
    expect(new Set(view.models.map(model => model.modelId))).toEqual(new Set(['model-b', 'model-1']));
    for (const projectId of ['projectA', 'projectB']) {
      await expect(runWithProjectContext({ projectId, role: 'user' }, () => pricing.configure('model-b',
        { mode: 'manual', rates: { unit: 'free', currency: 'USD' } }, 'user'))).rejects.toMatchObject({ code: 'forbidden' });
      expect(() => runWithProjectContext({ projectId, role: 'user' }, () => pricing.synchronize())).toThrow('Platform administrator');
    }
    await expect(runWithProjectContext({ projectId: 'projectB', role: 'admin' }, () => pricing.configure('model-b',
      { mode: 'manual', rates: { unit: 'free', currency: 'USD' } }, 'admin'))).rejects.toMatchObject({ code: 'not_found' });
    await runWithProjectContext({ projectId: 'projectB', role: 'admin' }, () => pricing.configure('model-1',
      { mode: 'manual', rates: { unit: 'request', currency: 'USD', request: 1 } }, 'admin'));
    expect((await pricing.view()).models.map(model => model.modelId)).toEqual(['model-1']);
    expect((await pricing.view()).models.every(model => model.source === 'manual' && model.rates?.unit === 'request')).toBe(true);
  });

  it("records built-in Laya as a priced zero call alongside a separately billed external model", async () => {
    await new ModelConfigurationService(database.db, "test-secret", "").initialize();
    await service.recordRuntimeEvents([event("builtin-with-review", { metadata: { usage: { model_calls: [
      { call_id: "local", runtime_ref: builtinLaya.modelId, provider: builtinLaya.providerId, model: builtinLaya.model },
      { call_id: "review", runtime_ref: "model-1", provider: "provider-1", model: "llama-guard-3-8b" },
    ] } } })]);
    const records = await database.pool.query("SELECT model_id, amount, reason FROM model_usage_cost WHERE event_id=$1 ORDER BY model_id", ["builtin-with-review"]);
    expect(records.rows).toEqual([
      { model_id: builtinLaya.modelId, amount: "0.000000000000", reason: "priced" },
      { model_id: "model-1", amount: "0.001000000000", reason: "priced" },
    ]);
    expect((await pricing.view()).models.find(model => model.modelId === builtinLaya.modelId)).toMatchObject({
      source: "builtin", rates: { unit: "free", currency: "USD" },
    });
    await expect(pricing.configure(builtinLaya.modelId, { mode: "manual", rates: { unit: "free", currency: "USD" } }, "admin"))
      .rejects.toThrow("fixed zero rate");
  });


});
