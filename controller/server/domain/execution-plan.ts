type Step = {
  id: string; capability: string; contract_ref: string; phases: string[]; on_unsafe: string;
  trigger: { type: string; step_ref?: string }; parameters: Array<[string, string]>;
};
type Module = Record<string, unknown>;
const modelContracts = new Set([
  "tali.guard.pii.semantic.v1", "tali.guard.topic-control.semantic.v1", "tali.guard.content-safety.v1",
  "tali.guard.jailbreak.v1", "tali.guard.contextual-grounding.v1", "tali.guard.automated-reasoning.v1",
  "tali.guard.taxonomy-normalization.v1", "tali.guard.classifier-review.v1",
]);
const remote = (s: Step) => s.parameters.find(([key]) => key === "execution_dependency")?.[1] === "model"
  || modelContracts.has(s.contract_ref);
const rank = (s: Step) => s.on_unsafe === "block" ? 0 : s.on_unsafe === "transform" ? 1 : 2;
// A conditional local→model chain stays atomic and belongs to the model stage.
const unitRank = (steps: Step[]) => Number(steps.some(remote)) * 3 + Math.min(...steps.map(rank));

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
    ready.sort((a, b) => unitRank(a) - unitRank(b) || steps.indexOf(a[0]!) - steps.indexOf(b[0]!));
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
      const leader = one(members[0]!);
      const independent = (s: Step | undefined) => s && ["block", "allow"].includes(s.on_unsafe)
        && s.trigger.type === "always" && leader && remote(s) === remote(leader) && s.on_unsafe === leader.on_unsafe;
      if ((phase === "input" || parallelOutput) && independent(one(members[0]!))) {
        while (i + members.length < phaseModules.length && independent(one(phaseModules[i + members.length]!))) {
          members.push(phaseModules[i + members.length]!);
        }
      }
      const group = members.length > 1 ? `checks:${phase}:${i}` : null;
      for (const m of members) {
        m.depends_on = [...previous]; m.input_view = "previous_output";
        const stage = steps.some(s => (m.step_ids as string[]).includes(s.id) && remote(s)) ? "model" : "local";
        for (const id of m.step_ids as string[]) {
          const s = steps.find(s => s.id === id)!;
          s.parameters.push(["execution_schedule", "local-first-v2"], [`execution_stage_${phase}`, stage]);
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

/** Rank Mode: preserve authored Policy/Rule order and the content produced by
 * every preceding Transform. Independent read-only checks inside the same
 * content version share a parallel group; Transform-capable steps end the
 * segment. No latency reordering and no cross-segment parallelism. */
export function scheduleRankedChecks<T extends Step>(steps: T[], modules: Module[], parallelOutput = true): void {
  for (const phase of ["input", "output"] as const) {
    const phaseModules = modules.filter(m => m.phase === phase).sort((a, b) =>
      Math.min(...(a.step_ids as string[]).map(id => steps.findIndex(s => s.id === id))) -
      Math.min(...(b.step_ids as string[]).map(id => steps.findIndex(s => s.id === id))));
    const owner = new Map<string, Module>();
    for (const module of phaseModules) for (const id of module.step_ids as string[]) owner.set(id, module);
    const eligible = (module: Module): boolean => {
      const ids = module.step_ids as string[];
      if (ids.length !== 1) return false;
      const step = steps.find(item => item.id === ids[0]);
      if (!step || step.trigger.type !== "always" || !["allow", "block"].includes(step.on_unsafe)) return false;
      const params = Object.fromEntries(step.parameters);
      return params.on_unknown !== "transform";
    };
    let previous: string[] = [];
    let index = 0;
    while (index < phaseModules.length) {
      let end = index + 1;
      if ((phase !== "output" || parallelOutput) && eligible(phaseModules[index]!)) {
        while (end < phaseModules.length && eligible(phaseModules[end]!)) end++;
      }
      const members = phaseModules.slice(index, end);
      const group = members.length > 1 ? `ranked:${phase}:${index}` : null;
      for (const [memberIndex, module] of members.entries()) {
        module.depends_on = [...previous];
        module.input_view = "previous_output";
        for (const id of module.step_ids as string[]) {
          const step = steps.find(item => item.id === id)!;
          step.parameters = step.parameters.filter(([key]) =>
            key !== "execution_schedule" && key !== `execution_stage_${phase}`
            && key !== `parallel_group_${phase}` && key !== `parallel_leader_${phase}`);
          const stage = remote(step) ? "model" : "local";
          step.parameters.push(["execution_schedule", "local-first"], [`execution_stage_${phase}`, stage]);
          if (group) step.parameters.push([`parallel_group_${phase}`, group],
            [`parallel_leader_${phase}`, String(memberIndex === 0)]);
        }
      }
      previous = members.map(module => module.id as string);
      index = end;
    }
  }
  for (const step of steps) {
    step.parameters = step.parameters.filter(([key]) => key !== "evaluation_view");
    step.parameters.push(["evaluation_view", "previous_output"]);
  }
  for (const step of steps) step.parameters = [...new Map(step.parameters)];
}
