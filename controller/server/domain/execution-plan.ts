type Step = {
  id: string; capability: string; contract_ref: string; phases: string[]; on_unsafe: string;
  trigger: { type: string; step_ref?: string }; parameters: Array<[string, string]>;
};
type Module = Record<string, unknown>;
const remote = (s: Step) => /semantic|content-safety|jailbreak|grounding|reasoning/.test(s.contract_ref);
const rank = (s: Step) => s.on_unsafe === "block" ? (remote(s) ? 1 : 0) : s.on_unsafe === "transform" ? 2 : 3;

/** Only compiler-owned detector nodes are reorderable. Custom flows retain
 * their authored dependencies and mutation semantics as a conservative barrier.
 * Trigger chains remain ordered; transformations retain their relative order.
 */
export function scheduleChecks<T extends Step>(steps: T[], modules: Module[], customFlows: boolean, parallelOutput = true): void {
  if (customFlows) return;
  // A module's exact/semantic trigger chain is atomic. Reordering individual
  // nodes could interleave modules and contradict their dependency graph.
  const units: T[][] = [];
  for (const step of steps) {
    const owners = modules.filter(m => (m.step_ids as string[]).includes(step.id));
    const unit = units.find(items => owners.some(m => items.some(s => (m.step_ids as string[]).includes(s.id))));
    if (unit) unit.push(step); else units.push([step]);
  }
  const remaining = [...units], ordered: T[] = [], emitted = new Set<string>();
  const transforms = units.filter(items => items.some(s => s.on_unsafe === "transform"));
  while (remaining.length) {
    const ready = remaining.filter(items => items.every(s => s.trigger.type === "always" || emitted.has(s.trigger.step_ref!) || items.some(x => x.id === s.trigger.step_ref))
      && (!transforms.includes(items) || transforms.slice(0, transforms.indexOf(items)).every(unit => unit.every(s => emitted.has(s.id)))));
    if (!ready.length) throw new Error("Guardrail execution dependencies contain a cycle or missing prerequisite.");
    ready.sort((a, b) => Math.min(...a.map(rank)) - Math.min(...b.map(rank)) || steps.indexOf(a[0]!) - steps.indexOf(b[0]!));
    const next = ready[0]!;
    ordered.push(...next); next.forEach(s => emitted.add(s.id)); remaining.splice(remaining.indexOf(next), 1);
  }
  steps.splice(0, steps.length, ...ordered);
  for (const phase of ["input", "output"]) {
    const phaseModules = modules.filter(m => m.phase === phase).sort((a, b) =>
      Math.min(...(a.step_ids as string[]).map(id => steps.findIndex(s => s.id === id))) -
      Math.min(...(b.step_ids as string[]).map(id => steps.findIndex(s => s.id === id))));
    let previous: string[] = [];
    for (let i = 0; i < phaseModules.length;) {
      const members: Module[] = [phaseModules[i]!];
      const one = (m: Module) => (m.step_ids as string[]).length === 1 ? steps.find(s => s.id === (m.step_ids as string[])[0]) : undefined;
      const independent = (s: Step | undefined) => s && s.on_unsafe === "block" && remote(s) && s.trigger.type === "always";
      if ((phase === "input" || parallelOutput) && independent(one(members[0]!))) {
        while (i + members.length < phaseModules.length && independent(one(phaseModules[i + members.length]!))) {
          members.push(phaseModules[i + members.length]!);
        }
      }
      const group = members.length > 1 ? `checks:${phase}:${i}` : null;
      for (const m of members) {
        m.depends_on = [...previous]; m.input_view = "previous_output";
        for (const id of m.step_ids as string[]) {
          const s = steps.find(s => s.id === id)!;
          s.parameters.push(["execution_schedule", "block-first-v1"]);
          if (group) s.parameters.push([`parallel_group_${phase}`, group], [`parallel_leader_${phase}`, String(m === members[0])]);
        }
      }
      previous = members.map(m => m.id as string); i += members.length;
    }
  }
  // Avoid duplicate direction-independent metadata on input/output bindings.
  for (const s of steps) s.parameters = [...new Map(s.parameters)];
  modules.sort((a, b) => Math.min(...(a.step_ids as string[]).map(id => steps.findIndex(s => s.id === id))) -
    Math.min(...(b.step_ids as string[]).map(id => steps.findIndex(s => s.id === id))));
}
