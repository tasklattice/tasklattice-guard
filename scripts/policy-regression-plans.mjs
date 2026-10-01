/** Exercise the production Controller compiler for each source Policy package. */
import { readFileSync } from "node:fs";
import { PolicyCatalog } from "../controller/server/policy-catalog/catalog.ts";
import { buildGuardrailPlan } from "../controller/server/domain/guardrail-plan.ts";

const input = JSON.parse(readFileSync(0, "utf8"));
const policies = PolicyCatalog.load(input.assets).list();
const plans = input.jobs.map(({ id, parameters, rules }) => {
  const policy = policies.find(item => item.id === id);
  if (!policy) throw new Error(`Policy ${id} is unavailable`);
  return buildGuardrailPlan({
    guardrailId: `policy-test:${id}`, guardrailVersion: "20260101-000000.000Z", policies,
    draft: {
      allowedTopics: [], restrictedTopics: [], safetyLevel: policy.safety_level,
      outputDelivery: policy.output_delivery,
      policyBindings: [{
        policyId: policy.id, policyVersion: policy.version, action: null,
        parameterValues: parameters, enabledRuleIds: rules,
        ruleOrder: rules, ruleActions: {},
        enabledRails: policy.rails, reasoningPolicy: null,
      }],
    },
  });
});
process.stdout.write(JSON.stringify(plans));
