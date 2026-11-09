import type { Guardrail } from "@/lib/api";
import { isValidationRunning } from "@/components/validation-run-progress";

export function draftStateKey(guardrail: Guardrail) {
  if (!hasUnpublishedDraft(guardrail)) return "guardrails.releasePublished";
  if (guardrail.published_current) return "guardrails.releasePublished";
  if (guardrail.tested_current) return "guardrails.draftTested";
  if (guardrail.latest_validation_run && guardrail.latest_validation_run.source_draft_version === guardrail.draft_revision) {
    if (isValidationRunning(guardrail.latest_validation_run)) return "guardrails.draftTesting";
    if (guardrail.latest_validation_run.status === "failed") return "guardrails.draftTestFailed";
  }
  return "guardrails.draftUntested";
}

export function hasUnpublishedDraft(guardrail: Guardrail) {
  return guardrail.has_unpublished_changes ?? !guardrail.published_current;
}
