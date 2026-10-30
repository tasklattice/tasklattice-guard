import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gte, ilike, isNotNull, isNull, lte, inArray, sql } from "drizzle-orm";
import type { ControllerDatabase } from "../db/client.js";
import { boundedRead } from "../db/read-budget.js";
import { auditEvents, guardrails, modelDefinitions, modelProviders, modelPriceRevisions as prices, modelPriceSync as sync, modelUsageCosts as costs } from "../db/schema.js";
import { NotFoundError, ValidationError } from "../domain/errors.js";
import type { RuntimeEventInput } from "../domain/models.js";
import { modelRatesSchema, pricingRuleSchema, type GuardrailMonthlyCost, type CostQuery, type GuardrailCostView, type ModelPricingView, type PricingSyncView } from "../../shared/model-pricing.js";
import { automaticCatalogKeys, LITELLM_PRICE_URL, meteredCalls, priceCall } from "./model-pricing-domain.js";

import bundledCatalog from "../catalog/model-prices.json" with { type: "json" };
import { z } from "zod";

const bundledCatalogSchema = z.object({ version: z.string().min(1).max(100), prices: z.record(z.string().min(1).max(512), modelRatesSchema).refine(value => Object.keys(value).length >= 10, "The bundled catalog must contain at least 10 valid USD prices.") });

type ReadDb = Pick<ControllerDatabase, "select" | "selectDistinctOn" | "insert" | "update" | "execute">;
const modelKey = (providerId: string, model: string) => `model:${JSON.stringify([providerId, model])}`;
const catalogKey = (key: string) => `litellm:${key}`;
const iso = (at: Date | null | undefined) => at?.toISOString() ?? null;
const modelsQuery = (db: ReadDb) => db.select({ id: modelDefinitions.id, providerId: modelProviders.id, provider: modelProviders.name, baseUrl: modelProviders.baseUrl, model: modelDefinitions.model }).from(modelDefinitions).innerJoin(modelProviders, eq(modelProviders.id, modelDefinitions.providerId));
type PricingModel = Awaited<ReturnType<typeof modelsQuery>>[number];
async function revision(db: ReadDb, key: string, at: Date) {
  return (await db.select().from(prices).where(and(eq(prices.key, key), lte(prices.effectiveAt, at))).orderBy(desc(prices.effectiveAt), desc(prices.id)).limit(1))[0] ?? null;
}
async function resolvedPrice(db: ReadDb, model: PricingModel, at: Date) {
  const rule = await revision(db, modelKey(model.providerId, model.model), at);
  if (rule?.source === "manual") return { rule, price: rule, key: null };
  const keys = rule?.catalogKey ? [rule.catalogKey] : automaticCatalogKeys(model.baseUrl, model.model);
  for (const key of keys) {
    const price = await revision(db, catalogKey(key), at);
    if (price) return { rule, price, key };
  }
  return { rule, price: null, key: rule?.catalogKey ?? keys[0] ?? null };
}

/** Called within the telemetry transaction; immutable IDs make WAL replay idempotent. */
export function modelUsageCostRecorder(db: ReadDb) {
  let catalog: Promise<PricingModel[]> | undefined;
  return async (event: RuntimeEventInput): Promise<void> => {
    if (!event.guardrailId) return;
    const calls = meteredCalls(event.metadata);
    if (!calls.length) return;
    // Only the current chunk shares the model catalog; historical price lookup
    // still uses each event's occurredAt, including across month boundaries.
    const models = await (catalog ??= Promise.resolve(modelsQuery(db)));
    const resolved = new Map<string, Awaited<ReturnType<typeof resolvedPrice>>>();
    for (const call of calls) {
      const identified = models.find(model => model.id === call.runtimeRef) ?? models.find(model => model.id === call.provider);
      const candidates = identified ? [identified] : models.filter(model => model.providerId === call.provider && model.model === call.model);
      // Several profiles of one provider/model share a global price.
      if (candidates.length > 1 && candidates.every(item => item.providerId === candidates[0]!.providerId && item.model === candidates[0]!.model)) candidates.splice(1);
      const model = candidates.length === 1 ? candidates[0]! : null;
      let price = null;
      if (model) {
        if (!resolved.has(model.id)) resolved.set(model.id, await resolvedPrice(db, model, event.occurredAt));
        price = resolved.get(model.id)!.price;
      }
      const calculated = priceCall(call, price?.rates ?? null);
      const id = createHash("sha256").update(JSON.stringify([event.runnerId, event.id, call.id])).digest("hex");
      await db.insert(costs).values({ id, eventId: event.id, guardrailId: event.guardrailId,
        guardrailVersion: event.guardrailVersion ?? null, modelId: model?.id ?? null, model: call.model,
        provider: model?.provider ?? call.provider, source: event.metadata.costSource === "testing" || event.metadata.protocol === "playground" ? "testing" : "runtime",
        occurredAt: event.occurredAt, calls: call.calls, inputTokens: call.inputTokens, outputTokens: call.outputTokens,
        cachedInputTokens: call.cachedInputTokens, priceId: price?.id ?? null, currency: price?.rates?.currency ?? null,
        amount: calculated.amount === null ? null : calculated.amount.toFixed(12), reason: model ? calculated.reason : "unmatched_model",
      }).onConflictDoNothing();
    }
  };
}

export class ModelPricingService {
  private running: Promise<PricingSyncView> | null = null;
  constructor(private readonly db: ControllerDatabase, private readonly loadCatalog: () => unknown = () => bundledCatalog) {}

  // Complete the local import before accepting telemetry. No network or background timer.
  async start(): Promise<void> { await this.synchronize(); }
  async stop(): Promise<void> { await this.running; }

  async status(): Promise<PricingSyncView> {
    const [row] = await this.db.select().from(sync).where(eq(sync.id, "litellm"));
    return { sourceUrl: LITELLM_PRICE_URL, catalogVersion: row?.catalogVersion ?? null, lastSuccessAt: iso(row?.lastSuccessAt),
      error: row?.error ?? null, entries: row?.entries ?? 0, meteringSince: iso(row?.meteringSince) };
  }

  synchronize(): Promise<PricingSyncView> {
    if (this.running) return this.running;
    this.running = this.syncOnce().finally(() => { this.running = null; });
    return this.running;
  }

  private async syncOnce(): Promise<PricingSyncView> {
    await this.db.insert(sync).values({ id: "litellm" }).onConflictDoNothing();
    try {
      const snapshot = bundledCatalogSchema.parse(this.loadCatalog());
      const entries = new Map(Object.entries(snapshot.prices));
      await this.db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('guard-model-price-sync'))`);
        const current = await tx.selectDistinctOn([prices.key]).from(prices).where(eq(prices.source, "litellm")).orderBy(prices.key, desc(prices.effectiveAt));
        const previous = new Map(current.map(row => [row.key, row.rates]));
        const effectiveAt = new Date();
        const changed: Array<typeof prices.$inferInsert> = [...entries].filter(([key, rates]) => !isDeepStrictEqual(previous.get(catalogKey(key)), rates))
          .map(([key, rates]) => ({ id: randomUUID(), key: catalogKey(key), catalogKey: key, rates, source: "litellm" as const, effectiveAt }));
        // Retiring a price stops new use; historical amounts and manual overrides survive.
        for (const row of current) if (row.rates && row.catalogKey && !entries.has(row.catalogKey)) {
          changed.push({ id: randomUUID(), key: row.key, catalogKey: row.catalogKey, rates: null, source: "litellm", effectiveAt });
        }
        for (let i = 0; i < changed.length; i += 250) await tx.insert(prices).values(changed.slice(i, i + 250));
        await tx.update(sync).set({ catalogVersion: snapshot.version, lastSuccessAt: effectiveAt, error: null, entries: entries.size }).where(eq(sync.id, "litellm"));
      });
    } catch (error) {
      await this.db.update(sync).set({ error: error instanceof Error ? error.message.slice(0, 500) : "Bundled price import failed." }).where(eq(sync.id, "litellm"));
    }
    return this.status();
  }

  /** One indexed aggregate for the collection; prices never enter Guardrail definitions. */
  async monthlyCosts(guardrailIds: string[]): Promise<Map<string, GuardrailMonthlyCost>> {
    if (!guardrailIds.length) return new Map();
    const until = new Date();
    const since = new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), 1));
    const rows = await boundedRead(this.db, (tx, execute) => execute(tx.select({ id: costs.guardrailId,
      calls: sql<number>`sum(${costs.calls})::float8`, cost: sql<number | null>`sum(${costs.amount})::float8`,
      unpriced: sql<number>`coalesce(sum(${costs.calls}) filter (where ${costs.amount} is null),0)::float8`,
    }).from(costs).where(and(inArray(costs.guardrailId, guardrailIds), gte(costs.occurredAt, since), lte(costs.occurredAt, until))).groupBy(costs.guardrailId)));
    const totals = new Map(rows.map(row => [row.id, row]));
    return new Map(guardrailIds.map(id => { const row = totals.get(id); return [id, {
      currency: "USD", cost: row ? row.cost : 0, calls: row?.calls ?? 0, unpriced: row?.unpriced ?? 0,
      since: since.toISOString(), until: until.toISOString(),
    }]; }));
  }

  async view(): Promise<{ sync: PricingSyncView; models: ModelPricingView[] }> {
    const now = new Date(); const models = await modelsQuery(this.db);
    const result: ModelPricingView[] = [];
    for (const model of models) {
      const resolved = await resolvedPrice(this.db, model, now);
      result.push({ modelId: model.id, model: model.model, provider: model.provider, mode: resolved.rule?.source === "manual" ? "manual" : "automatic",
        catalogKey: resolved.key, source: resolved.price?.rates ? resolved.price.source === "litellm" ? "litellm" : "manual" : null,
        rates: resolved.price?.rates ?? null, effectiveAt: iso(resolved.price?.effectiveAt) });
    }
    return { sync: await this.status(), models: result };
  }

  async catalog(query: string) {
    const escaped = query.replace(/[\\%_]/g, "\\$&");
    const latest = this.db.selectDistinctOn([prices.key], { key: prices.catalogKey, rates: prices.rates }).from(prices)
      .where(and(eq(prices.source, "litellm"), ilike(prices.catalogKey, `%${escaped}%`))).orderBy(prices.key, desc(prices.effectiveAt)).as("latest_prices");
    const rows = await this.db.select().from(latest).where(isNotNull(latest.rates)).orderBy(latest.key).limit(30);
    return { items: rows };
  }

  async configure(modelId: string, raw: unknown, actorId: string): Promise<ModelPricingView> {
    const input = pricingRuleSchema.parse(raw);
    const model = (await modelsQuery(this.db).where(eq(modelDefinitions.id, modelId)))[0];
    if (!model) throw new NotFoundError("Model", modelId);
    if (input.mode === "automatic" && input.catalogKey && !(await revision(this.db, catalogKey(input.catalogKey), new Date()))?.rates) throw new ValidationError("Select an existing LiteLLM price entry.");
    await this.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${modelKey(model.providerId, model.model)}))`);
      await tx.insert(prices).values({ id: randomUUID(), key: modelKey(model.providerId, model.model), source: input.mode === "manual" ? "manual" : "automatic",
        rates: input.rates, catalogKey: input.mode === "automatic" ? input.catalogKey : null, effectiveAt: new Date() });
      await tx.insert(auditEvents).values({ id: randomUUID(), kind: "model.pricing_updated", actorId, resourceType: "model", resourceId: modelId, detail: input });
    });
    return (await this.view()).models.find(row => row.modelId === modelId)!;
  }

  async guardrailUsage(guardrailId: string, query: CostQuery): Promise<GuardrailCostView> {
    const [guardrail] = await this.db.select({ id: guardrails.id }).from(guardrails).where(and(eq(guardrails.id, guardrailId), isNull(guardrails.deletedAt)));
    if (!guardrail) throw new NotFoundError("Guardrail", guardrailId);
    const until = new Date();
    // Fixed UTC periods make totals independent of the browser/server timezone.
    const since = query.window === "month" ? new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), 1)) : new Date(until.getTime() - (query.window === "7d" ? 7 : 30) * 86_400_000);
    const status = await this.status();
    return boundedRead(this.db, async (tx, execute) => {
      const predicate = and(eq(costs.guardrailId, guardrailId), gte(costs.occurredAt, since), lte(costs.occurredAt, until), query.source === "all" ? undefined : eq(costs.source, query.source));
      const sums = { calls: sql<number>`sum(${costs.calls})::float8`, inputTokens: sql<number>`coalesce(sum(${costs.inputTokens}),0)::float8`, outputTokens: sql<number>`coalesce(sum(${costs.outputTokens}),0)::float8`,
        unknownUsage: sql<number>`coalesce(sum(${costs.calls}) filter (where ${costs.inputTokens} is null or ${costs.outputTokens} is null),0)::float8`,
        cost: sql<number | null>`sum(${costs.amount})::float8`, unpriced: sql<number>`coalesce(sum(${costs.calls}) filter (where ${costs.amount} is null),0)::float8` };
      const models = await execute(tx.select({ modelId: costs.modelId, model: costs.model, provider: costs.provider, currency: costs.currency, ...sums }).from(costs).where(predicate)
        .groupBy(costs.modelId, costs.model, costs.provider, costs.currency).orderBy(sql`sum(${costs.amount}) desc nulls last`));
      const day = sql<string>`to_char(${costs.occurredAt} at time zone 'UTC', 'YYYY-MM-DD')`;
      const trend = await execute(tx.select({ day, currency: costs.currency, calls: sums.calls, cost: sums.cost, unpriced: sums.unpriced }).from(costs).where(predicate).groupBy(day, costs.currency).orderBy(day));
      const [latest] = await execute(tx.select({ at: sql<Date | string | null>`max(${costs.occurredAt})` }).from(costs).where(predicate));
      const totals = new Map<string, number>();
      for (const row of models) if (row.currency && row.cost !== null) totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.cost);
      return { since: since.toISOString(), until: until.toISOString(), meteringSince: status.meteringSince, updatedAt: latest?.at ? new Date(latest.at).toISOString() : null,
        calls: models.reduce((sum, row) => sum + row.calls, 0), inputTokens: models.reduce((sum, row) => sum + row.inputTokens, 0), outputTokens: models.reduce((sum, row) => sum + row.outputTokens, 0),
        unknownUsage: models.reduce((sum, row) => sum + row.unknownUsage, 0), unpriced: models.reduce((sum, row) => sum + row.unpriced, 0),
        totals: [...totals].map(([currency, cost]) => ({ currency, cost })), models, trend };
    });
  }
}
