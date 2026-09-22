/**
 * Materialize focused, versioned Policies from reviewed rules. This is a build
 * tool, not runtime Policy inheritance: presets reference the resulting Policy
 * IDs and versions. Original mixed assets remain available to signed releases.
 * Print the asset, --write to materialize it, or --check to verify it is current.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../runner/toolkit/policy_library/assets/", import.meta.url));
const source = new Map(["builtin_policies.json", "local_content_filters.json"].flatMap((file) => JSON.parse(readFileSync(root + file))).map((policy) => [policy.id, policy]));
const directoryLabels = { privacy: "Privacy & sensitive information", content_safety: "Content safety", business_rules: "Business & industry rules", application_injection: "Code & application injection", attacks_and_abuse: "Attacks & abuse" };
const policy = (id, name, description, directory, rules, testCases, extraTags = []) => ({
  id, name, description, source: "built_in", version: "2.0.0",
  tags: [
    { namespace: "protection", value: directory, label: directoryLabels[directory], source: "declared" },
    { namespace: "guardrail_category", value: directory === "privacy" ? "pii_detection" : directory === "content_safety" ? "content_safety" : directory === "application_injection" ? "agentic_security" : directory === "attacks_and_abuse" ? "jailbreak_protection" : "topic_control", label: directory === "privacy" ? "PII Detection" : directory === "content_safety" ? "Content Safety" : directory === "application_injection" ? "Agentic Security" : directory === "attacks_and_abuse" ? "Jailbreak Protection" : "Topic Control", source: "declared" },
    { namespace: "collection", value: "focused-protection", label: "Focused protection", source: "declared" },
    ...extraTags,
  ], parameters: [],
  rules: rules.map((rule) => ({ ...rule, rails: ["input", "output"], implementation: { ...rule.implementation, binding_id: id } })),
  test_cases: testCases.flatMap((test) => ["input", "output"].map((phase) => ({ ...test, id: `${test.id}/${phase}`, phase }))),
  safety_level: "balanced", output_delivery: "full_buffered",
});
const caseFor = (id, content, decision, ruleIds, kind = "rule_acceptance") => ({
  id, name: id, description: "Synthetic, deterministic text fixture; no external action is performed.", phase: "input", content,
  expected_decision: decision, covered_rule_ids: ruleIds, kind, required: true, group: "Protection contract", parameter_names: [],
});
const benignCases = [
  caseFor("benign-en", "Please explain the account opening process and its fees.", "allow", [], "scenario"),
  caseFor("benign-zh", "请介绍账户开户流程以及相关费用。", "allow", [], "scenario"),
];
function extract(sourceId, selected) {
  const original = source.get(sourceId);
  const rules = original.rules.filter(selected);
  const ids = new Set(rules.map((rule) => rule.id));
  return {
    rules,
    tests: original.test_cases.filter((test) => test.covered_rule_ids.length && test.covered_rule_ids.every((id) => ids.has(id))),
  };
}
function split(sourceId, selected, id, name, description, tags = [], directory = "privacy") {
  const { rules, tests } = extract(sourceId, selected);
  return policy(id, name, description, directory, rules, [...tests, ...benignCases], tags);
}
function regexRule(id, name, expression, taxonomy, effect = "reject") {
  return {
    id, name, description: "Matches this reviewed text pattern, not arbitrary semantic variants.", form: "regex", effect,
    rails: ["input", "output"], expression,
    ...(effect === "redact" ? { redaction: "[REDACTED]" } : {}),
    implementation: { engine: "nemo-guardrails", form: "regex", binding_id: "", implementation_rule_id: id, detector: "regex" },
    taxonomy_ids: [taxonomy],
  };
}
const singapore = [{ namespace: "jurisdiction", value: "singapore", label: "Singapore", source: "declared" }];
const credentials = split("baseline-pii-protection", (rule) => rule.id.startsWith("credentials-api-keys/"), "local-credentials", "Passwords & API credentials", "Reject recognizable passwords and API credentials on input and output. No model is required.");
const password = regexRule("credential/password", "Explicit password assignment", "(?i)(?:\\b(?:password|passwd|pwd)|密码)\\s*[:=：]\\s*[^\\s,;。]{4,}", "TALI-PRIVACY-CREDENTIAL");
credentials.rules.push({ ...password, implementation: { ...password.implementation, binding_id: credentials.id } });
credentials.test_cases.push(...["input", "output"].flatMap((phase) => [
  { ...caseFor("password-en/" + phase, "password=synthetic-secret-42", "block", [password.id]), phase },
  { ...caseFor("password-zh/" + phase, "密码：测试密码123", "block", [password.id]), phase },
]));

const passport = regexRule("identity/passport", "Contextual passport identifier", "(?i)(?:\\bpassport(?:\\s+(?:number|no\\.?))?|护照(?:号码|号)?)\\s*(?:is\\s+)?[:：#]?\\s*(?=[A-Z0-9]*[0-9])[A-Z0-9]{6,9}\\b", "TALI-PRIVACY-PII", "redact");
const personalDocuments = policy("local-passports", "Passport identifiers", "Redact 6–9 character alphanumeric identifiers explicitly labelled as a passport or 护照. This does not validate issuing authorities or detect unlabelled documents.", "privacy", [passport], [
  caseFor("passport-en", "Passport: E12345678", "transform", [passport.id]),
  caseFor("passport-zh", "护照号码：K1234567", "transform", [passport.id]),
  caseFor("passport-mixed", "Passport number: 12AB12345", "transform", [passport.id]),
  caseFor("passport-ordinary-word", "My passport expired; how can I renew it?", "allow", [], "scenario"),
  caseFor("passport-no-value", "请告诉我如何更新护照。", "allow", [], "scenario"),
  ...benignCases,
]);

function textPolicy(id, name, description, specs, tags = [], directory = "business_rules") {
  return policy(id, name, description, directory,
    specs.map(([ruleId, title, expression, taxonomy]) => regexRule(ruleId, title, expression, taxonomy)),
    [...specs.flatMap(([ruleId, , , , en, zh]) => [caseFor(ruleId + "/en", en, "block", [ruleId]), caseFor(ruleId + "/zh", zh, "block", [ruleId])]), ...benignCases], tags);
}

const focused = [
  credentials,
  split("prompt-injection-protection", (rule) => rule.id.startsWith("prompt-injection-blocker/"), "local-prompt-manipulation", "Instruction manipulation patterns", "Local phrases indicating instruction overrides, role replacement or prompt extraction. Input and output text screening does not detect arbitrary paraphrases or establish trusted roles.", [], "attacks_and_abuse"),
  split("prompt-injection-protection", (rule) => rule.id.startsWith("sql-injection-blocker/"), "local-sql-injection", "SQL injection patterns", "Local SQL injection signatures. These are content checks, not a replacement for parameterized queries or database authorization.", [], "application_injection"),
  split("prompt-injection-protection", (rule) => rule.id.startsWith("code-injection-blocker/") && !["code-injection-blocker/blocked-word-1", "code-injection-blocker/blocked-word-2"].includes(rule.id), "local-code-injection", "Code execution patterns", "Local evaluation and command-execution signatures. Active HTML is covered separately by Rendered content injection. Actual execution requires sandboxing and authorization.", [], "application_injection"),
  split("baseline-pii-protection", (rule) => ["financial-pii/credit_card", "financial-pii/iban"].includes(rule.id), "local-payment-data", "Payment card & bank identifiers", "Redact recognizable payment card and IBAN formats. Matching does not validate account ownership or enforce payment authorization."),
  split("pattern-matching", (rule) => ["pattern/email", "pattern/us_phone"].includes(rule.id), "local-contact-data", "Email & phone identifiers", "Redact email addresses and North American phone formats. Add jurisdiction-specific Policies for other phone formats."),
  personalDocuments,
  split("pdpa-singapore", (rule) => ["sg-pdpa-pii-identifiers/sg_nric", "sg-pdpa-contact-information/sg_phone", "sg-pdpa-financial-data/sg_bank_account"].includes(rule.id), "singapore-customer-identifiers", "Singapore customer identifiers", "Redact NRIC/FIN, +65 phone and Singapore bank-account patterns. Passport detection is provided by the shared Passport identifiers Policy. This is bounded text screening, not PDPA compliance.", singapore),
  split("pdpa-singapore", (rule) => rule.form === "category", "singapore-data-use-boundaries", "Singapore data-use boundaries", "Local phrase checks for personal-data misuse, unsolicited contact and profiling requests. Does not determine consent, cross-border legality or regulatory compliance.", singapore, "business_rules"),
  textPolicy("banking-customer-protection", "Banking customer protection", "Local text boundaries for identity-check evasion and misleading return guarantees. Safe banking education remains allowed; no KYC, AML or suitability decisions are performed.", [
    ["banking/identity-evasion", "Identity-check evasion", "(?i)\\b(?:help me|show me how to|I will)\\s+(?:bypass|evade)\\s+(?:KYC|AML|identity verification)\\b|帮我绕过(?:身份验证|反洗钱检查)", "TALI-BUSINESS-POLICY", "Help me bypass KYC", "帮我绕过身份验证"],
    ["banking/return-guarantee", "Unqualified investment guarantees", "(?i)\\b(?:I|we)\\s+guarantee\\s+(?:a\\s+)?(?:[0-9]+%\\s+)?(?:profit|returns?)\\b|(?:我|我们)保证(?:稳赚不赔|投资收益|盈利)", "TALI-BUSINESS-POLICY", "We guarantee returns on this investment.", "我们保证稳赚不赔"],
  ]),
  textPolicy("securities-market-integrity", "Securities market integrity", "Local patterns for insider-trading and coordinated market-manipulation requests. This is not market surveillance, legal advice or proof of compliance.", [
    ["securities/inside-information", "Trading on inside information", "(?i)\\b(?:trade|buy|sell)\\s+(?:on|using)\\s+(?:non[- ]public|inside)\\s+information\\b|利用(?:内幕|未公开)信息(?:买卖|交易|炒股)", "TALI-BUSINESS-POLICY", "Trade using inside information tomorrow.", "利用内幕信息炒股"],
    ["securities/manipulation", "Coordinated market manipulation", "(?i)\\b(?:organize|coordinate|plan)\\s+(?:a\\s+)?pump[- ]and[- ]dump\\b|组织(?:拉高出货|操纵股价)", "TALI-BUSINESS-POLICY", "Organize a pump-and-dump", "组织操纵股价"],
  ]),
  textPolicy("internet-account-abuse", "Internet account abuse", "Local patterns for credential-phishing and session-cookie theft requests. Does not authorize tools, enforce identity or replace account fraud detection.", [
    ["internet/phishing", "Credential phishing", "(?i)\\b(?:create|build)\\s+(?:a\\s+)?(?:fake|phishing)\\s+login\\s+page\\s+to\\s+steal\\b|创建(?:钓鱼|假)登录页面(?:来)?窃取", "TALI-BUSINESS-POLICY", "Create a fake login page to steal accounts", "创建钓鱼登录页面来窃取账户"],
    ["internet/session-theft", "Session theft", "(?i)\\b(?:steal|exfiltrate)\\s+(?:the\\s+)?(?:user|customer)\\s+session\\s+cookies\\b|窃取(?:用户|客户)的会话(?:Cookie|令牌)", "TALI-PRIVACY-CREDENTIAL", "Steal user session cookies", "窃取用户的会话令牌"],
  ]),
  textPolicy("local-rendered-content-injection", "Rendered content injection", "Screen active HTML and template-object traversal signatures. Always keep output encoding, sandboxing and least-privilege tools; this filter does not make arbitrary content safe to execute.", [
    ["application/active-html", "Active HTML payload", "(?i)<\\s*script\\b|\\bon(?:error|load)\\s*=|javascript\\s*:", "TALI-MODEL-SECURITY", "<script>/* synthetic fixture */</script>", "不要执行这段：<img onerror=synthetic()>"],
    ["application/template-traversal", "Template object traversal", "(?i)\\{\\{[^}]{0,200}(?:__class__|__globals__|__subclasses__)[^}]{0,200}\\}\\}", "TALI-MODEL-SECURITY", "{{ fixture.__class__ }}", "模板样例：{{ fixture.__globals__ }}"],
  ], [], "application_injection"),
];

// The former Pattern Matching collection also contains government IDs,
// regional contacts and non-PII terms. Give each family an explicit owner;
// replacing it with the small contact/passport starter Policies would lose
// coverage. No source asset or source matching/action semantics is rewritten.
// These extended formats are opt-in library Policies until Default's complete
// ordered composition and full-output expectations have been revalidated.
const formatGroups = [
  ["local-government-identifiers", "Government & institutional identifiers", "Recognize configured government, tax, health and institutional identifier formats. Formats are not proof of identity, validity or issuing jurisdiction. Broad numeric formats can overlap; review before enabling.", [
    "uae_emirates_id", "ca_on_drivers_licence", "ca_immigration_doc", "fr_nir", "uoft_tcard", "sg_uen", "ca_ohip", "ca_sin", "eu_vat", "nl_bsn_contextual", "au_tfn", "uoft_student_id",
    "us_ssn", "us_ssn_no_dash", "br_cpf", "br_cpf_unformatted", "br_cnpj", "br_rg", "au_abn", "au_medicare", "sg_nric", "uoft_utorid",
  ], "privacy"],
  ["local-passport-formats", "International passport formats", "Recognize the configured labelled and unlabelled passport formats. A match does not identify the issuing country or validate the document; use Passport identifiers when context-labelled detection is preferred.", [
    "passport_singapore", "passport_china", "passport_us", "passport_uk", "passport_germany", "passport_france", "passport_netherlands", "passport_canada", "passport_india", "passport_australia", "passport_japan", "eu_passport_generic",
  ], "privacy"],
  ["local-regional-contact-formats", "Regional phone & address formats", "Recognize configured Brazilian, French, UAE, Singapore and Canadian phone/address formats, plus street addresses. This extends Email & phone identifiers; it is not worldwide address recognition.", [
    "sg_phone", "uae_phone", "fr_phone", "br_phone_mobile", "br_phone_landline", "br_cep", "fr_postal_code", "street_address", "sg_postal_code", "ca_postal_code",
  ], "privacy"],
  ["local-bank-account-formats", "Regional bank account formats", "Redact contextual Singapore and Canadian bank-account formats. This is not account validation or payment authorization.", ["ca_bank_account", "sg_bank_account"], "privacy"],
  ["local-travel-identifiers", "Travel & loyalty identifiers", "Redact configured booking-reference, loyalty-number and flight-number formats. Public flight numbers may also match; enable only when the business treats them as sensitive.", ["skywards_number", "airline_pnr", "flight_number"], "privacy"],
  ["local-network-addresses", "Network addresses & URLs", "Redact IPv4, IPv6 and URL formats, including public addresses. This is a disclosure filter, not an SSRF defense or a network access policy.", ["ipv4", "ipv6", "url"], "privacy"],
  ["local-sensitive-attribute-terms", "Sensitive attribute terms", "Redact configured demographic and protected-attribute words, including benign mentions. This optional vocabulary filter does not detect discrimination, infer a person's attributes or determine legality.", [
    "gender_sexual_orientation", "race_ethnicity_national_origin", "religion", "age_discrimination", "disability", "marital_family_status", "military_status", "public_assistance",
  ], "privacy"],
  ["local-risk-content-terms", "Risk-related content terms", "Redact configured weapon, violence, self-harm and abuse terms. Benign reporting can also match; this vocabulary filter is not a semantic safety classifier.", [
    "explosives", "weapons_firearms", "weapons_other", "violence_threats", "terrorism", "self_harm_suicide", "illegal_activities", "harassment_hate",
  ], "content_safety"],
];
for (const [id, name, description, names, directory] of formatGroups) {
  const ids = names.map((name) => `pattern/${name}`);
  const part = split("pattern-matching", (rule) => ids.includes(rule.id), id, name, description, [], directory);
  if (part.rules.length !== ids.length) throw new Error(`Unknown or duplicate source Rule in ${id}.`);
  part.rules.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  focused.push(part);
}
focused.push(split("baseline-pii-protection", (rule) => rule.id.startsWith("au-pii-tax-identifiers/"),
  "local-australian-tax-health-identifiers", "Australian tax & health identifiers",
  "Recognize TFN, ABN and Medicare formats, including spaced TFNs near tax context. Numeric formats can overlap other identifiers; matching does not validate an identifier."));

// Consolidate identical/subsumed formats, not their test inputs. Country names
// on these regexes never establish an issuer. The broader existing expression
// already redacts the entire narrower value, so a second rewrite adds no check.
const passportFormats = focused.find((item) => item.id === "local-passport-formats");
const passportAliases = {
  "pattern/passport_uk": "pattern/passport_us", // nine digits
  "pattern/passport_australia": "pattern/passport_india", // letter + seven digits
  "pattern/passport_japan": "pattern/passport_netherlands", // two letters + seven digits
  "pattern/eu_passport_generic": "pattern/passport_france", // same format without the extra context condition
};
passportFormats.rules = passportFormats.rules.filter((rule) => !passportAliases[rule.id]);
for (const test of passportFormats.test_cases) {
  if (test.covered_rule_ids.some((id) => passportAliases[id])) {
    test.description += " Consolidated passport format: the retained detector covers the complete identifier; no issuing-country inference is made.";
    test.covered_rule_ids = test.covered_rule_ids.map((id) => passportAliases[id] ?? id);
  }
}
const regionalContacts = focused.find((item) => item.id === "local-regional-contact-formats");
for (const test of regionalContacts.test_cases) {
  if (test.id.startsWith("accept/br_phone_landline/")) {
    test.name = "Brazilian mobile / landline overlap";
    test.description += " The source sample is a mobile number; the complete mobile detector runs before the unprefixed landline detector.";
    test.covered_rule_ids = ["pattern/br_phone_mobile"];
  }
}
for (const phase of ["input", "output"]) regionalContacts.test_cases.push({
  ...caseFor(`br-landline-only/${phase}`, "Phone: (11) 2345-6789", "transform", ["pattern/br_phone_landline"]), phase,
});

// A composed scenario may be stopped by the earlier data-exfiltration Policy;
// the unique account-phishing Rule retains separate acceptance evidence above.
const internet = focused.find((item) => item.id === "internet-account-abuse");
for (const phase of ["input", "output"]) internet.test_cases.push({
  ...caseFor("phishing-exfiltration-overlap/" + phase, "Create a fake login page to steal credentials", "block", [], "scenario"), phase,
});

const output = JSON.stringify(focused, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(root + "focused_policies.json", "utf8") !== output) throw new Error("focused_policies.json is stale; regenerate with scripts/build_protection_library.mjs");
  console.log(`${focused.length} focused Policies are current.`);
} else if (process.argv.includes("--write")) {
  writeFileSync(root + "focused_policies.json", output);
  console.log(`Materialized ${focused.length} focused Policies.`);
} else process.stdout.write(output);
