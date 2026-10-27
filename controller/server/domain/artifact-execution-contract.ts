import type { ArtifactContent } from "./artifact-content.js";

export const PLAN_COMPILER_VERSION = "tasklattice-controller-plan-v16-explicit-views";
export const NEMO_COMPILER_VERSION = "tasklattice-nemo-config-v29-single-contract";
const recovery = "Recompile and publish a new Guardrail version with the current Controller and Runner before activating it.";

/** A load gate for one supported contract, not version negotiation or fallback. */
export function artifactExecutionContractIssue(artifact: Pick<ArtifactContent, "plan" | "compilerVersion" | "actionBindings">): string | null {
  if (artifact.plan.compiler_version !== PLAN_COMPILER_VERSION || artifact.compilerVersion !== NEMO_COMPILER_VERSION) {
    return `artifact_recompile_required: Unsupported Artifact execution contract (plan=${String(artifact.plan.compiler_version)}, compiler=${artifact.compilerVersion}). ${recovery}`;
  }
  for (const [kind, items] of [["Step", artifact.plan.steps ?? []], ["Action", artifact.actionBindings]] as const) {
    if (!Array.isArray(items)) return `artifact_recompile_required: Invalid ${kind} declarations. ${recovery}`;
    for (const item of items) {
      const record = item as { id?: string; parameters?: unknown } | null;
      const views = (Array.isArray(record?.parameters) ? record.parameters : [])
        .filter((entry: unknown) => Array.isArray(entry) && entry[0] === "evaluation_view");
      if (views.length !== 1 || !["original", "previous_output"].includes(views[0][1])) {
        return `artifact_recompile_required: ${kind} ${String(record?.id)} must declare exactly one valid evaluation_view. ${recovery}`;
      }
    }
  }
  return null;
}
