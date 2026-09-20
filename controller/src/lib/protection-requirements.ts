import { isSplitTopicPolicy } from "../../shared/topic-policy";
import type { Policy } from "./api-types";

/** A business/category label is navigation, never an executable dependency. */
export function policyRequiresTopicAllowlist(policy: (Pick<Policy, "id"> & Partial<Pick<Policy, "protection" | "version">>) | undefined): boolean {
  if (!policy || isSplitTopicPolicy(policy.id, policy.version ?? "")) return false;
  if (policy.protection) return policy.protection.requiredContext.includes("allowed_topics");
  return ["builtin-topic-safety", "builtin-company-policy"].includes(policy.id);
}

/** Only executable Topic Control dependencies require a model; category tags do not. */
export function policyRequiresTopicModel(policy: Policy | undefined): boolean {
  return Boolean(policy && isSplitTopicPolicy(policy.id, policy.version)) || policyRequiresTopicAllowlist(policy)
    || Boolean(policy?.protection?.modelCapabilities?.some(capability => capability === "topic_control" || capability === "company_policy"))
    || Boolean(policy?.protection?.evaluationContracts?.some(contract => ["tali.guard.topic-control.semantic.v1", "tali.guard.company-policy.v1"].includes(contract)));
}

/** Correctness checks require their own runtime binding, not the authoring model. */
export function policyCorrectnessCapabilities(policy: Policy | undefined) {
  return (["contextual_grounding", "automated_reasoning"] as const).filter(capability =>
    policy?.id === `builtin-${capability.replaceAll("_", "-")}`
    || policy?.protection?.modelCapabilities?.includes(capability)
    || policy?.protection?.evaluationContracts?.includes(`tali.guard.${capability.replaceAll("_", "-")}.v1`));
}
