import type { PolicyProtection } from "../../shared/protection-map.js";

type Candidate = {
  id: string;
  name: string;
  description: string;
  source: "built_in" | "custom";
  version: string;
  rails: readonly string[];
  protection?: PolicyProtection;
};

/** Recommend the focused, bindable catalog, not retired source collections.
 * This is a projection, never an automatic migration of existing bindings.
 */
export function recommendationCatalog(policies: readonly Candidate[]) {
  return policies
    .filter((policy) => policy.source === "built_in" || policy.version !== "0")
    .map((policy) => ({
      id: policy.id,
      name: policy.name,
      description: policy.description,
      rails: [...policy.rails],
      directory: policy.protection?.directory ?? null,
      execution: policy.protection?.execution ?? "custom",
      model_capabilities: policy.protection?.modelCapabilities.length ? policy.protection.modelCapabilities
        : policy.protection?.execution === "custom" ? null : policy.protection?.modelCapabilities ?? null,
      required_context: policy.protection?.requiredContext.length ? policy.protection.requiredContext
        : policy.protection?.execution === "custom" ? null : policy.protection?.requiredContext ?? null,
      dependencies_complete: Boolean(policy.protection && policy.protection.execution !== "custom"),
      limitations: policy.protection?.limitations ?? ["Custom Policy requirements have not been classified."],
    }));
}

export type RecommendationPolicy = ReturnType<typeof recommendationCatalog>[number];
