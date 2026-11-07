import type { DefinitionTest, PolicyDefinition } from "../../shared/policy-definition.js";
import { parsePhraseEntries } from "../../shared/phrase-policy.js";

/** Resolve test fixtures from the same parameter contract as the executable Rules. */
export function definitionTestCases(definition: PolicyDefinition, values: Record<string, string>): DefinitionTest[] {
  const render = (text: string) => text.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (match, name: string) => values[name] ?? match);
  return definition.tests.flatMap(test => {
    const rule = test.scope === "rule" ? definition.rules.find(r => r.id === test.covered_rule_ids[0]) : undefined;
    if (rule?.expand && test.content === `{{${rule.expand.parameter}}}`) {
      const configured = values[rule.expand.parameter] ?? "";
      if (!configured.trim()) return [];
      return parsePhraseEntries(configured).map(entry => ({
        ...test, id: `${test.id}/${entry.id}`, name: `${test.name}: ${entry.phrase}`, content: entry.phrase,
        covered_rule_ids: [`${rule.id}/${entry.id}`], expected_decision: entry.action,
        ...(entry.action === "transform" ? { expected_text: entry.replacement } : {}),
      }));
    }
    return [{ ...test, name: render(test.name), content: render(test.content),
      ...(test.expected_text != null ? { expected_text: render(test.expected_text) } : {}),
      ...(test.context ? { context: { ...test.context, trusted_instruction: render(test.context.trusted_instruction), query: render(test.context.query), grounding_sources: test.context.grounding_sources.map(render) } } : {}),
    }];
  });
}
