import { z } from "zod";

const rate = z.number().finite().min(0).max(1_000_000);
export const modelRatesSchema = z.discriminatedUnion("unit", [
  z.object({ unit: z.literal("token"), currency: z.literal("USD"), input: rate, output: rate, cachedInput: rate.nullable().default(null) }),
  z.object({ unit: z.literal("request"), currency: z.literal("USD"), request: rate }),
  z.object({ unit: z.literal("free"), currency: z.literal("USD") }),
]);
/** Token rates are per million; request rates are per thousand. */
export type ModelRates = z.infer<typeof modelRatesSchema>;
export const pricingRuleSchema = z.object({
  mode: z.enum(["automatic", "manual"]),
  catalogKey: z.string().trim().min(1).max(512).nullable().default(null),
  rates: modelRatesSchema.nullable().default(null),
}).superRefine((value, context) => {
  if (value.mode === "manual" && !value.rates) context.addIssue({ code: "custom", path: ["rates"], message: "Manual pricing requires rates." });
  if (value.mode === "automatic" && value.rates) context.addIssue({ code: "custom", path: ["rates"], message: "Automatic pricing cannot contain manual rates." });
});
export type PricingRuleInput = z.infer<typeof pricingRuleSchema>;
export const costQuerySchema = z.object({
  window: z.enum(["month", "7d", "30d"]).default("month"),
  source: z.enum(["all", "runtime", "testing"]).default("all"),
});
export type CostQuery = z.infer<typeof costQuerySchema>;
export type CostReason = "priced" | "missing_price" | "missing_usage" | "unmatched_model" | "unsupported_usage";
export type CostGroup = {
  modelId: string | null; model: string; provider: string; currency: string | null;
  calls: number; inputTokens: number; outputTokens: number; unknownUsage: number;
  cost: number | null; unpriced: number;
};
export type GuardrailCostView = {
  since: string; until: string; meteringSince: string | null; updatedAt: string | null;
  calls: number; inputTokens: number; outputTokens: number; unknownUsage: number; unpriced: number;
  totals: Array<{ currency: string; cost: number }>;
  models: CostGroup[];
  trend: Array<{ day: string; currency: string | null; cost: number | null; calls: number; unpriced: number }>;
};
export type ModelPricingView = {
  modelId: string; model: string; provider: string; mode: "automatic" | "manual";
  catalogKey: string | null; source: "manual" | "litellm" | null; rates: ModelRates | null; effectiveAt: string | null;
};
export type PricingSyncView = {
  sourceUrl: string; catalogVersion: string | null; lastSuccessAt: string | null;
  error: string | null; entries: number; meteringSince: string | null;
};
export type GuardrailMonthlyCost = { currency: "USD"; cost: number | null; calls: number; unpriced: number; since: string; until: string };
