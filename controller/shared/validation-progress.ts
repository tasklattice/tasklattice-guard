export type ValidationProgress = {
  phase: "preparing" | "executing" | "finalizing";
  completedCases: number;
  passedCases: number;
  updatedAt: string;
};

/** Redelivered jobs and late stream messages must not move visible progress backwards. */
export function advancesValidationProgress(previous: ValidationProgress | null, next: ValidationProgress, total: number): boolean {
  const phases = ["preparing", "executing", "finalizing"];
  if (!phases.includes(next.phase) || !Number.isInteger(next.completedCases) || !Number.isInteger(next.passedCases)
    || next.completedCases < 0 || next.completedCases > total || next.passedCases < 0 || next.passedCases > next.completedCases) return false;
  if (next.phase === "preparing" && next.completedCases !== 0) return false;
  if (next.phase === "finalizing" && next.completedCases !== total) return false;
  if (!previous) return true;
  return phases.indexOf(next.phase) >= phases.indexOf(previous.phase)
    && next.completedCases >= previous.completedCases && next.passedCases >= previous.passedCases
    && next.completedCases - next.passedCases >= previous.completedCases - previous.passedCases
    && (next.phase !== previous.phase || next.completedCases > previous.completedCases);
}
