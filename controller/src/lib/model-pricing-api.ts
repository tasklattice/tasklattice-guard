import { requestController } from "./controller-api";
import type { CostQuery, GuardrailCostView, ModelPricingView, ModelRates, PricingRuleInput, PricingSyncView } from "../../shared/model-pricing";
export const pricingQueryKey = ["model-pricing"] as const;
export const getModelPrices = () => requestController<{ sync: PricingSyncView; models: ModelPricingView[] }>("/api/v1/model-pricing");
export const saveModelPrice = (id: string, input: PricingRuleInput) => requestController<ModelPricingView>(`/api/v1/models/${encodeURIComponent(id)}/pricing`, { method: "PUT", body: JSON.stringify(input) });
export const searchModelPrices = (q: string) => requestController<{ items: Array<{ key: string; rates: ModelRates }> }>(`/api/v1/model-pricing/catalog?q=${encodeURIComponent(q)}`);
export const getGuardrailCosts = (id: string, query: CostQuery) => requestController<GuardrailCostView>(`/api/v1/guardrails/${encodeURIComponent(id)}/usage-costs?${new URLSearchParams(query)}`);
