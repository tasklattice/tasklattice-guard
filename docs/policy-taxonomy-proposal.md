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
| `business_topics` | Business Topics & Advice | builtin-topic-safety, local-professional-advice | Global | 6 |
| `contact_data` | Contact Data | local-contact-data | Australia; China mainland; European Union; Singapore; United Arab Emirates; GDPR; PIPL (China); Singapore PDPA | 21 |
| `content_filters` | Content Filters | competitor-mention-detection, configured-phrase-filter, keyword-blocking | Global | 3 |
| `content_safety` | Content Safety (Local) | local-content-safety | Australia; United Arab Emirates | 14 |
| `content_safety` | Content Safety (Model) | builtin-content-safety | Global | 1 |
| `credentials_secrets` | Credentials & Secrets | local-credentials | Australia | 18 |
| `financial_misconduct` | Financial Market Misconduct | local-fraud-prevention | China mainland; JR/T 0221-2021 | 4 |
| `fraud_account_abuse` | Fraud & Account Abuse | local-fraud-prevention | China mainland; JR/T 0221-2021 | 8 |
| `identity_documents` | Identity Documents | local-government-identifiers, local-passports | Australia; China mainland; European Union; Singapore; United Arab Emirates; GDPR; PIPL (China); Singapore PDPA | 37 |
| `network_identifiers` | Network Identifiers | local-network-addresses | Australia | 3 |
| `privacy` | PII (Semantic) | builtin-pii | Global | 1 |
| `payment_data` | Payment Data | local-payment-data | Australia; China mainland; European Union; Singapore; United Arab Emirates; GDPR; PIPL (China); Singapore PDPA | 10 |
| `prompt_attacks` | Prompt & Instruction Attacks | builtin-indirect-prompt-injection, builtin-jailbreak, builtin-jailbreak-strict, builtin-memory-poisoning, local-injection-protection | China mainland; Global | 27 |
| `regional_compliance` | Regional Compliance: EU AI Act | local-prohibited-practices | European Union; EU AI Act | 10 |
| `regional_compliance` | Regional Compliance: SG PDPA | local-data-use-boundaries | Singapore; Singapore PDPA | 6 |
| `regional_compliance` | Regional Compliance: UAE Content Standards | local-content-safety | United Arab Emirates | 2 |
| `content_safety` | Risk Content Terms | local-risk-content-terms | Global | 8 |
| `sensitive_attributes` | Sensitive Attributes | local-sensitive-attribute-terms | Australia | 8 |

### Profile selection, not Rule ownership

The optional Claims Profile selects five claims-specific Rule bindings from
Fraud & Account Abuse, SG PDPA, Business Topics & Advice and Prompt &
Instruction Attacks. It does not own or inject Rules.

## Summary

- Policy proposals: **20**
- Profile packs: **1** (`Claims Profile`, selection only)
- Source Rules mapped: **208** (all Policy-bound)
- Overlap groups: **29**

## Rules by proposed category

| Category | Rules |
|---|---:|
| `identity_documents` | 37 |
| `prompt_attacks` | 27 |
| `content_safety` | 23 |
| `contact_data` | 21 |
| `application_injection` | 19 |
| `regional_compliance` | 18 |
| `credentials_secrets` | 18 |
| `payment_data` | 10 |
| `fraud_account_abuse` | 8 |
| `sensitive_attributes` | 8 |
| `business_topics` | 6 |
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
| SG PDPA | Six obligations, including claims PHI | Claims PHI stays in the Policy; the Claims Profile selects it. |
| EU AI Act | English/French variants of same Art. 5 practice | Merge language variants into one Rule per practice. |
| UAE Content Standards | Cultural sensitivity vs anti-discrimination | Keep separate Rules; review overlap on bias terms. |

## Industry-specific treatment

| Current source | Destination |
|---|---|
| Bank / Securities / Internet Profiles | Stay Profiles, removed from Policy categories |
| `local-fraud-prevention` banking/securities Rules | Generic fraud or Financial Market Misconduct Policy |
| `local-fraud-prevention` claims Rules | Stay in Fraud & Account Abuse; Claims Profile selects them. |
| `local-data-use-boundaries` claims PHI | Stay in SG PDPA; Claims Profile selects it. |
| `local-professional-advice` claims medical | Stay in Business Topics; Claims Profile selects it. |
| `local-injection-protection` claims system override | Stay in Prompt Attacks; Claims Profile selects it. |
| Future MAS resident-information / CN PIPL controls | Regional Compliance or Profile pack, only if executable rules exist |

## Rule-level mapping

The full 208-row mapping is in [policy-rule-mapping.csv](policy-rule-mapping.csv).
Columns: current Policy, current topic, region/framework, Rule ID, action, new category,
new Policy, disposition (`keep`, `merge`, `move`, `split`, `profile`), overlap group and note.

## Profile direction

| Profile | Composition direction |
|---|---|
| Bank | Payment Data + Contact Data + Identity Documents + Credentials + Fraud & Account Abuse + Financial Market Misconduct + regional privacy/compliance |
| Securities | Payment Data + Contact Data + Identity Documents + Credentials + Financial Market Misconduct + Fraud & Account Abuse |
| Internet | Contact Data + Payment Data + Credentials + Fraud & Account Abuse + Prompt & Instruction Attacks + Application Injection + Content Filters |
| Claims | Selects claims-specific Rule bindings from Fraud & Account Abuse, SG PDPA, Business Topics & Advice and Prompt & Instruction Attacks; it does not own Rules. |
| Default / Full-feature | Technical baselines, not Policy categories |

## Open decisions before implementation

1. Should `PII (Semantic)` stay a separate Policy from local contact/identity/payment Policies?
2. Should `Risk Content Terms` remain a separate transform Policy from `Content Safety (Local)`?
3. Should Claims be a new Profile, or a parameter pack reused by Bank/Insurance Profiles?
4. Should `UAE Content Standards` be a regional-compliance Policy or a content-safety Policy with a UAE tag?
5. Should the two jailbreak model Policies remain separate (one strict variant) or merge into one Policy with a strict parameter?

## Computed overlap groups

| Group | Source Rules |
|---|---|
| `app/code` | `local-injection-protection/code-injection-blocker/blocked-word-3`<br>`local-injection-protection/code-injection-blocker/blocked-word-4`<br>`local-injection-protection/code-injection-blocker/blocked-word-5`<br>`local-injection-protection/code-injection-blocker/blocked-word-6`<br>`local-injection-protection/code-injection-blocker/blocked-word-7`<br>`local-injection-protection/code-injection-blocker/blocked-word-1`<br>`local-injection-protection/code-injection-blocker/blocked-word-2` |
| `app/markup` | `local-injection-protection/application/active-html`<br>`local-injection-protection/application/template-traversal` |
| `app/sql` | `local-injection-protection/sql-injection-blocker/blocked-word-1`<br>`local-injection-protection/sql-injection-blocker/blocked-word-2`<br>`local-injection-protection/sql-injection-blocker/blocked-word-3`<br>`local-injection-protection/sql-injection-blocker/blocked-word-4`<br>`local-injection-protection/sql-injection-blocker/blocked-word-5`<br>`local-injection-protection/sql-injection-blocker/blocked-word-6`<br>`local-injection-protection/sql-injection-blocker/blocked-word-7`<br>`local-injection-protection/sql-injection-blocker/blocked-word-8` |
| `attacks/jailbreak-model` | `builtin-jailbreak/model/jailbreak`<br>`builtin-jailbreak-strict/model/jailbreak` |
| `business/topic-classification` | `builtin-topic-safety/topic/denylist`<br>`builtin-topic-safety/topic/allowlist` |
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
| `local-data-use-boundaries` | 6 | Regional Compliance: SG PDPA |
| `local-fraud-prevention` | 12 | Financial Market Misconduct, Fraud & Account Abuse |
| `local-government-identifiers` | 25 | Identity Documents |
| `local-injection-protection` | 40 | Application Injection, Prompt & Instruction Attacks |
| `local-network-addresses` | 3 | Network Identifiers |
| `local-passports` | 12 | Identity Documents |
| `local-payment-data` | 10 | Payment Data |
| `local-professional-advice` | 4 | Business Topics & Advice |
| `local-prohibited-practices` | 10 | Regional Compliance: EU AI Act |
| `local-risk-content-terms` | 8 | Risk Content Terms |
| `local-sensitive-attribute-terms` | 8 | Sensitive Attributes |

