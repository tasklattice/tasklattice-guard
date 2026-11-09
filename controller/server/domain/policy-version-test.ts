import { createHash } from "node:crypto";
import { canonicalJson } from "../../shared/canonical-json.js";
import { policyBindingParameterIssues } from "../../shared/policy-parameters.js";
import type { DefinitionTest } from "../../shared/policy-definition.js";
import type { PolicyDto } from "../policy-catalog/catalog.js";
import { definitionTestCases } from "../policy-studio/definition-tests.js";
import type { ProgrammablePolicySnapshot } from "../policy-studio/model.js";
import { buildGuardrailPlan, normalizeGuardrailDraft } from "./guardrail-plan.js";
import { materializePolicyRules } from "./policy-rules.js";
import { generatedTestCases } from "./validation.js";
import { publishedProtectionCoverage } from "./protection-readiness.js";
import { ValidationError } from "./errors.js";

export const policyTestDigest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

/** Resolve only the selected immutable surface; never consult an editable draft. */
export function preparePolicyVersionTest(policy: PolicyDto, native?: ProgrammablePolicySnapshot) {
  if (policy.version === "0") throw new ValidationError("Publish this Policy before testing a library version. Draft tests are available in the Policy editor.");
  const definition = policy.definition;
  const parameters = { ...Object.fromEntries(policy.parameters.flatMap(p => p.default == null || p.kind === "secret" ? [] : [[p.name, p.default]])), ...definition?.testing?.parameters };
  if (definition) {
    const issues = policyBindingParameterIssues(definition, parameters, definition.rules.map(rule => rule.id));
    if (issues.length) throw new ValidationError(issues.join("\n"));
  }
  const binding = { policyId: policy.id, policyVersion: policy.version, enabledRuleIds: policy.rules.map(r => r.id), enabledRails: policy.rails, parameterValues: parameters };
  const draft = normalizeGuardrailDraft({ safetyLevel: policy.safety_level, outputDelivery: policy.output_delivery, policyBindings: [binding] });
  const materialized = native ? policy : materializePolicyRules(policy, draft.policyBindings[0]!);
  const nativeCases = native ? generatedTestCases(`policy-preview-${policy.id}`, draft, [], [native]) : [];
  const tests: DefinitionTest[] = definition ? definitionTestCases(definition, parameters) : nativeCases.map(test => ({
    id: test.id, name: test.name, description: "", phase: test.phase, content: test.content, expected_decision: test.expectedDecision,
    covered_rule_ids: test.coveredRuleIds, kind: "scenario", scope: "policy", required: test.required, parameter_names: [], group: test.concurrencyGroup ?? "Policy tests",
    context: { trusted_instruction: test.trustedInstruction, target_source: test.targetSource, query: test.query, grounding_sources: test.groundingSources, expected_reasoning_result: test.expectedReasoningResult },
  }));
  if (!tests.length) throw new ValidationError("This Policy has no executable test cases. Configure its test parameters in the Policy editor.");
  if (definition && tests.some(test => /\{\{[A-Za-z0-9_.-]+\}\}/.test(JSON.stringify(test)))) throw new ValidationError("Some test parameters are unresolved. Configure test parameters in the Policy editor.");
  // Validate fixture context as well as the detector configuration. Acceptance
  // fixtures supplied by the catalog need not repeat optional output assertions.
  if (definition) for (const test of tests) {
    const selected = test.scope === "rule" ? definition.rules.filter(r => test.covered_rule_ids.some(id => id === r.id || id.startsWith(r.id + "/"))) : definition.rules.filter(r => r.stages.includes(test.phase));
    if (selected.some(r => ["model/grounding", "service/formal-verification"].includes(r.detector.ref)) && !test.context?.query.trim()) throw new ValidationError(`Test ${test.name}: a user query is required.`);
    if (selected.some(r => r.detector.ref === "model/grounding") && !test.context?.grounding_sources.some(s => s.trim())) throw new ValidationError(`Test ${test.name}: grounding sources are required.`);
  }
  const groups = new Map<string | null, DefinitionTest[]>();
  for (const test of tests) {
    const rule = test.scope === "rule" ? test.covered_rule_ids[0]! : null;
    groups.set(rule, [...groups.get(rule) ?? [], test]);
  }
  const jobs = [...groups].map(([rule, cases]) => {
    const jobDraft = normalizeGuardrailDraft({ ...draft, policyBindings: [{ ...draft.policyBindings[0]!, enabledRuleIds: rule === null ? materialized.rules.map(r => r.id) : [rule] }] });
    const plan = buildGuardrailPlan({ guardrailId: `policy-preview-${policy.id}`, guardrailVersion: "policy-test", draft: jobDraft, policies: native ? [] : [materialized], programmablePolicies: native ? [native] : [] });
    const testCases = cases.map(test => {
      const original = nativeCases.find(c => c.id === test.id);
      return { ...(original ?? {}), id: test.id, name: test.name, policyId: policy.id, phase: test.phase, content: test.content,
        expectedDecision: test.expected_decision, trustedInstruction: test.context?.trusted_instruction ?? "",
        targetSource: test.context?.target_source ?? (test.phase === "input" ? "user_input" : "model_output"), query: test.context?.query ?? "", groundingSources: test.context?.grounding_sources ?? [],
        expectedReasoningResult: test.context?.expected_reasoning_result ?? null, caseType: test.kind, required: true,
        expectedFailure: original?.expectedFailure ?? null, concurrencyGroup: original?.concurrencyGroup ?? null,
        sourcePolicyId: policy.id, sourcePolicyVersion: policy.version, sourceCaseId: test.id, coveredRuleIds: test.covered_rule_ids };
    });
    return { plan, tests: cases, testCases };
  });
  const requiredBindings = [...new Set(jobs.flatMap(job => publishedProtectionCoverage(job.plan)?.requiredModelBindings ?? []))];
  return { policyId: policy.id, policyName: policy.name, version: policy.version, parameters, tests, jobs, requiredBindings,
    policyDigest: policyTestDigest(native ?? definition ?? policy), testSuiteDigest: policyTestDigest(tests) };
}
export type PreparedPolicyVersionTest = ReturnType<typeof preparePolicyVersionTest>;
