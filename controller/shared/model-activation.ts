import { z } from "zod";
import { capabilityBindingIds, type CapabilityBindingId } from "./guardrail-catalog.js";

export const partialModelActivationSchema = z.object({
  bindingIds: z.array(z.enum(capabilityBindingIds)).min(1).refine(ids => new Set(ids).size === ids.length, "Duplicate binding"),
  expectedDraftToken: z.string().min(1),
  expectedActiveId: z.string().nullable(),
}).strict();
export type PartialModelActivation = z.infer<typeof partialModelActivationSchema>;

type Assignments = { bindings: Partial<Record<CapabilityBindingId, string | null>> };
type Check = { id: string; status: string; evidenceKind?: string | undefined };
/** Only saved changes with successful per-Rail evidence are eligible. Removal is explicit. */
export function modelBindingChanges(draft: Assignments, active: Assignments | null | undefined, checks: readonly Check[]) {
  return capabilityBindingIds.flatMap(id => {
    const current = active?.bindings[id] ?? null;
    const next = draft.bindings[id] ?? null;
    if (current === next) return [];
    const ready = next === null || checks.some(check => check.id === `probe:${id}:${next}` && check.status === "passed" && check.evidenceKind === "nemo-rail-v1");
    return [{ id, current, next, ready }];
  });
}
