// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { ModelPricingService } from "./model-pricing.js";
import { parseLiteLLMPrices } from "./model-pricing-domain.js";
import { ControlPlaneService } from "./control-plane.js";
import type { ControllerConfig } from "../config.js";
import type { RuntimeEventInput } from "../domain/models.js";
import { runWithProjectContext } from "./project-context.js";
const url = process.env.GUARD_TEST_POSTGRES_URL;
const catalog = (input = 2e-7) => Object.fromEntries(Array.from({ length: 12 }, (_, index) => [index === 0 ? "groq/llama-guard-3-8b" : `model-${index}`, { mode: "chat", input_cost_per_token: input, output_cost_per_token: 6e-7 }]));
describe.skipIf(!url)("global model prices and immutable Guardrail costs", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>; let pricing: ModelPricingService; let service: ControlPlaneService;
  const loader = vi.fn<() => unknown>();
  const snapshot = (input = 2e-7) => ({ version: "2026-10-14", prices: Object.fromEntries(parseLiteLLMPrices(catalog(input))) });
  const event = (id: string, options: Partial<RuntimeEventInput> = {}): RuntimeEventInput => ({ id, occurredAt: new Date(), requestId: id, runnerId: "runner-1", guardrailId: "guard-1", endpointId: "endpoint-a", direction: "incoming", decision: "allow", durationMs: 20, metadata: { usage: { model_calls: [{ call_id: id, runtime_ref: "model-1", provider: "provider-1", model: "llama-guard-3-8b", usage_known: true, input_tokens: 1000, output_tokens: 100, cached_input_tokens: 0 }] } }, ...options });
  beforeAll(async () => {
    database = await createTestDatabase(url!, "model_costs");
    await database.pool.query("INSERT INTO auth_user(id,name,email,role) VALUES ('admin','Admin','costs@test.local','admin')");
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
    await database.pool.query("INSERT INTO resource_share(id,owner_project_id,recipient_project_id,resource_type,resource_id) VALUES ('share-model-2','projectA','projectB','model','model-2')");
    const view = await runWithProjectContext({ projectId: 'projectB', role: 'user' }, () => pricing.view());
    expect(new Set(view.models.map(model => model.modelId))).toEqual(new Set(['model-b', 'model-2']));
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

  it("redacts private Model identifiers and names from shared Guardrail cost details", async () => {
    await database.pool.query("UPDATE model_definition SET project_id='projectA' WHERE id='model-1'");
    await database.pool.query("INSERT INTO resource_share(id,owner_project_id,recipient_project_id,resource_type,resource_id) VALUES ('share-guard-1','projectA','projectB','guardrail','guard-1')");
    const original = await pricing.guardrailUsage('guard-1', { window: 'month', source: 'all' });
    const empty = await runWithProjectContext({ projectId: 'projectB', role: 'user' }, () => pricing.guardrailUsage('guard-1', { window: 'month', source: 'all' }));
    expect(empty).toMatchObject({ calls: 0, models: [], totals: [], trend: [] });
    expect((await runWithProjectContext({ projectId: 'projectB', role: 'user' }, () => pricing.monthlyCosts(['guard-1']))).get('guard-1'))
      .toMatchObject({ calls: 0, cost: 0 });
    await database.pool.query("INSERT INTO endpoint(id,project_id,name,adapter) VALUES ('endpoint-b','projectB','B Gateway','http')");
    await service.recordRuntimeEvents([event('project-b-shared', { endpointId: 'endpoint-b' })]);
    expect((await database.pool.query("SELECT project_id FROM model_usage_cost WHERE event_id='project-b-shared'")).rows[0])
      .toMatchObject({ project_id: 'projectB' });
    const shared = await runWithProjectContext({ projectId: 'projectB', role: 'user' }, () => pricing.guardrailUsage('guard-1', { window: 'month', source: 'all' }));
    expect(shared).toMatchObject({ calls: 1, totals: [{ currency: 'USD', cost: 0.001 }] });
    expect((await runWithProjectContext({ projectId: 'projectB', role: 'user' }, () => pricing.monthlyCosts(['guard-1']))).get('guard-1'))
      .toMatchObject({ calls: 1, cost: 0.001 });
    expect((await runWithProjectContext({ projectId: 'projectA', role: 'user' }, () => pricing.guardrailUsage('guard-1', { window: 'month', source: 'all' }))).calls)
      .toBe(original.calls);
    expect(shared.models.every(model => model.modelId === null && model.model === 'Configured detector')).toBe(true);
    expect(JSON.stringify(shared)).not.toContain('model-1');
    expect(JSON.stringify(shared)).not.toContain('llama-guard-3-8b');
    await expect(runWithProjectContext({ projectId: 'projectC', role: 'user' }, () => pricing.guardrailUsage('guard-1',
      { window: 'month', source: 'all' }))).rejects.toMatchObject({ code: 'not_found' });

    await database.pool.query("INSERT INTO resource_share(id,owner_project_id,recipient_project_id,resource_type,resource_id) VALUES ('share-model-1','projectA','projectB','model','model-1')");
    const readable = await runWithProjectContext({ projectId: 'projectB', role: 'user' }, () => pricing.guardrailUsage('guard-1', { window: 'month', source: 'all' }));
    expect(readable.models.some(model => model.modelId === 'model-1' && model.model === 'llama-guard-3-8b')).toBe(true);
    await database.pool.query("DELETE FROM resource_share WHERE id='share-model-1'");
    const revoked = await runWithProjectContext({ projectId: 'projectB', role: 'user' }, () => pricing.guardrailUsage('guard-1', { window: 'month', source: 'all' }));
    expect(revoked.models.every(model => model.modelId === null && model.model === 'Configured detector')).toBe(true);
  });

  it("hides private Providers and merges private Model cost rows without changing project totals", async () => {
    await database.pool.query(`
      INSERT INTO guardrail(id,project_id,name,draft_config) VALUES ('guard-shared-cost','projectA','A Guardrail','{}');
      INSERT INTO resource_share(id,owner_project_id,recipient_project_id,resource_type,resource_id)
        VALUES ('cost-share-b','projectA','projectB','guardrail','guard-shared-cost');
      INSERT INTO model_provider(id,name,kind,base_url,credential_ciphertext) VALUES
        ('private-provider-1','Private Vendor One','openai-compatible','https://private-one.invalid','encrypted'),
        ('private-provider-2','Private Vendor Two','openai-compatible','https://private-two.invalid','encrypted');
      INSERT INTO model_definition(id,project_id,provider_id,name,model,profile) VALUES
        ('private-model-1','projectA','private-provider-1','Private One','secret-model-one','generic-chat'),
        ('private-model-2','projectC','private-provider-2','Private Two','secret-model-two','generic-chat'),
        ('cost-visible-b','projectB','provider-1','B model','visible-b-model','generic-chat');
      INSERT INTO model_usage_cost(id,project_id,event_id,guardrail_id,model_id,model,provider,source,occurred_at,calls,input_tokens,output_tokens,currency,amount,reason) VALUES
        ('hidden-one','projectB','hidden-event-one','guard-shared-cost','private-model-1','secret-model-one','Private Vendor One','runtime',now(),1,10,2,'USD',1,'priced'),
        ('hidden-two','projectB','hidden-event-two','guard-shared-cost','private-model-2','secret-model-two','Private Vendor Two','runtime',now(),2,20,4,'USD',2,'priced'),
        ('own-model-cost','projectB','own-event','guard-shared-cost','cost-visible-b','visible-b-model','Groq','runtime',now(),1,5,1,'USD',2.5,'priced');
    `);
    const view = await runWithProjectContext({ projectId: 'projectB', role: 'user' }, () => pricing.guardrailUsage('guard-shared-cost', { window: 'month', source: 'all' }));
    expect(view).toMatchObject({ calls: 4, inputTokens: 35, outputTokens: 7, totals: [{ currency: 'USD', cost: 5.5 }] });
    expect(view.models).toHaveLength(2);
    expect(view.models).toContainEqual(expect.objectContaining({ modelId: null, model: 'Configured detector', provider: 'Configured provider', calls: 3, inputTokens: 30, outputTokens: 6, cost: 3 }));
    expect(view.models).toContainEqual(expect.objectContaining({ modelId: 'cost-visible-b', provider: 'Groq', calls: 1, cost: 2.5 }));
    // Each hidden model costs less than the visible model individually, but
    // the combined hidden row sorts first. Its order must not reveal an
    // individual hidden model's amount.
    expect(view.models.map(model => model.modelId)).toEqual([null, 'cost-visible-b']);
    for (const secret of ['private-model-1', 'private-model-2', 'secret-model-one', 'secret-model-two', 'Private Vendor One', 'Private Vendor Two']) {
      expect(JSON.stringify(view)).not.toContain(secret);
    }
    const admin = await pricing.guardrailUsage('guard-shared-cost', { window: 'month', source: 'all' });
    expect(admin.models).toHaveLength(3);
    expect(admin.models.some(model => model.modelId === 'private-model-1' && model.provider === 'Private Vendor One')).toBe(true);
    await database.pool.query("INSERT INTO resource_share(id,owner_project_id,recipient_project_id,resource_type,resource_id) VALUES ('cost-model-share','projectA','projectB','model','private-model-1')");
    const shared = await runWithProjectContext({ projectId: 'projectB', role: 'user' }, () => pricing.guardrailUsage('guard-shared-cost', { window: 'month', source: 'all' }));
    expect(shared.models).toContainEqual(expect.objectContaining({ modelId: 'private-model-1', provider: 'Private Vendor One', calls: 1, cost: 1 }));
    expect(JSON.stringify(shared)).not.toContain('Private Vendor Two');
    await database.pool.query("DELETE FROM resource_share WHERE id='cost-model-share'");
    const revoked = await runWithProjectContext({ projectId: 'projectB', role: 'user' }, () => pricing.guardrailUsage('guard-shared-cost', { window: 'month', source: 'all' }));
    expect(revoked.models.filter(model => model.modelId === null)).toHaveLength(1);
    expect(JSON.stringify(revoked)).not.toContain('Private Vendor One');
    // Unmatched, unpriced calls must stay unpriced when merged, rather than
    // becoming zero-cost or revealing the number or names of unknown models.
    await database.pool.query(`
      INSERT INTO model_usage_cost(id,project_id,event_id,guardrail_id,model_id,model,provider,source,occurred_at,calls,input_tokens,output_tokens,currency,amount,reason) VALUES
        ('unknown-one','projectB','unknown-event-one','guard-shared-cost',NULL,'unknown-secret-one','unknown-vendor-one','runtime',now(),1,NULL,NULL,NULL,NULL,'unmatched_model'),
        ('unknown-two','projectB','unknown-event-two','guard-shared-cost',NULL,'unknown-secret-two','unknown-vendor-two','runtime',now(),2,NULL,NULL,NULL,NULL,'unmatched_model');
    `);
    const unknown = await runWithProjectContext({ projectId: 'projectB', role: 'user' }, () => pricing.guardrailUsage('guard-shared-cost', { window: 'month', source: 'all' }));
    expect(unknown.models.filter(model => model.currency === null)).toEqual([
      expect.objectContaining({ modelId: null, model: 'Configured detector', provider: 'Configured provider', calls: 3, cost: null, unpriced: 3, unknownUsage: 3 }),
    ]);
    expect(unknown).toMatchObject({ calls: 7, unpriced: 3, unknownUsage: 3, totals: [{ currency: 'USD', cost: 5.5 }] });
    for (const secret of ['unknown-secret-one', 'unknown-secret-two', 'unknown-vendor-one', 'unknown-vendor-two']) {
      expect(JSON.stringify(unknown)).not.toContain(secret);
    }
  });

});
