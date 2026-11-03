import { describe, expect, it } from "vitest";
import { automaticCatalogKeys, meteredCalls, parseLiteLLMPrices, priceCall, type MeteredCall } from "./model-pricing-domain.js";
import { pricingRuleSchema } from "../../shared/model-pricing.js";
const call: MeteredCall = { id: "one", runtimeRef: "registered", provider: "provider", model: "small", operation: "judge", inputTokens: 1_000, outputTokens: 100, cachedInputTokens: 200, calls: 1, unsupportedUsage: false };
export const catalogFixture = (price = 2e-7) => Object.fromEntries(Array.from({ length: 12 }, (_, index) => [index === 0 ? "groq/llama-guard-3-8b" : `model-${index}`, { mode: "chat", input_cost_per_token: price, output_cost_per_token: 6e-7 }]));
describe("model cost accounting", () => {
  it("never prices attempts cancelled or timed out before model admission", () => {
    const usage = { model_invocations: 3, model_calls: [
      { call_id: "queued", request_sent: false, result: "timeout" },
      { call_id: "sent", request_sent: true }, { call_id: "legacy" },
    ] };
    const calls = meteredCalls({ usage });
    expect(calls.map(call => call.id)).toEqual(["sent", "legacy"]);
    expect(calls.reduce((sum, call) => sum + priceCall(call, { unit: "request", currency: "USD", request: 3 }).amount!, 0)).toBe(0.006);
    expect(meteredCalls({ usage: { model_invocations: 1, model_calls: [{ request_sent: false }] } })).toEqual([]);
  });
  it("reads standard rates without confusing batch prices with synchronous text prices", () => {
    const prices = parseLiteLLMPrices({ ...catalogFixture(), standard: { mode: "chat", input_cost_per_token: 0.15e-6, output_cost_per_token: 0.6e-6, cache_read_input_token_cost: 0.075e-6, input_cost_per_token_batches: 0.075e-6 }, invalid: { mode: "chat", input_cost_per_token: -1, output_cost_per_token: 0 }, tiered: { mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 1e-6, input_cost_per_token_above_128k_tokens: 2e-6 } });
    expect(prices.get("standard")).toEqual({ unit: "token", currency: "USD", input: 0.15, output: 0.6, cachedInput: 0.075 });
    expect(prices.has("invalid")).toBe(false); expect(prices.has("tiered")).toBe(false);
    expect(() => parseLiteLLMPrices({ error: "unavailable" })).toThrow("existing prices were retained");
  });
  it("only matches the actual provider and permits explicit alias mapping elsewhere", () => {
    expect(automaticCatalogKeys("https://api.groq.com/openai/v1", "llama-guard-3-8b")).toEqual(["groq/llama-guard-3-8b"]);
    expect(automaticCatalogKeys("https://internal.example/v1", "llama-guard-3-8b")).toEqual([]);
    expect(automaticCatalogKeys("https://api.groq.com.evil.example", "llama-guard-3-8b")).toEqual([]);
  });
  it("calculates cached input, request and explicit free prices while keeping unknowns distinct", () => {
    expect(priceCall(call, { unit: "token", currency: "USD", input: 2, output: 4, cachedInput: 1 })).toEqual({ reason: "priced", amount: 0.0022 });
    expect(priceCall(call, null)).toEqual({ reason: "missing_price", amount: null });
    expect(priceCall({ ...call, inputTokens: null }, { unit: "token", currency: "USD", input: 2, output: 4, cachedInput: 1 }).reason).toBe("missing_usage");
    expect(priceCall(call, { unit: "token", currency: "USD", input: 2, output: 4, cachedInput: null }).reason).toBe("unsupported_usage");
    expect(priceCall({ ...call, inputTokens: null }, { unit: "request", currency: "USD", request: 3 }).amount).toBe(0.003);
    expect(priceCall({ ...call, inputTokens: null }, { unit: "free", currency: "USD" }).amount).toBe(0);
  });
  it("rejects non-USD manual rates", () => {
    expect(pricingRuleSchema.safeParse({ mode: "manual", rates: { unit: "request", currency: "CNY", request: 3 } }).success).toBe(false);
  });
  it("does not mistake absent usage or retried requests for a known zero-token call", () => {
    expect(meteredCalls({ usage: { model_calls: [{ input_tokens: 0, output_tokens: 0 }] } })[0]?.inputTokens).toBeNull();
    expect(meteredCalls({ usage: { model_calls: [{ usage_known: true, input_tokens: 0, output_tokens: 0, retries: 1 }] } })[0]).toMatchObject({ inputTokens: 0, unsupportedUsage: true });
    expect(meteredCalls({ usage: { model_calls: [], model_invocations: 3 } })[0]).toMatchObject({ calls: 3, inputTokens: null });
    expect(meteredCalls({ usage: { model_invocations: 0 } })).toEqual([]);
    expect(pricingRuleSchema.safeParse({ mode: "manual", rates: { unit: "token", currency: "USD", input: -1, output: 1 } }).success).toBe(false);
  });
});
