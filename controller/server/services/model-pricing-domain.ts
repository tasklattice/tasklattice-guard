import { modelRatesSchema, type ModelRates, type CostReason } from "../../shared/model-pricing.js";

export const LITELLM_PRICE_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const validCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const perMillion = (value: number) => Number((value * 1_000_000).toPrecision(15));

export function parseLiteLLMPrices(value: unknown): Map<string, ModelRates> {
  const rows = new Map<string, ModelRates>();
  for (const [key, raw] of Object.entries(record(value))) {
    const item = record(raw);
    // Standard synchronous text rates; never flatten context-length tiers or surcharges.
    if (!key || key.length > 512 || !["chat", "completion", "moderation", "evaluation"].includes(String(item.mode))) continue;
    if (typeof item.input_cost_per_token !== "number" || typeof item.output_cost_per_token !== "number") continue;
    const unsupported = Object.keys(item).some(k => k.includes("cost_per") && !["input_cost_per_token", "output_cost_per_token", "cache_read_input_token_cost"].includes(k)
      && !/(?:_batches|_priority|_flex|_audio|_image|_video)$/.test(k)
      && typeof item[k] === "number" && item[k] !== 0);
    if (unsupported) continue;
    const parsed = modelRatesSchema.safeParse({ unit: "token", currency: "USD",
      input: perMillion(item.input_cost_per_token), output: perMillion(item.output_cost_per_token),
      cachedInput: typeof item.cache_read_input_token_cost === "number" ? perMillion(item.cache_read_input_token_cost) : null });
    if (parsed.success) rows.set(key, parsed.data);
  }
  if (rows.size < 10) throw new Error("LiteLLM returned an empty or invalid price catalog; existing prices were retained.");
  return rows;
}

/** Match the actual service, never borrow a different provider's price for a same-named model. */
export function automaticCatalogKeys(baseUrl: string, model: string): string[] {
  let hostname: string;
  try { hostname = new URL(baseUrl).hostname.toLowerCase(); } catch { return []; }
  const providers: Record<string, string> = {
    "api.openai.com": "openai", "api.typesafe.ai": "typesafe", "api.deepseek.com": "deepseek",
    "api.deepinfra.com": "deepinfra", "api.groq.com": "groq", "api.fireworks.ai": "fireworks_ai",
    "api.together.xyz": "together_ai", "api.together.ai": "together_ai", "api.studio.nebius.com": "nebius",
    "api.cloudflare.com": "cloudflare", "openrouter.ai": "openrouter",
  };
  const provider = providers[hostname];
  if (!provider) return [];
  return [...new Set([model.startsWith(`${provider}/`) ? model : `${provider}/${model}`, ...(provider === "openai" ? [model] : [])])];
}

export type MeteredCall = {
  id: string; runtimeRef: string | null; provider: string; model: string; operation: string;
  inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null;
  unsupportedUsage: boolean; calls: number;
};

export function meteredCalls(metadata: Record<string, unknown>): MeteredCall[] {
  const usage = record(metadata.usage);
  if (Array.isArray(usage.model_calls) && usage.model_calls.length) return usage.model_calls.map((raw, index) => {
    const call = record(raw);
    const known = call.usage_known === true;
    return { id: typeof call.call_id === "string" && call.call_id ? call.call_id : `unattributed-call-${index}`,
      runtimeRef: typeof call.runtime_ref === "string" ? call.runtime_ref : null,
      provider: typeof call.provider === "string" ? call.provider : "unknown",
      model: typeof call.model === "string" ? call.model : "unknown",
      operation: typeof call.operation === "string" ? call.operation : "unknown",
      inputTokens: known && validCount(call.input_tokens) ? call.input_tokens : null,
      outputTokens: known && validCount(call.output_tokens) ? call.output_tokens : null,
      cachedInputTokens: known && validCount(call.cached_input_tokens) ? call.cached_input_tokens : null,
      unsupportedUsage: call.unsupported_usage === true || Number(call.retries) > 0, calls: 1 };
  });
  const calls = usage.model_invocations;
  return validCount(calls) && calls > 0 ? [{ id: "aggregate", runtimeRef: null, provider: "unknown", model: "unknown", operation: "unknown",
    inputTokens: null, outputTokens: null, cachedInputTokens: null, unsupportedUsage: false, calls }] : [];
}

export function priceCall(call: MeteredCall, rates: ModelRates | null): { amount: number | null; reason: CostReason } {
  if (!rates) return { amount: null, reason: "missing_price" };
  if (rates.unit === "free") return { amount: 0, reason: "priced" };
  if (call.unsupportedUsage) return { amount: null, reason: "unsupported_usage" };
  if (rates.unit === "request") return { amount: call.calls * rates.request / 1000, reason: "priced" };
  if (call.inputTokens === null || call.outputTokens === null) return { amount: null, reason: "missing_usage" };
  const cached = call.cachedInputTokens ?? 0;
  if (cached > call.inputTokens || (cached > 0 && rates.cachedInput === null)) return { amount: null, reason: "unsupported_usage" };
  return { amount: ((call.inputTokens - cached) * rates.input + cached * (rates.cachedInput ?? rates.input) + call.outputTokens * rates.output) / 1_000_000, reason: "priced" };
}
