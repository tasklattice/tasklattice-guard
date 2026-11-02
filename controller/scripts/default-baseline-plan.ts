import { resolve } from "node:path";
import { defaultGuardrailDraft, DEFAULT_GUARDRAIL_ID } from "../server/domain/defaults.js";
import { buildGuardrailPlan } from "../server/domain/guardrail-plan.js";
import { isModelIndependent, publishedProtectionCoverage } from "../server/domain/protection-readiness.js";
import { PolicyCatalog } from "../server/policy-catalog/catalog.js";

const policies = PolicyCatalog.load(resolve("../runner/toolkit/policy_library/assets")).list();
const plan = buildGuardrailPlan({
  guardrailId: DEFAULT_GUARDRAIL_ID,
  guardrailVersion: "20261023-000000.001Z",
  draft: defaultGuardrailDraft(policies), policies,
});
if (!isModelIndependent(publishedProtectionCoverage(plan))) throw new Error("Bundled Default must have only known local dependencies.");
process.stdout.write(JSON.stringify(plan));
