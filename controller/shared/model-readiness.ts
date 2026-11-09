import type { CapabilityBindingId } from "./guardrail-catalog.js";

/** Only the evidence needed by design workflows; no providers or platform settings. */
export type ModelReadinessRevision = {
  revision?: number;
  assignments: { bindings: Partial<Record<CapabilityBindingId, string | null>> };
  validationReport: {
    checkedAt: string;
    checks: Array<{ id: string; status: "passed" | "failed" | "skipped"; evidenceKind?: "model-probe" | "nemo-rail-v1" }>;
  } | null;
};
export type ModelReadinessView = {
  models: Array<{ id: string; name: string }>;
  active: ModelReadinessRevision | null;
  activating: ModelReadinessRevision | null;
  draft: ModelReadinessRevision | null;
};

export function modelReadiness(view: ModelReadinessView): ModelReadinessView {
  const revision = (value: ModelReadinessRevision | null): ModelReadinessRevision | null => value && ({
    ...(value.revision === undefined ? {} : { revision: value.revision }),
    assignments: { bindings: { ...value.assignments.bindings } },
    validationReport: value.validationReport && {
      checkedAt: value.validationReport.checkedAt,
      checks: value.validationReport.checks.filter(check => check.id.startsWith("probe:")).map(check => ({
        id: check.id, status: check.status,
        ...(check.evidenceKind ? { evidenceKind: check.evidenceKind } : {}),
      })),
    },
  });
  return { models: view.models.map(({ id, name }) => ({ id, name })), active: revision(view.active), activating: revision(view.activating), draft: revision(view.draft) };
}
