type Selection = { enabledRuleIds: readonly string[]; ruleOrder?: readonly string[] };

/** Append a Profile's missing Rules without reordering existing checks. */
export function appendProfileRules(current: Selection, incoming: Selection): { enabledRuleIds: string[]; ruleOrder: string[] } | null {
  const selected = new Set(current.enabledRuleIds);
  const additions = incoming.enabledRuleIds.filter(id => !selected.has(id));
  if (!additions.length) return null;
  const order = [...new Set([
    ...(current.ruleOrder ?? []), ...current.enabledRuleIds,
    ...(incoming.ruleOrder ?? []).filter(id => additions.includes(id)), ...additions,
  ])];
  return { enabledRuleIds: [...new Set([...current.enabledRuleIds, ...additions])], ruleOrder: order };
}
