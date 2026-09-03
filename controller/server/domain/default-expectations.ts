import type { ValidationExpectationOverride } from "./guardrail-plan.js";

// Reviewed against catalog 1.95.0. These are Default's composition contracts,
// not replacements for Policy acceptance tests or expectations learned from a
// Validation result. A catalog upgrade must explicitly re-review this version.
const VERSION = "1.95.0";
const PATTERN = "pattern-matching";
const BASELINE = "baseline-pii-protection";
const completeRedaction = "The earlier configured Rule covers the complete sensitive value. Assert both its identity and the complete redacted output; do not require a second detection of already-redacted text.";
const firstReject = "The earlier configured Policy rejects this input and terminates the chain. Assert that Policy/Rule and block; the later Rule must not execute.";
const specificFirst = "Default evaluates the complete identifier before broad number/phone patterns. Require full-field redaction, not merely a transform decision.";

type Overrides = Record<string, Record<string, ValidationExpectationOverride>>;

function reviewedExpectations(): Overrides {
  const result: Overrides = {};
  const add = (source: string, caseId: string, target: string, rule: string, output?: string, reason = completeRedaction) => {
    (result[source] ??= {})[caseId] = {
      sourcePolicyVersion: VERSION, reason,
      expectedDecision: output === undefined ? "block" : "transform",
      expectedOutputContent: output ?? "",
      expectedMatches: [{ policyId: target, ruleId: rule }],
    };
  };
  const sample = (name: string) => `Acceptance sample: [${name}_REDACTED]`;

  for (const name of ["harmful-violence", "harmful-self-harm", "harmful-child-safety", "bias-sexual-orientation"]) {
    add(`filter-${name}`, `accept/${name.replaceAll("-", "_")}`, "filter-harm-toxic-abuse", "category/harm_toxic_abuse", undefined, firstReject);
  }
  add("filter-prompt-injection-sql", "accept/prompt_injection_sql", "prompt-injection-protection", "sql-injection-blocker/blocked-word-1", undefined, firstReject);
  add("filter-prompt-injection-system-prompt", "accept/prompt_injection_system_prompt", "prompt-injection-protection", "prompt-injection-blocker/blocked-word-2", undefined, firstReject);

  add(BASELINE, "rule-financial-pii/credit_card-acceptance", BASELINE, "financial-pii/visa", sample("visa"));
  for (const name of ["visa", "mastercard", "amex", "discover", "credit_card"]) {
    const detector = name === "credit_card" ? "visa" : name;
    add(PATTERN, `accept/${name}`, BASELINE, `financial-pii/${detector}`, sample(detector));
  }
  for (const name of ["aws_access_key", "aws_secret_key", "github_token", "slack_token", "generic_api_key"]) {
    add(PATTERN, `accept/${name}`, BASELINE, `credentials-api-keys/${name}`, undefined,
      "Default's earlier Baseline PII Policy rejects credentials before any redaction. A duplicate Pattern acceptance case must assert this rejection, not require the credential to reach a later Rule.");
  }
  for (const [name, detector] of [
    ["passport_uk", "passport_us"], ["passport_australia", "passport_india"],
    ["passport_japan", "passport_netherlands"], ["br_phone_landline", "br_phone_mobile"],
  ] as const) add(PATTERN, `accept/${name}`, PATTERN, `pattern/${detector}`, sample(detector));

  for (const [name, category] of [
    ["religion", "bias_religious"], ["weapons_firearms", "harmful_illegal_weapons"],
    ["explosives", "harmful_illegal_weapons"], ["terrorism", "harmful_violence"],
    ["self_harm_suicide", "harmful_self_harm"],
  ] as const) add(PATTERN, `accept/${name}`, `filter-${category.replaceAll("_", "-")}`, `category/${category}`, undefined, firstReject);

  for (const [name, detector, output] of [
    ["br_cpf_unformatted", "au_abn", sample("au_abn")],
    ["au_tfn", "au_tfn", "Tax file number [au_tfn_REDACTED]."],
    ["au_abn", "au_abn", sample("au_abn")],
    ["au_medicare", "au_medicare", sample("au_medicare")],
    // The leading '+' is punctuation, not a remaining subscriber/country digit.
    ["fr_phone", "au_abn", "Acceptance sample: +[au_abn_REDACTED]"],
    ["uoft_student_id", "au_medicare", "University of Toronto student number [au_medicare_REDACTED]."],
  ] as const) add(PATTERN, `accept/${name}`, BASELINE, `au-pii-tax-identifiers/${detector}`, output);
  for (const name of ["iban", "eu_iban_enhanced"]) add(PATTERN, `accept/${name}`, BASELINE, "financial-pii/iban", sample("iban"));
  add(PATTERN, "accept/eu_passport_generic", PATTERN, "pattern/passport_france", "Acceptance sample: passport [passport_france_REDACTED]");

  // These cases now hit their original Rules after reordering. Strengthen their
  // assertions so an incomplete redaction cannot silently regress to green.
  for (const [name, output] of [
    ["uae_emirates_id", sample("uae_emirates_id")],
    ["ca_on_drivers_licence", "Driver's licence [ca_on_drivers_licence_REDACTED]."],
    ["ca_immigration_doc", "UCI [ca_immigration_doc_REDACTED]."],
    ["ca_bank_account", "Bank account [ca_bank_account_REDACTED]."],
    ["fr_nir", sample("fr_nir")], ["uoft_tcard", "TCard number [uoft_tcard_REDACTED]."],
    ["sg_uen", "Acceptance sample: UEN [sg_uen_REDACTED]"],
    ["eu_vat", "Acceptance sample: VAT [eu_vat_REDACTED]"],
    ["skywards_number", "Acceptance sample: Skywards [skywards_number_REDACTED]"],
    ["nl_bsn_contextual", "Acceptance sample: BSN [nl_bsn_contextual_REDACTED]"],
    ["br_phone_mobile", sample("br_phone_mobile")],
    ["sg_phone", sample("sg_phone")], ["uae_phone", sample("uae_phone")],
    ["passport_china", sample("passport_china")],
  ] as const) add(PATTERN, `accept/${name}`, PATTERN, `pattern/${name}`, output, specificFirst);
  return result;
}

const expectations = reviewedExpectations();

export function defaultTestCaseOverrides(policyId: string): Record<string, ValidationExpectationOverride> {
  return structuredClone(expectations[policyId] ?? {});
}
