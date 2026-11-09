# Rule Resource Inventory

Status: inventory for the Rule -> Policy -> Profile redesign. Generated from the
current `policies/builtin` source; no Policy or Rule behavior was changed.

## Scope and method

- A **Rule** is the atomic detector/action/tests unit currently embedded in a Policy.
- `signature` is the canonical Rule content hash excluding id, name, description,
  stages and runtime_adapter. It finds exact duplicate Rule resources.
- `detector_signature` hashes detector ref/version/parameters. It finds Rules that
  share detection logic even when their action or labels differ.
- `industry_candidate` marks Rule IDs whose prefix or content is industry/claims
  specific (`banking/`, `cn-banking/`, `securities/`, `internet/`, `claims-*`).
- Region and framework are Policy-level attributes; they are repeated per Rule
  here for traceability.

## Summary

- Policies: **27**
- Rules: **208**
- Unique Rule signatures: **206**
- Exact duplicate groups: **2**
- Extra exact duplicate records: **2**
- Detector-shared groups: **3**
- Industry/claims candidates: **15** across **4** Policies
- Local Rules: **200**; platform Rules: **8**

### Rules by protection topic

| Protection topic | Rules |
|---|---:|
| privacy | 98 |
| attacks_and_abuse | 44 |
| business_rules | 32 |
| content_safety | 25 |
| content_filters | 3 |
| application_injection | 2 |
| answer_reliability | 2 |
| business_topics | 2 |

### Rules by proposed Rule family

| Family | Rules |
|---|---:|
| attacks_and_abuse | 43 |
| privacy/government_ids | 37 |
| content_safety | 25 |
| privacy/contact | 21 |
| privacy/credentials | 18 |
| fraud_and_abuse | 12 |
| privacy/payment | 10 |
| ai_governance | 10 |
| privacy/sensitive_attributes | 8 |
| data_governance | 6 |
| business_topics | 5 |
| content_filters | 3 |
| privacy/network | 3 |
| application_injection | 2 |
| answer_reliability | 2 |
| business_topics/professional_advice | 2 |
| privacy | 1 |

### Rules by Policy

| Policy | Topic | Rules | Region | Framework |
|---|---|---:|---|---|
| `block-code-execution` | application_injection | 2 | — | — |
| `builtin-automated-reasoning` | answer_reliability | 1 | — | — |
| `builtin-content-safety` | content_safety | 1 | — | — |
| `builtin-contextual-grounding` | answer_reliability | 1 | — | — |
| `builtin-indirect-prompt-injection` | attacks_and_abuse | 1 | — | — |
| `builtin-jailbreak` | attacks_and_abuse | 1 | — | — |
| `builtin-jailbreak-strict` | attacks_and_abuse | 1 | — | — |
| `builtin-memory-poisoning` | attacks_and_abuse | 1 | — | — |
| `builtin-pii` | privacy | 1 | — | — |
| `builtin-topic-safety` | business_topics | 2 | — | — |
| `competitor-mention-detection` | content_filters | 1 | — | — |
| `configured-phrase-filter` | content_filters | 1 | — | — |
| `keyword-blocking` | content_filters | 1 | — | — |
| `local-contact-data` | privacy | 21 | Australia; China mainland; European Union; Singapore; United Arab Emirates | GDPR; Singapore PDPA; PIPL (China) |
| `local-content-safety` | content_safety | 16 | Australia; United Arab Emirates | — |
| `local-credentials` | privacy | 18 | Australia | — |
| `local-data-use-boundaries` | business_rules | 6 | Singapore | Singapore PDPA |
| `local-fraud-prevention` | business_rules | 12 | China mainland | JR/T 0221-2021 |
| `local-government-identifiers` | privacy | 25 | Australia; China mainland; European Union; Singapore; United Arab Emirates | GDPR; Singapore PDPA; PIPL (China) |
| `local-injection-protection` | attacks_and_abuse | 40 | China mainland | — |
| `local-network-addresses` | privacy | 3 | Australia | — |
| `local-passports` | privacy | 12 | Australia; European Union; Singapore | GDPR; Singapore PDPA |
| `local-payment-data` | privacy | 10 | Australia; China mainland; European Union; Singapore; United Arab Emirates | GDPR; Singapore PDPA; PIPL (China) |
| `local-professional-advice` | business_rules | 4 | — | — |
| `local-prohibited-practices` | business_rules | 10 | European Union | EU AI Act |
| `local-risk-content-terms` | content_safety | 8 | — | — |
| `local-sensitive-attribute-terms` | privacy | 8 | Australia | — |

### Rules by detector

| Detector | Rules |
|---|---:|
| `text/regex` | 120 |
| `text/conditions` | 46 |
| `text/keyword` | 31 |
| `model/classifier` | 6 |
| `code/fenced-block` | 1 |
| `service/formal-verification` | 1 |
| `model/grounding` | 1 |
| `agent/indirect-injection` | 1 |
| `agent/memory-poisoning` | 1 |

## Exact duplicate Rule resources

| Group | Policy | Rule | Action |
|---|---|---|---|
| D1 | `builtin-jailbreak` | `model/jailbreak` | block |
| D1 | `builtin-jailbreak-strict` | `model/jailbreak` | block |
| D2 | `builtin-topic-safety` | `topic/denylist` | block |
| D2 | `builtin-topic-safety` | `topic/allowlist` | block |

These should become one canonical Rule resource. The Policies keep their own
binding-level action, parameter and test overrides.

## Detector-shared Rule candidates

| Group | Policy | Rule | Detector | Action |
|---|---|---|---|---|
| T1 | `builtin-jailbreak` | `model/jailbreak` | `model/classifier` | block |
| T1 | `builtin-jailbreak-strict` | `model/jailbreak` | `model/classifier` | block |
| T2 | `builtin-topic-safety` | `topic/denylist` | `model/classifier` | block |
| T2 | `builtin-topic-safety` | `topic/allowlist` | `model/classifier` | block |
| T3 | `local-passports` | `pattern/passport_india` | `text/regex` | transform |
| T3 | `local-passports` | `pattern/passport_australia` | `text/regex` | transform |

These share detector parameters. Review whether they should share one canonical
detector Rule or remain deliberately separate because their Policy semantics differ.

## Industry / claims-specific Rule candidates

These are the Rules that currently carry an industry or claims-sector identity in their
Rule ID. They are the best candidates to move into Profile parameter packs or into
topic-based Policies rather than industry Policies.

| Policy | Rule | Industry | Topic | Proposed Policy |
|---|---|---|---|---|
| `local-data-use-boundaries` | `claims-phi-disclosure-filter/claims_phi_disclosure` | insurance / claims | business_rules | Privacy & Data Governance (SG/PDPA) |
| `local-fraud-prevention` | `banking/identity-evasion` | banking | business_rules | Fraud & Account Abuse |
| `local-fraud-prevention` | `banking/return-guarantee` | banking | business_rules | Fraud & Account Abuse |
| `local-fraud-prevention` | `cn-banking/verification-code-theft` | banking (CN) | business_rules | Fraud & Account Abuse |
| `local-fraud-prevention` | `cn-banking/sensitive-credential-solicitation` | banking (CN) | business_rules | Fraud & Account Abuse |
| `local-fraud-prevention` | `cn-banking/identity-check-evasion` | banking (CN) | business_rules | Fraud & Account Abuse |
| `local-fraud-prevention` | `cn-banking/misleading-return-guarantee` | banking (CN) | business_rules | Fraud & Account Abuse |
| `local-fraud-prevention` | `claims-fraud-coaching-filter/claims_fraud_coaching` | insurance / claims | business_rules | Fraud & Account Abuse |
| `local-fraud-prevention` | `claims-prior-auth-gaming-filter/claims_prior_auth_gaming` | insurance / claims | business_rules | Fraud & Account Abuse |
| `local-fraud-prevention` | `internet/phishing` | internet | business_rules | Fraud & Account Abuse |
| `local-fraud-prevention` | `internet/session-theft` | internet | business_rules | Fraud & Account Abuse |
| `local-fraud-prevention` | `securities/inside-information` | securities | business_rules | Fraud & Account Abuse |
| `local-fraud-prevention` | `securities/manipulation` | securities | business_rules | Fraud & Account Abuse |
| `local-injection-protection` | `claims-system-override-filter/claims_system_override` | insurance / claims | attacks_and_abuse | Local Injection Protection |
| `local-professional-advice` | `claims-medical-advice-filter/claims_medical_advice` | insurance / claims | business_rules | Business Topics / Professional Advice |

Total: **15** industry/claims-labeled Rules across **4** Policies.

Notable concentration: `local-fraud-prevention` contains all 12 of its Rules with
banking, securities, internet or claims labels. The other industry-labeled Rules are
embedded inside otherwise generic Policies and should be reviewed individually.

## Policy restructuring candidates

| Current Policy | Current topic | Proposed Policy | Treatment |
|---|---|---|---|
| `local-fraud-prevention` | business_rules | Fraud & Account Abuse | Move generic fraud Rules into the Policy; move banking/securities/internet phrase packs to Profiles. |
| `local-data-use-boundaries` | business_rules | Privacy & Data Governance (SG/PDPA) | Keep SG PDPA Rules at Policy level; remove `business_rules` catch-all. |
| `local-professional-advice` | business_rules | Business Topics / Professional Advice | Keep generic advice restrictions; claims-medical Rule needs an insurance/claims Profile decision. |
| `local-prohibited-practices` | business_rules | AI Governance (EU AI Act) | Keep EU AI Act Rules at Policy level with jurisdiction/framework tags. |
| `local-injection-protection` | attacks_and_abuse | Attacks & Abuse | Move `claims-system-override` into a claims Profile pack if it is not a generic injection Rule. |
| 3 industry Profiles (`Bank`, `Securities`, `Internet`) | Profile only | Keep as Profiles | Do not expose them as Policy categories. |

## Full Rule inventory

The full 208-row table is in [rule-resource-inventory.csv](rule-resource-inventory.csv).
Columns include policy identity, protection topic, jurisdiction/framework, Rule ID,
detector, execution, action, rails, risk, signature groups, industry candidate and
proposed Policy.

Grouped overview:

### attacks_and_abuse (43)

| Policy | Rule | Detector | Action | Industry |
|---|---|---|---|---|
| `builtin-indirect-prompt-injection` | `boundary/indirect-injection` | `agent/indirect-injection` | block | — |
| `builtin-jailbreak` | `model/jailbreak` | `model/classifier` | block | — |
| `builtin-jailbreak-strict` | `model/jailbreak` | `model/classifier` | block | — |
| `builtin-memory-poisoning` | `boundary/memory-poisoning` | `agent/memory-poisoning` | block | — |
| `local-injection-protection` | `prompt-injection-blocker/blocked-word-1` | `text/keyword` | block | — |
| `local-injection-protection` | `prompt-injection-blocker/blocked-word-2` | `text/keyword` | block | — |
| `local-injection-protection` | `prompt-injection-blocker/blocked-word-3` | `text/keyword` | block | — |
| `local-injection-protection` | `prompt-injection-blocker/blocked-word-4` | `text/keyword` | block | — |
| `local-injection-protection` | `prompt-injection-blocker/blocked-word-5` | `text/keyword` | block | — |
| `local-injection-protection` | `prompt-injection-blocker/blocked-word-6` | `text/keyword` | block | — |
| `local-injection-protection` | `prompt-injection-blocker/blocked-word-7` | `text/keyword` | block | — |
| `local-injection-protection` | `prompt-injection-blocker/blocked-word-8` | `text/keyword` | block | — |
| `local-injection-protection` | `prompt-injection-blocker/blocked-word-9` | `text/keyword` | block | — |
| `local-injection-protection` | `prompt-injection-blocker/blocked-word-10` | `text/keyword` | block | — |
| `local-injection-protection` | `prompt-injection-blocker/blocked-word-11` | `text/keyword` | block | — |
| `local-injection-protection` | `prompt-injection-blocker/blocked-word-12` | `text/keyword` | block | — |
| `local-injection-protection` | `prompt-injection-blocker/blocked-word-13` | `text/keyword` | block | — |
| `local-injection-protection` | `prompt-injection-blocker/blocked-word-14` | `text/keyword` | block | — |
| `local-injection-protection` | `sql-injection-blocker/blocked-word-1` | `text/keyword` | block | — |
| `local-injection-protection` | `sql-injection-blocker/blocked-word-2` | `text/keyword` | block | — |
| `local-injection-protection` | `sql-injection-blocker/blocked-word-3` | `text/keyword` | block | — |
| `local-injection-protection` | `sql-injection-blocker/blocked-word-4` | `text/keyword` | block | — |
| `local-injection-protection` | `sql-injection-blocker/blocked-word-5` | `text/keyword` | block | — |
| `local-injection-protection` | `sql-injection-blocker/blocked-word-6` | `text/keyword` | block | — |
| `local-injection-protection` | `sql-injection-blocker/blocked-word-7` | `text/keyword` | block | — |
| `local-injection-protection` | `sql-injection-blocker/blocked-word-8` | `text/keyword` | block | — |
| `local-injection-protection` | `code-injection-blocker/blocked-word-3` | `text/keyword` | block | — |
| `local-injection-protection` | `code-injection-blocker/blocked-word-4` | `text/keyword` | block | — |
| `local-injection-protection` | `code-injection-blocker/blocked-word-5` | `text/keyword` | block | — |
| `local-injection-protection` | `code-injection-blocker/blocked-word-6` | `text/keyword` | block | — |
| `local-injection-protection` | `code-injection-blocker/blocked-word-7` | `text/keyword` | block | — |
| `local-injection-protection` | `application/active-html` | `text/regex` | block | — |
| `local-injection-protection` | `application/template-traversal` | `text/regex` | block | — |
| `local-injection-protection` | `category/prompt_injection_jailbreak` | `text/conditions` | block | — |
| `local-injection-protection` | `category/prompt_injection_data_exfiltration` | `text/conditions` | block | — |
| `local-injection-protection` | `category/prompt_injection_sql` | `text/conditions` | block | — |
| `local-injection-protection` | `category/prompt_injection_malicious_code` | `text/conditions` | block | — |
| `local-injection-protection` | `category/prompt_injection_system_prompt` | `text/conditions` | block | — |
| `local-injection-protection` | `cn-prompt-security/instruction-override` | `text/regex` | block | — |
| `local-injection-protection` | `cn-prompt-security/prompt-extraction` | `text/regex` | block | — |
| `local-injection-protection` | `cn-prompt-security/unrestricted-mode` | `text/regex` | block | — |
| `local-injection-protection` | `code-injection-blocker/blocked-word-1` | `text/keyword` | block | — |
| `local-injection-protection` | `code-injection-blocker/blocked-word-2` | `text/keyword` | block | — |

### privacy/government_ids (37)

| Policy | Rule | Detector | Action | Industry |
|---|---|---|---|---|
| `local-government-identifiers` | `au-pii-tax-identifiers/au_tfn` | `text/regex` | transform | — |
| `local-government-identifiers` | `au-pii-tax-identifiers/au_abn` | `text/regex` | transform | — |
| `local-government-identifiers` | `au-pii-tax-identifiers/au_medicare` | `text/regex` | transform | — |
| `local-government-identifiers` | `pattern/uae_emirates_id` | `text/regex` | transform | — |
| `local-government-identifiers` | `pattern/ca_on_drivers_licence` | `text/regex` | transform | — |
| `local-government-identifiers` | `pattern/ca_immigration_doc` | `text/regex` | transform | — |
| `local-government-identifiers` | `pattern/fr_nir` | `text/regex` | transform | — |
| `local-government-identifiers` | `pattern/uoft_tcard` | `text/regex` | transform | — |
| `local-government-identifiers` | `pattern/sg_uen` | `text/regex` | transform | — |
| `local-government-identifiers` | `pattern/ca_ohip` | `text/regex` | transform | — |
| `local-government-identifiers` | `pattern/ca_sin` | `text/regex` | transform | — |
| `local-government-identifiers` | `pattern/eu_vat` | `text/regex` | transform | — |
| `local-government-identifiers` | `pattern/nl_bsn_contextual` | `text/regex` | transform | — |
| `local-government-identifiers` | `pattern/au_tfn` | `text/regex` | transform | — |
| `local-government-identifiers` | `pattern/uoft_student_id` | `text/regex` | transform | — |
| `local-government-identifiers` | `pattern/us_ssn` | `text/regex` | transform | — |
| `local-government-identifiers` | `pattern/us_ssn_no_dash` | `text/regex` | transform | — |
| `local-government-identifiers` | `pattern/br_cpf` | `text/regex` | transform | — |
| `local-government-identifiers` | `pattern/br_cpf_unformatted` | `text/regex` | transform | — |
| `local-government-identifiers` | `pattern/br_cnpj` | `text/regex` | transform | — |
| `local-government-identifiers` | `pattern/br_rg` | `text/regex` | transform | — |
| `local-government-identifiers` | `pattern/sg_nric` | `text/regex` | transform | — |
| `local-government-identifiers` | `pattern/uoft_utorid` | `text/regex` | transform | — |
| `local-government-identifiers` | `cn-business-identifier/unified-social-credit-code` | `text/regex` | transform | — |
| `local-government-identifiers` | `cn-personal-information/resident-identity-card` | `text/regex` | transform | — |
| `local-passports` | `pattern/passport_singapore` | `text/regex` | transform | — |
| `local-passports` | `pattern/passport_china` | `text/regex` | transform | — |
| `local-passports` | `pattern/passport_us` | `text/regex` | transform | — |
| `local-passports` | `pattern/passport_germany` | `text/regex` | transform | — |
| `local-passports` | `pattern/passport_france` | `text/regex` | transform | — |
| `local-passports` | `pattern/passport_netherlands` | `text/regex` | transform | — |
| `local-passports` | `pattern/passport_canada` | `text/regex` | transform | — |
| `local-passports` | `pattern/passport_india` | `text/regex` | transform | — |
| `local-passports` | `identity/passport` | `text/regex` | transform | — |
| `local-passports` | `international-pii-identifiers/passport_uk` | `text/regex` | transform | — |
| `local-passports` | `international-pii-identifiers/passport_japan` | `text/regex` | transform | — |
| `local-passports` | `pattern/passport_australia` | `text/regex` | transform | — |

### content_safety (25)

| Policy | Rule | Detector | Action | Industry |
|---|---|---|---|---|
| `builtin-content-safety` | `model/content-safety` | `model/classifier` | block | — |
| `local-content-safety` | `category/denied_insults` | `text/conditions` | block | — |
| `local-content-safety` | `category/harm_toxic_abuse` | `text/conditions` | block | — |
| `local-content-safety` | `category/harmful_violence` | `text/conditions` | block | — |
| `local-content-safety` | `category/harmful_self_harm` | `text/conditions` | block | — |
| `local-content-safety` | `category/harmful_child_safety` | `text/conditions` | block | — |
| `local-content-safety` | `category/harmful_illegal_weapons` | `text/conditions` | block | — |
| `local-content-safety` | `category/bias_gender` | `text/conditions` | block | — |
| `local-content-safety` | `category/bias_racial` | `text/conditions` | block | — |
| `local-content-safety` | `category/bias_religious` | `text/conditions` | block | — |
| `local-content-safety` | `category/bias_sexual_orientation` | `text/conditions` | block | — |
| `local-content-safety` | `nsfw-filter-spanish/harm_toxic_abuse_es` | `text/conditions` | block | — |
| `local-content-safety` | `nsfw-filter-french/harm_toxic_abuse_fr` | `text/conditions` | block | — |
| `local-content-safety` | `nsfw-filter-german/harm_toxic_abuse_de` | `text/conditions` | block | — |
| `local-content-safety` | `nsfw-filter-australian/harm_toxic_abuse_au` | `text/conditions` | block | — |
| `local-content-safety` | `uae-cultural-sensitivity-filter/uae_cultural_sensitivity` | `text/conditions` | block | — |
| `local-content-safety` | `uae-anti-discrimination-filter/uae_anti_discrimination` | `text/conditions` | block | — |
| `local-risk-content-terms` | `pattern/explosives` | `text/regex` | transform | — |
| `local-risk-content-terms` | `pattern/weapons_firearms` | `text/regex` | transform | — |
| `local-risk-content-terms` | `pattern/weapons_other` | `text/regex` | transform | — |
| `local-risk-content-terms` | `pattern/violence_threats` | `text/regex` | transform | — |
| `local-risk-content-terms` | `pattern/terrorism` | `text/regex` | transform | — |
| `local-risk-content-terms` | `pattern/self_harm_suicide` | `text/regex` | transform | — |
| `local-risk-content-terms` | `pattern/illegal_activities` | `text/regex` | transform | — |
| `local-risk-content-terms` | `pattern/harassment_hate` | `text/regex` | transform | — |

### privacy/contact (21)

| Policy | Rule | Detector | Action | Industry |
|---|---|---|---|---|
| `local-contact-data` | `pattern/titled_person` | `text/regex` | transform | — |
| `local-contact-data` | `pattern/contact_list_person` | `text/regex` | transform | — |
| `local-contact-data` | `pattern/truncated_address` | `text/regex` | transform | — |
| `local-contact-data` | `pattern/structured_username` | `text/regex` | transform | — |
| `local-contact-data` | `pattern/structured_address` | `text/regex` | transform | — |
| `local-contact-data` | `pattern/labelled_person` | `text/regex` | transform | — |
| `local-contact-data` | `pattern/international_phone` | `text/regex` | transform | — |
| `local-contact-data` | `pattern/sg_phone` | `text/regex` | transform | — |
| `local-contact-data` | `pattern/uae_phone` | `text/regex` | transform | — |
| `local-contact-data` | `pattern/fr_phone` | `text/regex` | transform | — |
| `local-contact-data` | `pattern/br_phone_mobile` | `text/regex` | transform | — |
| `local-contact-data` | `pattern/br_phone_landline` | `text/regex` | transform | — |
| `local-contact-data` | `pattern/br_cep` | `text/regex` | transform | — |
| `local-contact-data` | `pattern/fr_postal_code` | `text/regex` | transform | — |
| `local-contact-data` | `pattern/street_address` | `text/regex` | transform | — |
| `local-contact-data` | `pattern/sg_postal_code` | `text/regex` | transform | — |
| `local-contact-data` | `pattern/ca_postal_code` | `text/regex` | transform | — |
| `local-contact-data` | `pattern/email` | `text/regex` | transform | — |
| `local-contact-data` | `pattern/us_phone` | `text/regex` | transform | — |
| `local-contact-data` | `cn-personal-information/mainland-mobile` | `text/regex` | transform | — |
| `local-contact-data` | `uae-data-protection-pii/uae_po_box` | `text/regex` | transform | — |

### privacy/credentials (18)

| Policy | Rule | Detector | Action | Industry |
|---|---|---|---|---|
| `local-credentials` | `credentials-api-keys/aws_access_key` | `text/regex` | block | — |
| `local-credentials` | `credentials-api-keys/aws_secret_key` | `text/regex` | block | — |
| `local-credentials` | `credentials-api-keys/github_token` | `text/regex` | block | — |
| `local-credentials` | `credentials-api-keys/slack_token` | `text/regex` | block | — |
| `local-credentials` | `credentials-api-keys/generic_api_key` | `text/regex` | block | — |
| `local-credentials` | `credential/bearer-token` | `text/regex` | block | — |
| `local-credentials` | `credential/private-key-header` | `text/regex` | block | — |
| `local-credentials` | `credential/hex-token` | `text/regex` | block | — |
| `local-credentials` | `credential/password` | `text/regex` | block | — |
| `local-credentials` | `credential/url-password` | `text/regex` | block | — |
| `local-credentials` | `credential/basic-auth` | `text/regex` | block | — |
| `local-credentials` | `credential/jwt` | `text/regex` | block | — |
| `local-credentials` | `credential/labelled-hex-key` | `text/regex` | block | — |
| `local-credentials` | `credential/private-jwk` | `text/regex` | block | — |
| `local-credentials` | `credential/sql-password` | `text/regex` | block | — |
| `local-credentials` | `credential/command-password` | `text/regex` | block | — |
| `local-credentials` | `credential/nkey-seed` | `text/regex` | block | — |
| `local-credentials` | `credential/base64-private-key` | `text/regex` | block | — |

### fraud_and_abuse (12)

| Policy | Rule | Detector | Action | Industry |
|---|---|---|---|---|
| `local-fraud-prevention` | `banking/identity-evasion` | `text/regex` | block | banking |
| `local-fraud-prevention` | `banking/return-guarantee` | `text/regex` | block | banking |
| `local-fraud-prevention` | `cn-banking/verification-code-theft` | `text/regex` | block | banking (CN) |
| `local-fraud-prevention` | `cn-banking/sensitive-credential-solicitation` | `text/regex` | block | banking (CN) |
| `local-fraud-prevention` | `cn-banking/identity-check-evasion` | `text/regex` | block | banking (CN) |
| `local-fraud-prevention` | `cn-banking/misleading-return-guarantee` | `text/regex` | block | banking (CN) |
| `local-fraud-prevention` | `claims-fraud-coaching-filter/claims_fraud_coaching` | `text/conditions` | block | insurance / claims |
| `local-fraud-prevention` | `claims-prior-auth-gaming-filter/claims_prior_auth_gaming` | `text/conditions` | block | insurance / claims |
| `local-fraud-prevention` | `internet/phishing` | `text/regex` | block | internet |
| `local-fraud-prevention` | `internet/session-theft` | `text/regex` | block | internet |
| `local-fraud-prevention` | `securities/inside-information` | `text/regex` | block | securities |
| `local-fraud-prevention` | `securities/manipulation` | `text/regex` | block | securities |

### privacy/payment (10)

| Policy | Rule | Detector | Action | Industry |
|---|---|---|---|---|
| `local-payment-data` | `financial-pii/credit_card` | `text/regex` | transform | — |
| `local-payment-data` | `financial-pii/iban` | `text/regex` | transform | — |
| `local-payment-data` | `pattern/ca_bank_account` | `text/regex` | transform | — |
| `local-payment-data` | `pattern/sg_bank_account` | `text/regex` | transform | — |
| `local-payment-data` | `cn-personal-information/unionpay-card` | `text/regex` | transform | — |
| `local-payment-data` | `pattern/eu_iban_enhanced` | `text/regex` | transform | — |
| `local-payment-data` | `financial-pii/visa` | `text/regex` | transform | — |
| `local-payment-data` | `financial-pii/mastercard` | `text/regex` | transform | — |
| `local-payment-data` | `financial-pii/amex` | `text/regex` | transform | — |
| `local-payment-data` | `financial-pii/discover` | `text/regex` | transform | — |

### ai_governance (10)

| Policy | Rule | Detector | Action | Industry |
|---|---|---|---|---|
| `local-prohibited-practices` | `eu-ai-act-art5-manipulation/eu_ai_act_art5_manipulation` | `text/conditions` | block | — |
| `local-prohibited-practices` | `eu-ai-act-art5-vulnerability/eu_ai_act_art5_vulnerability` | `text/conditions` | block | — |
| `local-prohibited-practices` | `eu-ai-act-art5-social-scoring/eu_ai_act_art5_social_scoring` | `text/conditions` | block | — |
| `local-prohibited-practices` | `eu-ai-act-art5-emotion-recognition/eu_ai_act_art5_emotion_recognition` | `text/conditions` | block | — |
| `local-prohibited-practices` | `eu-ai-act-art5-biometric-profiling/eu_ai_act_art5_biometric_profiling` | `text/conditions` | block | — |
| `local-prohibited-practices` | `eu-ai-act-art5-manipulation-fr/eu_ai_act_art5_manipulation_fr` | `text/conditions` | block | — |
| `local-prohibited-practices` | `eu-ai-act-art5-vulnerability-fr/eu_ai_act_art5_vulnerability_fr` | `text/conditions` | block | — |
| `local-prohibited-practices` | `eu-ai-act-art5-social-scoring-fr/eu_ai_act_art5_social_scoring_fr` | `text/conditions` | block | — |
| `local-prohibited-practices` | `eu-ai-act-art5-emotion-recognition-fr/eu_ai_act_art5_emotion_recognition_fr` | `text/conditions` | block | — |
| `local-prohibited-practices` | `eu-ai-act-art5-biometric-profiling-fr/eu_ai_act_art5_biometric_profiling_fr` | `text/conditions` | block | — |

### privacy/sensitive_attributes (8)

| Policy | Rule | Detector | Action | Industry |
|---|---|---|---|---|
| `local-sensitive-attribute-terms` | `pattern/gender_sexual_orientation` | `text/regex` | transform | — |
| `local-sensitive-attribute-terms` | `pattern/race_ethnicity_national_origin` | `text/regex` | transform | — |
| `local-sensitive-attribute-terms` | `pattern/religion` | `text/regex` | transform | — |
| `local-sensitive-attribute-terms` | `pattern/age_discrimination` | `text/regex` | transform | — |
| `local-sensitive-attribute-terms` | `pattern/disability` | `text/regex` | transform | — |
| `local-sensitive-attribute-terms` | `pattern/marital_family_status` | `text/regex` | transform | — |
| `local-sensitive-attribute-terms` | `pattern/military_status` | `text/regex` | transform | — |
| `local-sensitive-attribute-terms` | `pattern/public_assistance` | `text/regex` | transform | — |

### data_governance (6)

| Policy | Rule | Detector | Action | Industry |
|---|---|---|---|---|
| `local-data-use-boundaries` | `claims-phi-disclosure-filter/claims_phi_disclosure` | `text/conditions` | block | insurance / claims |
| `local-data-use-boundaries` | `sg-pdpa-personal-identifiers/sg_pdpa_personal_identifiers` | `text/conditions` | block | — |
| `local-data-use-boundaries` | `sg-pdpa-sensitive-data/sg_pdpa_sensitive_data` | `text/conditions` | block | — |
| `local-data-use-boundaries` | `sg-pdpa-do-not-call/sg_pdpa_do_not_call` | `text/conditions` | block | — |
| `local-data-use-boundaries` | `sg-pdpa-data-transfer/sg_pdpa_data_transfer` | `text/conditions` | block | — |
| `local-data-use-boundaries` | `sg-pdpa-profiling-automated-decisions/sg_pdpa_profiling_automated_decisions` | `text/conditions` | block | — |

### business_topics (5)

| Policy | Rule | Detector | Action | Industry |
|---|---|---|---|---|
| `builtin-topic-safety` | `topic/denylist` | `model/classifier` | block | — |
| `builtin-topic-safety` | `topic/allowlist` | `model/classifier` | block | — |
| `local-professional-advice` | `category/denied_financial_advice` | `text/conditions` | block | — |
| `local-professional-advice` | `category/denied_legal_advice` | `text/conditions` | block | — |
| `local-professional-advice` | `category/denied_medical_advice` | `text/conditions` | block | — |

### content_filters (3)

| Policy | Rule | Detector | Action | Industry |
|---|---|---|---|---|
| `competitor-mention-detection` | `competitor/intent` | `text/conditions` | block | — |
| `configured-phrase-filter` | `configured/phrases` | `text/keyword` | block | — |
| `keyword-blocking` | `keyword/blocked-words` | `text/keyword` | block | — |

### privacy/network (3)

| Policy | Rule | Detector | Action | Industry |
|---|---|---|---|---|
| `local-network-addresses` | `pattern/ipv4` | `text/regex` | transform | — |
| `local-network-addresses` | `pattern/ipv6` | `text/regex` | transform | — |
| `local-network-addresses` | `pattern/url` | `text/regex` | transform | — |

### application_injection (2)

| Policy | Rule | Detector | Action | Industry |
|---|---|---|---|---|
| `block-code-execution` | `code/execution` | `code/fenced-block` | block | — |
| `block-code-execution` | `code/execution-request` | `text/conditions` | block | — |

### answer_reliability (2)

| Policy | Rule | Detector | Action | Industry |
|---|---|---|---|---|
| `builtin-automated-reasoning` | `model/automated-reasoning` | `service/formal-verification` | block | — |
| `builtin-contextual-grounding` | `model/contextual-grounding` | `model/grounding` | block | — |

### business_topics/professional_advice (2)

| Policy | Rule | Detector | Action | Industry |
|---|---|---|---|---|
| `local-injection-protection` | `claims-system-override-filter/claims_system_override` | `text/conditions` | block | insurance / claims |
| `local-professional-advice` | `claims-medical-advice-filter/claims_medical_advice` | `text/conditions` | block | insurance / claims |

### privacy (1)

| Policy | Rule | Detector | Action | Industry |
|---|---|---|---|---|
| `builtin-pii` | `model/pii` | `model/classifier` | transform | — |

