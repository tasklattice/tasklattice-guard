export const EXPLICIT_VIEWS_PLAN_VERSION = "tasklattice-controller-plan-v16-explicit-views";
export const EXPLICIT_VIEWS_CAPABILITY = "tasklattice.explicit-views";

export function requiresExplicitViews(plan: Record<string, unknown>): boolean {
  return plan.compiler_version === EXPLICIT_VIEWS_PLAN_VERSION;
}
