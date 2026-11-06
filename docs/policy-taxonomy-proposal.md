# Policy Taxonomy Proposal

Status: proposal for review. No Policy, Rule, Profile or UI code was changed.

## Design rule

A Policy is a protection/compliance topic, not an industry. The target layers are:

```text
Rule          atomic detector/action/test resource
Policy        topic + jurisdiction/framework + ordered Rule bindings
Profile       industry/use-case composition + parameter packs
```

Industry is not a Policy category. Bank, Securities, Internet and Claims are Profiles.

## Proposed top-level categories

| Category | What it contains |
|---|---|
| `payment_data` | Card numbers, IBAN, bank accounts, payment identifiers |
| `contact_data` | Email, phone, names, addresses, postal codes |
| `identity_documents` | Passports, national IDs, tax IDs, health IDs, business IDs |
| `credentials_secrets` | API keys, passwords, tokens, private keys |
| `sensitive_attributes` | Protected-class and sensitive attribute terms |
| `network_identifiers` | IP addresses and URLs |
| `privacy` | Semantic PII model capability |
| `content_safety` | Harmful content, insults, bias, risk content terms |
| `prompt_attacks` | Jailbreak, prompt injection, indirect/memory attacks |
| `application_injection` | SQL, code, HTML and template injection |
| `fraud_account_abuse` | Identity evasion, code/credential theft, phishing, session theft |
| `financial_misconduct` | Misleading return guarantees, insider information, market manipulation |
| `business_topics` | Allowed/denied topics and professional advice |
| `content_filters` | Keyword, phrase and competitor filters |
| `answer_reliability` | Grounding and formal reasoning |
| `regional_compliance` | SG PDPA, EU AI Act, UAE content standards and future MAS/PIPL controls |

## Proposed Policy catalog

| Category | Policy | Source Policies | Region / framework | Source Rules |
|---|---|---|---|---:|
| `answer_reliability` | Answer Reliability | builtin-automated-reasoning, builtin-contextual-grounding | Global | 2 |
| `application_injection` | Application Injection | block-code-execution, local-injection-protection | China mainland; Global | 19 |
| `business_topics` | Business Topics & Advice | builtin-topic-safety, local-professional-advice | Global | 5 |
| `contact_data` | Contact Data | local-contact-data | Australia; China mainland; European Union; Singapore; United Arab Emirates; GDPR; PIPL (China); Singapore PDPA | 21 |
| `content_filters` | Content Filters | competitor-mention-detection, configured-phrase-filter, keyword-blocking | Global | 3 |
| `content_safety` | Content Safety (Local) | local-content-safety | Australia; United Arab Emirates | 14 |
| `content_safety` | Content Safety (Model) | builtin-content-safety | Global | 1 |
| `credentials_secrets` | Credentials & Secrets | local-credentials | Australia | 18 |
| `financial_misconduct` | Financial Market Misconduct | local-fraud-prevention | China mainland; JR/T 0221-2021 | 4 |
| `fraud_account_abuse` | Fraud & Account Abuse | local-fraud-prevention | China mainland; JR/T 0221-2021 | 6 |
| `identity_documents` | Identity Documents | local-government-identifiers, local-passports | Australia; China mainland; European Union; Singapore; United Arab Emirates; GDPR; PIPL (China); Singapore PDPA | 37 |
| `network_identifiers` | Network Identifiers | local-network-addresses | Australia | 3 |
| `privacy` | PII (Semantic) | builtin-pii | Global | 1 |
| `payment_data` | Payment Data | local-payment-data | Australia; China mainland; European Union; Singapore; United Arab Emirates; GDPR; PIPL (China); Singapore PDPA | 10 |
| `prompt_attacks` | Prompt & Instruction Attacks | builtin-indirect-prompt-injection, builtin-jailbreak, builtin-jailbreak-strict, builtin-memory-poisoning, local-injection-protection | China mainland; Global | 26 |
| `regional_compliance` | Regional Compliance: EU AI Act | local-prohibited-practices | European Union; EU AI Act | 10 |
| `regional_compliance` | Regional Compliance: SG PDPA | local-data-use-boundaries | Singapore; Singapore PDPA | 5 |
| `regional_compliance` | Regional Compliance: UAE Content Standards | local-content-safety | United Arab Emirates | 2 |
| `content_safety` | Risk Content Terms | local-risk-content-terms | Global | 8 |
| `sensitive_attributes` | Sensitive Attributes | local-sensitive-attribute-terms | Australia | 8 |

### Profile-owned packs (not Policies)

| Profile pack | Rules | Source Policies |
|---|---:|---|
| Claims Profile | 5 | local-data-use-boundaries, local-fraud-prevention, local-injection-protection, local-professional-advice |

## Summary

- Policy proposals: **20**
- Profile-owned packs: **1** (`Claims Profile`, 5 Rules)
- Source Rules mapped: **208** (203 Policy-bound + 5 Claims Profile)
- Overlap groups: **33**

## Rule count impact

Reclassification and Rule consolidation are separate steps.

| Step | Rule resources |
|---|---:|
| Current source Rules | 208 |
| Reclassify/move only, no merge | 208 |
| Remove the two exact duplicate groups | 206 |
| Conservative overlap consolidation | **~189-190** |
| Aggressive family folding of every overlap group | ~100 |

The conservative target assumes only clearly redundant resources are merged:

- 2 exact duplicate records (jailbreak variant; topic role variant may stay separate)
- Passport India/Australia shared detector: -1
- Australian TFN duplicate: -1
- US SSN formatted/no-dash: -1
- Brazilian CPF formatted/unformatted: -1
- Generic card + four brand Rules: -4, only if coverage tests prove the generic Rule covers them
- Generic IBAN + enhanced IBAN: -1
- EU AI Act English/French article pairs: -5
- Toxicity language variants: -3

This is an estimate, not a commitment. The exact count depends on whether the merged
Rule still preserves spans, evidence, action and test behavior.

The aggressive ~100 figure is **not recommended**. It would fold families such as all
prompt keywords, all passports and all credentials into single Rules, reducing
resource count while losing granular Rule evidence and making failures harder to
attribute.

Also note: merging patterns into one Rule does not necessarily reduce the number of
actual detector evaluations. If one Rule carries 22 alternatives, the Rule count
falls but the runtime may still test 22 patterns. The real performance gain comes
only from removing genuinely redundant detection work.

## Rules by proposed category

| Category | Rules |
|---|---:|
| `identity_documents` | 37 |
| `prompt_attacks` | 26 |
| `content_safety` | 23 |
| `contact_data` | 21 |
| `application_injection` | 19 |
| `credentials_secrets` | 18 |
| `regional_compliance` | 17 |
| `payment_data` | 10 |
| `sensitive_attributes` | 8 |
| `fraud_account_abuse` | 6 |
| `business_topics` | 5 |
| `financial_misconduct` | 4 |
| `content_filters` | 3 |
| `network_identifiers` | 3 |
| `answer_reliability` | 2 |
| `privacy` | 1 |

## Policy-internal overlap handling

The target invariant is: **no two Rules inside the same Policy should match the same content span unless a reviewed fallback contract says so**.
The proposal handles known overlap as follows:

| Policy | Overlap | Proposed treatment |
|---|---|---|
| Payment Data | Generic card vs Visa/Mastercard/Amex/Discover; generic IBAN vs enhanced IBAN | Merge into canonical `payment/card-number` and `payment/iban` Rules; brand/format becomes detector metadata or context. |
| Contact Data | International phone vs country phones; titled/labelled/list names; street/structured/truncated addresses | Merge each family into one Rule with locale/context metadata; postal codes and email remain distinct. |
| Identity Documents | TFN twice; SSN formatted/no-dash; CPF formatted/unformatted; passport India/Australia; generic vs country passport; UofT aliases | Merge variants into one Rule per identifier family; keep country/format metadata. |
| Credentials & Secrets | Generic API key vs provider keys; private-key header vs base64 PEM; password variants | Use one generic fallback Rule plus context-specific variants only where they are mutually exclusive. |
| Sensitive Attributes | No known exact overlap | Keep one Rule per protected class; validate spans. |
| Network Identifiers | URL may contain an IP address | Declare URL/IP precedence or make URL detection not re-match the IP span. |
| Content Safety (Local) | Insult/toxicity/bias; language variants of toxicity; UAE rules vs bias | Merge language variants into the toxicity Rule; move UAE rules to UAE regional compliance. |
| Risk Content Terms | Transform terms overlap block categories in Content Safety | Keep as a separate Policy; define cross-Policy precedence in Profile composition/tests. |
| Prompt & Instruction Attacks | Individual blocked words vs category Rules; CN localized variants | Merge into prompt-attack Rule families; locale patterns become metadata. |
| Application Injection | Code execution vs execution request; SQL/code/HTML/template families | Merge code execution variants; keep SQL, code and markup as separate Rule families. |
| Fraud & Account Abuse | Bank vs CN identity evasion; verification-code vs credential solicitation | Merge locale/semantic variants; keep one Rule per fraud signal. |
| Financial Market Misconduct | Banking vs CN return guarantee; language variants | Merge locale variants; keep return guarantee, insider trading and manipulation separate. |
| Business Topics & Advice | Topic denylist/allowlist; professional advice Rules | Keep roles inside one Policy; no duplicate detector ownership. |
| Content Filters | Keyword, phrase, competitor | Distinct configured controls; no internal overlap by construction. |
| Answer Reliability | Grounding vs formal reasoning | Distinct model contracts; no overlap. |
| SG PDPA | Five distinct obligations | No internal overlap; claims PHI moves to Claims Profile. |
| EU AI Act | English/French variants of same Art. 5 practice | Merge language variants into one Rule per practice. |
| UAE Content Standards | Cultural sensitivity vs anti-discrimination | Keep separate Rules; review overlap on bias terms. |

### Cross-Policy overlap

Some overlaps are deliberately left *across* Policies rather than inside one Policy:

- `PII (Semantic)` vs `Contact Data` / `Identity Documents` / `Payment Data`
- `Content Safety (Local)` vs `Risk Content Terms`
- `Content Safety (Model)` vs `Content Safety (Local)`
- `Regional Compliance: UAE Content Standards` vs the global content-safety rules

These must have explicit precedence and justification in any Profile that selects both.
A Profile must not silently select two Policies whose Rules detect the same span with
different actions.

## MAS / PIPL / regional compliance treatment

Region and framework are attributes on a Policy, not a reason to duplicate every
data-type Rule.

- Generic identifiers stay in `Identity Documents`, `Contact Data`, `Payment Data`
  and `Credentials & Secrets` with `jurisdiction` and `framework` tags.
- Create a `Regional Compliance` Policy only when there is an executable obligation
  that is not covered by a generic data-type Rule, for example consent, retention,
  transfer, profiling or data-use boundaries.
- SG PDPA is executable today and maps to `Regional Compliance: SG PDPA`.
- EU AI Act Art. 5 is executable today and maps to `Regional Compliance: EU AI Act`.
- A future MAS resident-information or CN PIPL control should become a
  `Regional Compliance` Policy only when it has real Rules and tests. Otherwise it
  belongs in Profile compliance metadata, not in a fake Policy.

## Industry-specific treatment

| Current source | Destination |
|---|---|
| Bank / Securities / Internet Profiles | Stay Profiles, removed from Policy categories |
| `local-fraud-prevention` banking/securities Rules | Generic fraud or Financial Market Misconduct Policy |
| `local-fraud-prevention` claims Rules | Claims Profile parameter pack |
| `local-data-use-boundaries` claims PHI | Claims Profile parameter pack |
| `local-professional-advice` claims medical | Claims Profile parameter pack |
| `local-injection-protection` claims system override | Claims Profile parameter pack |
| Future MAS resident-information / CN PIPL controls | Regional Compliance or Profile pack, only if executable rules exist |

## Rule-level mapping

The full 208-row mapping is in [policy-rule-mapping.csv](policy-rule-mapping.csv).
Columns: current Policy, current topic, region/framework, Rule ID, action, new category,
new Policy, disposition (`keep`, `merge`, `move`, `split`, `profile`), overlap group and note.

## Profile catalog after compression

Rule compression changes the number of backing Rules, not the number of Profiles.
Profile count is a product decision.

### Minimum required Profiles

| Profile | Purpose | Model dependency |
|---|---|---|
| `Default` | Local-only baseline; must remain model-independent | **No model** |
| `Full-feature` | Benchmark/regression profile; maximum Policy and Rule coverage | All local + model capabilities |
| `Singapore Bank` | SG banking and MAS/PDPA-oriented composition | Configurable; model optional |
| `China Financial Services` | CN bank + securities umbrella | Configurable; model optional |
| `China Internet` | CN internet platform support | Configurable; model optional |

This is **5 Profiles total**: 2 mandatory baselines + 3 industry Profiles.

### If China Bank and China Securities must be separate

Keep SG Bank and China Internet, then split the CN financial Profile:

| Profile | Industry | Jurisdiction |
|---|---|---|
| `Singapore Bank` | banking | SG |
| `China Bank` | banking | CN |
| `China Securities` | securities | CN |
| `China Internet` | internet | CN |

This is **6 Profiles total**: 2 baselines + 4 industry Profiles.

### Claims

`Claims Profile` was proposed to hold the 5 insurance-claims-specific Rules.
It is not one of the requested 2-3 industry Profiles.

Options:

1. Add `Claims` as a sixth/seventh Profile if insurance claims is a target segment.
2. Keep the 5 claims Rules in the `Full-feature` benchmark only until a Claims
   Profile is approved.
3. Fold claims-specific parts into a future `Insurance` Profile rather than
   exposing a Claims Policy.

### Composition direction

| Profile | Composition direction |
|---|---|
| Default | Local-only privacy, contact, identity, payment, credentials, fraud, prompt/application injection, content safety, content filters, answer reliability local components. **No model Policies.** |
| Full-feature | All 20 Policies and all Rules, including model-dependent PII, content safety, jailbreak, grounding and formal reasoning. Benchmark only. |
| Singapore Bank | Payment Data + Contact Data + Identity Documents + Credentials + Fraud & Account Abuse + Financial Market Misconduct + SG PDPA/MAS compliance where executable |
| China Financial Services | Payment Data + Contact Data + Identity Documents + Credentials + Fraud & Account Abuse + Financial Market Misconduct + CN PIPL/JR-T compliance where executable |
| China Internet | Contact Data + Payment Data + Credentials + Fraud & Account Abuse + Prompt & Instruction Attacks + Application Injection + Content Filters + CN privacy compliance where executable |

### Profile metadata

Each Profile should declare:

```text
id
name
industry              # banking, securities, internet, general
jurisdictions          # SG, CN, ...
frameworks             # MAS, PDPA, PIPL, JR/T ...
requiresModels         # false for Default
benchmarkOnly          # true for Full-feature
policyBindings         # pinned Policy versions
parameterPacks         # industry phrase packs
tests                  # Profile regression suite
```

`Full-feature` must be marked `benchmarkOnly=true`; it is not a production
recommendation. `Default` must be validated to have zero model dependencies.
## Open decisions before implementation

1. Should `PII (Semantic)` stay a separate Policy from local contact/identity/payment Policies?
2. Should `Risk Content Terms` remain a separate transform Policy from `Content Safety (Local)`?
3. Should Claims be a new Profile, or a parameter pack reused by Bank/Insurance Profiles?
4. Should `UAE Content Standards` be a regional-compliance Policy or a content-safety Policy with a UAE tag?
5. Should the two jailbreak model Policies remain separate (one strict variant) or merge into one Policy with a strict parameter?
6. Should CN banking and CN securities be one `China Financial Services` Profile (5 total) or two Profiles (6 total)?
7. Is insurance claims a target segment requiring a Claims Profile, or should those 5 Rules stay in the Full-feature benchmark only?

## Computed overlap groups

| Group | Source Rules |
|---|---|
| `app/code` | `local-injection-protection/code-injection-blocker/blocked-word-3`<br>`local-injection-protection/code-injection-blocker/blocked-word-4`<br>`local-injection-protection/code-injection-blocker/blocked-word-5`<br>`local-injection-protection/code-injection-blocker/blocked-word-6`<br>`local-injection-protection/code-injection-blocker/blocked-word-7`<br>`local-injection-protection/code-injection-blocker/blocked-word-1`<br>`local-injection-protection/code-injection-blocker/blocked-word-2` |
| `app/markup` | `local-injection-protection/application/active-html`<br>`local-injection-protection/application/template-traversal` |
| `app/sql` | `local-injection-protection/sql-injection-blocker/blocked-word-1`<br>`local-injection-protection/sql-injection-blocker/blocked-word-2`<br>`local-injection-protection/sql-injection-blocker/blocked-word-3`<br>`local-injection-protection/sql-injection-blocker/blocked-word-4`<br>`local-injection-protection/sql-injection-blocker/blocked-word-5`<br>`local-injection-protection/sql-injection-blocker/blocked-word-6`<br>`local-injection-protection/sql-injection-blocker/blocked-word-7`<br>`local-injection-protection/sql-injection-blocker/blocked-word-8` |
| `attacks/jailbreak-model` | `builtin-jailbreak/model/jailbreak`<br>`builtin-jailbreak-strict/model/jailbreak` |
| `attacks/prompt-instruction` | `local-injection-protection/prompt-injection-blocker/blocked-word-1`<br>`local-injection-protection/prompt-injection-blocker/blocked-word-2`<br>`local-injection-protection/prompt-injection-blocker/blocked-word-3`<br>`local-injection-protection/prompt-injection-blocker/blocked-word-4`<br>`local-injection-protection/prompt-injection-blocker/blocked-word-5`<br>`local-injection-protection/prompt-injection-blocker/blocked-word-6`<br>`local-injection-protection/prompt-injection-blocker/blocked-word-7`<br>`local-injection-protection/prompt-injection-blocker/blocked-word-8`<br>`local-injection-protection/prompt-injection-blocker/blocked-word-9`<br>`local-injection-protection/prompt-injection-blocker/blocked-word-10`<br>`local-injection-protection/prompt-injection-blocker/blocked-word-11`<br>`local-injection-protection/prompt-injection-blocker/blocked-word-12`<br>`local-injection-protection/prompt-injection-blocker/blocked-word-13`<br>`local-injection-protection/prompt-injection-blocker/blocked-word-14`<br>`local-injection-protection/category/prompt_injection_jailbreak`<br>`local-injection-protection/category/prompt_injection_data_exfiltration`<br>`local-injection-protection/category/prompt_injection_sql`<br>`local-injection-protection/category/prompt_injection_malicious_code`<br>`local-injection-protection/category/prompt_injection_system_prompt`<br>`local-injection-protection/cn-prompt-security/instruction-override`<br>`local-injection-protection/cn-prompt-security/prompt-extraction`<br>`local-injection-protection/cn-prompt-security/unrestricted-mode` |
| `business/professional-advice` | `local-professional-advice/category/denied_financial_advice`<br>`local-professional-advice/category/denied_legal_advice`<br>`local-professional-advice/category/denied_medical_advice` |
| `business/topic-classification` | `builtin-topic-safety/topic/denylist`<br>`builtin-topic-safety/topic/allowlist` |
| `claims` | `local-data-use-boundaries/claims-phi-disclosure-filter/claims_phi_disclosure`<br>`local-injection-protection/claims-system-override-filter/claims_system_override`<br>`local-professional-advice/claims-medical-advice-filter/claims_medical_advice` |
| `contact/address` | `local-contact-data/pattern/truncated_address`<br>`local-contact-data/pattern/structured_address`<br>`local-contact-data/pattern/street_address`<br>`local-contact-data/uae-data-protection-pii/uae_po_box` |
| `contact/person-name` | `local-contact-data/pattern/titled_person`<br>`local-contact-data/pattern/contact_list_person`<br>`local-contact-data/pattern/labelled_person` |
| `contact/phone` | `local-contact-data/pattern/international_phone`<br>`local-contact-data/pattern/sg_phone`<br>`local-contact-data/pattern/uae_phone`<br>`local-contact-data/pattern/fr_phone`<br>`local-contact-data/pattern/br_phone_mobile`<br>`local-contact-data/pattern/br_phone_landline`<br>`local-contact-data/pattern/us_phone`<br>`local-contact-data/cn-personal-information/mainland-mobile` |
| `contact/postal-code` | `local-contact-data/pattern/br_cep`<br>`local-contact-data/pattern/fr_postal_code`<br>`local-contact-data/pattern/sg_postal_code`<br>`local-contact-data/pattern/ca_postal_code` |
| `content/toxicity` | `local-content-safety/nsfw-filter-spanish/harm_toxic_abuse_es`<br>`local-content-safety/nsfw-filter-french/harm_toxic_abuse_fr`<br>`local-content-safety/nsfw-filter-german/harm_toxic_abuse_de`<br>`local-content-safety/nsfw-filter-australian/harm_toxic_abuse_au` |
| `credential/password` | `local-credentials/credential/password`<br>`local-credentials/credential/url-password`<br>`local-credentials/credential/basic-auth`<br>`local-credentials/credential/sql-password`<br>`local-credentials/credential/command-password` |
| `credential/private-key` | `local-credentials/credential/private-key-header`<br>`local-credentials/credential/jwt`<br>`local-credentials/credential/private-jwk`<br>`local-credentials/credential/nkey-seed`<br>`local-credentials/credential/base64-private-key` |
| `credential/token` | `local-credentials/credentials-api-keys/aws_access_key`<br>`local-credentials/credentials-api-keys/aws_secret_key`<br>`local-credentials/credentials-api-keys/github_token`<br>`local-credentials/credentials-api-keys/slack_token`<br>`local-credentials/credentials-api-keys/generic_api_key`<br>`local-credentials/credential/bearer-token`<br>`local-credentials/credential/hex-token` |
| `fraud/credential-theft` | `local-fraud-prevention/cn-banking/verification-code-theft`<br>`local-fraud-prevention/cn-banking/sensitive-credential-solicitation` |
| `fraud/identity-evasion` | `local-fraud-prevention/banking/identity-evasion`<br>`local-fraud-prevention/cn-banking/identity-check-evasion` |
| `identity/au-tfn` | `local-government-identifiers/au-pii-tax-identifiers/au_tfn`<br>`local-government-identifiers/pattern/au_tfn` |
| `identity/br-cpf` | `local-government-identifiers/pattern/br_cpf`<br>`local-government-identifiers/pattern/br_cpf_unformatted` |
| `identity/passport` | `local-passports/pattern/passport_singapore`<br>`local-passports/pattern/passport_china`<br>`local-passports/pattern/passport_us`<br>`local-passports/pattern/passport_germany`<br>`local-passports/pattern/passport_france`<br>`local-passports/pattern/passport_netherlands`<br>`local-passports/pattern/passport_canada`<br>`local-passports/pattern/passport_india`<br>`local-passports/identity/passport`<br>`local-passports/international-pii-identifiers/passport_uk`<br>`local-passports/international-pii-identifiers/passport_japan`<br>`local-passports/pattern/passport_australia` |
| `identity/uoft` | `local-government-identifiers/pattern/uoft_tcard`<br>`local-government-identifiers/pattern/uoft_student_id`<br>`local-government-identifiers/pattern/uoft_utorid` |
| `identity/us-ssn` | `local-government-identifiers/pattern/us_ssn`<br>`local-government-identifiers/pattern/us_ssn_no_dash` |
| `payment/bank-account` | `local-payment-data/pattern/ca_bank_account`<br>`local-payment-data/pattern/sg_bank_account`<br>`local-payment-data/cn-personal-information/unionpay-card` |
| `payment/card-number` | `local-payment-data/financial-pii/credit_card`<br>`local-payment-data/financial-pii/visa`<br>`local-payment-data/financial-pii/mastercard`<br>`local-payment-data/financial-pii/amex`<br>`local-payment-data/financial-pii/discover` |
| `payment/iban` | `local-payment-data/financial-pii/iban`<br>`local-payment-data/pattern/eu_iban_enhanced` |
| `regional/eu-ai-act/biometric_profiling` | `local-prohibited-practices/eu-ai-act-art5-biometric-profiling/eu_ai_act_art5_biometric_profiling`<br>`local-prohibited-practices/eu-ai-act-art5-biometric-profiling-fr/eu_ai_act_art5_biometric_profiling_fr` |
| `regional/eu-ai-act/emotion_recognition` | `local-prohibited-practices/eu-ai-act-art5-emotion-recognition/eu_ai_act_art5_emotion_recognition`<br>`local-prohibited-practices/eu-ai-act-art5-emotion-recognition-fr/eu_ai_act_art5_emotion_recognition_fr` |
| `regional/eu-ai-act/manipulation` | `local-prohibited-practices/eu-ai-act-art5-manipulation/eu_ai_act_art5_manipulation`<br>`local-prohibited-practices/eu-ai-act-art5-manipulation-fr/eu_ai_act_art5_manipulation_fr` |
| `regional/eu-ai-act/social_scoring` | `local-prohibited-practices/eu-ai-act-art5-social-scoring/eu_ai_act_art5_social_scoring`<br>`local-prohibited-practices/eu-ai-act-art5-social-scoring-fr/eu_ai_act_art5_social_scoring_fr` |
| `regional/eu-ai-act/vulnerability` | `local-prohibited-practices/eu-ai-act-art5-vulnerability/eu_ai_act_art5_vulnerability`<br>`local-prohibited-practices/eu-ai-act-art5-vulnerability-fr/eu_ai_act_art5_vulnerability_fr` |
| `regional/sg-pdpa` | `local-data-use-boundaries/sg-pdpa-personal-identifiers/sg_pdpa_personal_identifiers`<br>`local-data-use-boundaries/sg-pdpa-sensitive-data/sg_pdpa_sensitive_data`<br>`local-data-use-boundaries/sg-pdpa-do-not-call/sg_pdpa_do_not_call`<br>`local-data-use-boundaries/sg-pdpa-data-transfer/sg_pdpa_data_transfer`<br>`local-data-use-boundaries/sg-pdpa-profiling-automated-decisions/sg_pdpa_profiling_automated_decisions` |
| `regional/uae-content` | `local-content-safety/uae-cultural-sensitivity-filter/uae_cultural_sensitivity`<br>`local-content-safety/uae-anti-discrimination-filter/uae_anti_discrimination` |

## Source Policy disposition

| Current Policy | Rules | New destination |
|---|---:|---|
| `block-code-execution` | 2 | Application Injection |
| `builtin-automated-reasoning` | 1 | Answer Reliability |
| `builtin-content-safety` | 1 | Content Safety (Model) |
| `builtin-contextual-grounding` | 1 | Answer Reliability |
| `builtin-indirect-prompt-injection` | 1 | Prompt & Instruction Attacks |
| `builtin-jailbreak` | 1 | Prompt & Instruction Attacks |
| `builtin-jailbreak-strict` | 1 | Prompt & Instruction Attacks |
| `builtin-memory-poisoning` | 1 | Prompt & Instruction Attacks |
| `builtin-pii` | 1 | PII (Semantic) |
| `builtin-topic-safety` | 2 | Business Topics & Advice |
| `competitor-mention-detection` | 1 | Content Filters |
| `configured-phrase-filter` | 1 | Content Filters |
| `keyword-blocking` | 1 | Content Filters |
| `local-contact-data` | 21 | Contact Data |
| `local-content-safety` | 16 | Content Safety (Local), Regional Compliance: UAE Content Standards |
| `local-credentials` | 18 | Credentials & Secrets |
| `local-data-use-boundaries` | 6 | Claims Profile, Regional Compliance: SG PDPA |
| `local-fraud-prevention` | 12 | Claims Profile, Financial Market Misconduct, Fraud & Account Abuse |
| `local-government-identifiers` | 25 | Identity Documents |
| `local-injection-protection` | 40 | Application Injection, Claims Profile, Prompt & Instruction Attacks |
| `local-network-addresses` | 3 | Network Identifiers |
| `local-passports` | 12 | Identity Documents |
| `local-payment-data` | 10 | Payment Data |
| `local-professional-advice` | 4 | Business Topics & Advice, Claims Profile |
| `local-prohibited-practices` | 10 | Regional Compliance: EU AI Act |
| `local-risk-content-terms` | 8 | Risk Content Terms |
| `local-sensitive-attribute-terms` | 8 | Sensitive Attributes |

