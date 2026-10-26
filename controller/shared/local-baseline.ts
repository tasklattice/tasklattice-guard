import type { GuardrailProfile } from "./protection-map.js";

// Frozen deployment Profile; edits create a new Profile version.
export const localBaseline = {
  "id": "local-baseline",
  "version": "1.0.0",
  "name": "Local baseline",
  "description": "The local protections used for the initial deployment. Create an ordinary Guardrail and customize it.",
  "category": "local_baseline",
  "categoryName": "Local baseline",
  "isDefault": true,
  "industry": "general",
  "jurisdictions": [],
  "policies": [
    {
      "policyId": "builtin-indirect-prompt-injection",
      "policyVersion": "1.0.1",
      "action": null,
      "parameterValues": {},
      "enabledRuleIds": [
        "boundary/indirect-injection"
      ],
      "ruleOrder": [
        "boundary/indirect-injection"
      ],
      "testCaseOverrides": {},
      "ruleActions": {},
      "enabledRails": [
        "input"
      ],
      "reasoningPolicy": null
    },
    {
      "policyId": "builtin-memory-poisoning",
      "policyVersion": "1.0.1",
      "action": null,
      "parameterValues": {},
      "enabledRuleIds": [
        "boundary/memory-poisoning"
      ],
      "ruleOrder": [
        "boundary/memory-poisoning"
      ],
      "testCaseOverrides": {},
      "ruleActions": {},
      "enabledRails": [
        "input"
      ],
      "reasoningPolicy": null
    },
    {
      "policyId": "local-content-safety",
      "policyVersion": "4.1.0",
      "action": null,
      "parameterValues": {},
      "enabledRuleIds": [
        "category/denied_insults",
        "category/harm_toxic_abuse",
        "category/harmful_violence",
        "category/harmful_self_harm",
        "category/harmful_child_safety",
        "category/harmful_illegal_weapons",
        "category/bias_gender",
        "category/bias_racial",
        "category/bias_religious",
        "category/bias_sexual_orientation"
      ],
      "ruleOrder": [
        "category/denied_insults",
        "category/harm_toxic_abuse",
        "category/harmful_violence",
        "category/harmful_self_harm",
        "category/harmful_child_safety",
        "category/harmful_illegal_weapons",
        "category/bias_gender",
        "category/bias_racial",
        "category/bias_religious",
        "category/bias_sexual_orientation"
      ],
      "testCaseOverrides": {
        "filter-denied-insults/accept/denied_insults": {
          "sourcePolicyVersion": "4.1.0",
          "reason": "Default records insults findings without intervening: broad word co-occurrence also matches benign Agent instructions. Other Policies continue to enforce their own actions.",
          "expectedDecision": "allow",
          "expectedOutputContent": "Please review this request: idiot.",
          "expectedMatches": [
            {
              "policyId": "local-content-safety",
              "ruleId": "category/denied_insults"
            }
          ]
        },
        "filter-denied-insults/accept/denied_insults/output": {
          "sourcePolicyVersion": "4.1.0",
          "reason": "Default records insults findings without intervening: broad word co-occurrence also matches benign Agent instructions. Other Policies continue to enforce their own actions.",
          "expectedDecision": "allow",
          "expectedOutputContent": "Please review this request: idiot.",
          "expectedMatches": [
            {
              "policyId": "local-content-safety",
              "ruleId": "category/denied_insults"
            }
          ]
        },
        "filter-harmful-violence/accept/harmful_violence": {
          "sourcePolicyVersion": "4.1.0",
          "reason": "The earlier configured Policy rejects and terminates the chain. Assert its Policy/Rule; later Rules must not execute.",
          "expectedDecision": "block",
          "expectedOutputContent": "",
          "expectedMatches": [
            {
              "policyId": "local-content-safety",
              "ruleId": "category/harm_toxic_abuse"
            }
          ]
        },
        "filter-harmful-self-harm/accept/harmful_self_harm": {
          "sourcePolicyVersion": "4.1.0",
          "reason": "The earlier configured Policy rejects and terminates the chain. Assert its Policy/Rule; later Rules must not execute.",
          "expectedDecision": "block",
          "expectedOutputContent": "",
          "expectedMatches": [
            {
              "policyId": "local-content-safety",
              "ruleId": "category/harm_toxic_abuse"
            }
          ]
        },
        "filter-bias-sexual-orientation/accept/bias_sexual_orientation": {
          "sourcePolicyVersion": "4.1.0",
          "reason": "The earlier configured Policy rejects and terminates the chain. Assert its Policy/Rule; later Rules must not execute.",
          "expectedDecision": "block",
          "expectedOutputContent": "",
          "expectedMatches": [
            {
              "policyId": "local-content-safety",
              "ruleId": "category/harm_toxic_abuse"
            }
          ]
        },
        "regression/benign-context-10/input": {
          "sourcePolicyVersion": "4.1.0",
          "expectedDecision": "transform",
          "expectedOutputContent": "Review a website with inclusive attire for [gender_sexual_orientation_REDACTED].",
          "expectedMatches": [
            {
              "policyId": "local-sensitive-attribute-terms",
              "ruleId": "pattern/gender_sexual_orientation"
            }
          ],
          "reason": "Local content safety permits this benign reference. Default separately applies its configured sensitive-attribute vocabulary redaction; preserve that explicit transformation rather than treating the mention as discrimination."
        },
        "regression/benign-context-10/output": {
          "sourcePolicyVersion": "4.1.0",
          "expectedDecision": "transform",
          "expectedOutputContent": "Review a website with inclusive attire for [gender_sexual_orientation_REDACTED].",
          "expectedMatches": [
            {
              "policyId": "local-sensitive-attribute-terms",
              "ruleId": "pattern/gender_sexual_orientation"
            }
          ],
          "reason": "Local content safety permits this benign reference. Default separately applies its configured sensitive-attribute vocabulary redaction; preserve that explicit transformation rather than treating the mention as discrimination."
        },
        "regression/benign-context-11/input": {
          "sourcePolicyVersion": "4.1.0",
          "expectedDecision": "transform",
          "expectedOutputContent": "Write about a young [gender_sexual_orientation_REDACTED] learning to paint.",
          "expectedMatches": [
            {
              "policyId": "local-sensitive-attribute-terms",
              "ruleId": "pattern/gender_sexual_orientation"
            }
          ],
          "reason": "Local content safety permits this benign reference. Default separately applies its configured sensitive-attribute vocabulary redaction; preserve that explicit transformation rather than treating the mention as discrimination."
        },
        "regression/benign-context-11/output": {
          "sourcePolicyVersion": "4.1.0",
          "expectedDecision": "transform",
          "expectedOutputContent": "Write about a young [gender_sexual_orientation_REDACTED] learning to paint.",
          "expectedMatches": [
            {
              "policyId": "local-sensitive-attribute-terms",
              "ruleId": "pattern/gender_sexual_orientation"
            }
          ],
          "reason": "Local content safety permits this benign reference. Default separately applies its configured sensitive-attribute vocabulary redaction; preserve that explicit transformation rather than treating the mention as discrimination."
        },
        "regression/benign-context-13/input": {
          "sourcePolicyVersion": "4.1.0",
          "expectedDecision": "transform",
          "expectedOutputContent": "A [gender_sexual_orientation_REDACTED] uses an inferior camera to photograph a bird.",
          "expectedMatches": [
            {
              "policyId": "local-sensitive-attribute-terms",
              "ruleId": "pattern/gender_sexual_orientation"
            }
          ],
          "reason": "Local content safety permits this benign reference. Default separately applies its configured sensitive-attribute vocabulary redaction; preserve that explicit transformation rather than treating the mention as discrimination."
        },
        "regression/benign-context-13/output": {
          "sourcePolicyVersion": "4.1.0",
          "expectedDecision": "transform",
          "expectedOutputContent": "A [gender_sexual_orientation_REDACTED] uses an inferior camera to photograph a bird.",
          "expectedMatches": [
            {
              "policyId": "local-sensitive-attribute-terms",
              "ruleId": "pattern/gender_sexual_orientation"
            }
          ],
          "reason": "Local content safety permits this benign reference. Default separately applies its configured sensitive-attribute vocabulary redaction; preserve that explicit transformation rather than treating the mention as discrimination."
        }
      },
      "ruleActions": {
        "category/denied_insults": "allow"
      },
      "enabledRails": [
        "input",
        "output"
      ],
      "reasoningPolicy": null
    },
    {
      "policyId": "local-injection-protection",
      "policyVersion": "4.0.0",
      "action": null,
      "parameterValues": {},
      "enabledRuleIds": [
        "prompt-injection-blocker/blocked-word-1",
        "prompt-injection-blocker/blocked-word-2",
        "prompt-injection-blocker/blocked-word-3",
        "prompt-injection-blocker/blocked-word-4",
        "prompt-injection-blocker/blocked-word-5",
        "prompt-injection-blocker/blocked-word-6",
        "prompt-injection-blocker/blocked-word-7",
        "prompt-injection-blocker/blocked-word-8",
        "prompt-injection-blocker/blocked-word-9",
        "prompt-injection-blocker/blocked-word-10",
        "prompt-injection-blocker/blocked-word-11",
        "prompt-injection-blocker/blocked-word-12",
        "prompt-injection-blocker/blocked-word-13",
        "prompt-injection-blocker/blocked-word-14",
        "sql-injection-blocker/blocked-word-1",
        "sql-injection-blocker/blocked-word-2",
        "sql-injection-blocker/blocked-word-3",
        "sql-injection-blocker/blocked-word-4",
        "sql-injection-blocker/blocked-word-5",
        "sql-injection-blocker/blocked-word-6",
        "sql-injection-blocker/blocked-word-7",
        "sql-injection-blocker/blocked-word-8",
        "code-injection-blocker/blocked-word-3",
        "code-injection-blocker/blocked-word-4",
        "code-injection-blocker/blocked-word-5",
        "code-injection-blocker/blocked-word-6",
        "code-injection-blocker/blocked-word-7",
        "application/active-html",
        "application/template-traversal",
        "category/prompt_injection_jailbreak",
        "category/prompt_injection_data_exfiltration",
        "category/prompt_injection_sql",
        "category/prompt_injection_malicious_code",
        "category/prompt_injection_system_prompt"
      ],
      "ruleOrder": [
        "prompt-injection-blocker/blocked-word-1",
        "prompt-injection-blocker/blocked-word-2",
        "prompt-injection-blocker/blocked-word-3",
        "prompt-injection-blocker/blocked-word-4",
        "prompt-injection-blocker/blocked-word-5",
        "prompt-injection-blocker/blocked-word-6",
        "prompt-injection-blocker/blocked-word-7",
        "prompt-injection-blocker/blocked-word-8",
        "prompt-injection-blocker/blocked-word-9",
        "prompt-injection-blocker/blocked-word-10",
        "prompt-injection-blocker/blocked-word-11",
        "prompt-injection-blocker/blocked-word-12",
        "prompt-injection-blocker/blocked-word-13",
        "prompt-injection-blocker/blocked-word-14",
        "sql-injection-blocker/blocked-word-1",
        "sql-injection-blocker/blocked-word-2",
        "sql-injection-blocker/blocked-word-3",
        "sql-injection-blocker/blocked-word-4",
        "sql-injection-blocker/blocked-word-5",
        "sql-injection-blocker/blocked-word-6",
        "sql-injection-blocker/blocked-word-7",
        "sql-injection-blocker/blocked-word-8",
        "code-injection-blocker/blocked-word-3",
        "code-injection-blocker/blocked-word-4",
        "code-injection-blocker/blocked-word-5",
        "code-injection-blocker/blocked-word-6",
        "code-injection-blocker/blocked-word-7",
        "application/active-html",
        "application/template-traversal",
        "category/prompt_injection_jailbreak",
        "category/prompt_injection_data_exfiltration",
        "category/prompt_injection_sql",
        "category/prompt_injection_malicious_code",
        "category/prompt_injection_system_prompt"
      ],
      "testCaseOverrides": {
        "filter-prompt-injection-sql/accept/prompt_injection_sql": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy rejects and terminates the chain. Assert its Policy/Rule; later Rules must not execute.",
          "expectedDecision": "block",
          "expectedOutputContent": "",
          "expectedMatches": [
            {
              "policyId": "local-injection-protection",
              "ruleId": "sql-injection-blocker/blocked-word-1"
            }
          ]
        },
        "filter-prompt-injection-system-prompt/accept/prompt_injection_system_prompt": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy rejects and terminates the chain. Assert its Policy/Rule; later Rules must not execute.",
          "expectedDecision": "block",
          "expectedOutputContent": "",
          "expectedMatches": [
            {
              "policyId": "local-injection-protection",
              "ruleId": "prompt-injection-blocker/blocked-word-2"
            }
          ]
        }
      },
      "ruleActions": {},
      "enabledRails": [
        "input",
        "output"
      ],
      "reasoningPolicy": null
    },
    {
      "policyId": "local-credentials",
      "policyVersion": "4.2.0",
      "action": null,
      "parameterValues": {},
      "enabledRuleIds": [
        "credentials-api-keys/aws_access_key",
        "credentials-api-keys/aws_secret_key",
        "credentials-api-keys/github_token",
        "credentials-api-keys/slack_token",
        "credentials-api-keys/generic_api_key",
        "credential/bearer-token",
        "credential/private-key-header",
        "credential/hex-token",
        "credential/password"
      ],
      "ruleOrder": [
        "credentials-api-keys/aws_access_key",
        "credentials-api-keys/aws_secret_key",
        "credentials-api-keys/github_token",
        "credentials-api-keys/slack_token",
        "credentials-api-keys/generic_api_key",
        "credential/bearer-token",
        "credential/private-key-header",
        "credential/hex-token",
        "credential/password"
      ],
      "testCaseOverrides": {},
      "ruleActions": {},
      "enabledRails": [
        "input",
        "output"
      ],
      "reasoningPolicy": null
    },
    {
      "policyId": "local-payment-data",
      "policyVersion": "4.0.0",
      "action": null,
      "parameterValues": {},
      "enabledRuleIds": [
        "financial-pii/credit_card",
        "financial-pii/iban",
        "pattern/ca_bank_account",
        "pattern/sg_bank_account"
      ],
      "ruleOrder": [
        "financial-pii/credit_card",
        "financial-pii/iban",
        "pattern/ca_bank_account",
        "pattern/sg_bank_account"
      ],
      "testCaseOverrides": {
        "local-bank-account-formats/accept/ca_bank_account/input": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Bank account [ca_bank_account_REDACTED].",
          "expectedMatches": [
            {
              "policyId": "local-payment-data",
              "ruleId": "pattern/ca_bank_account"
            }
          ]
        },
        "local-bank-account-formats/accept/ca_bank_account/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Bank account [ca_bank_account_REDACTED].",
          "expectedMatches": [
            {
              "policyId": "local-payment-data",
              "ruleId": "pattern/ca_bank_account"
            }
          ]
        },
        "pattern-matching/accept/ca_bank_account": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Bank account [ca_bank_account_REDACTED].",
          "expectedMatches": [
            {
              "policyId": "local-payment-data",
              "ruleId": "pattern/ca_bank_account"
            }
          ]
        },
        "pattern-matching/accept/ca_bank_account/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Bank account [ca_bank_account_REDACTED].",
          "expectedMatches": [
            {
              "policyId": "local-payment-data",
              "ruleId": "pattern/ca_bank_account"
            }
          ]
        }
      },
      "ruleActions": {},
      "enabledRails": [
        "input",
        "output"
      ],
      "reasoningPolicy": null
    },
    {
      "policyId": "local-government-identifiers",
      "policyVersion": "4.0.0",
      "action": null,
      "parameterValues": {},
      "enabledRuleIds": [
        "au-pii-tax-identifiers/au_tfn",
        "au-pii-tax-identifiers/au_abn",
        "au-pii-tax-identifiers/au_medicare",
        "pattern/uae_emirates_id",
        "pattern/ca_on_drivers_licence",
        "pattern/ca_immigration_doc",
        "pattern/fr_nir",
        "pattern/uoft_tcard",
        "pattern/sg_uen",
        "pattern/ca_ohip",
        "pattern/ca_sin",
        "pattern/eu_vat",
        "pattern/nl_bsn_contextual",
        "pattern/au_tfn",
        "pattern/uoft_student_id",
        "pattern/us_ssn",
        "pattern/us_ssn_no_dash",
        "pattern/br_cpf",
        "pattern/br_cpf_unformatted",
        "pattern/br_cnpj",
        "pattern/br_rg",
        "pattern/sg_nric",
        "pattern/uoft_utorid"
      ],
      "ruleOrder": [
        "au-pii-tax-identifiers/au_tfn",
        "au-pii-tax-identifiers/au_abn",
        "au-pii-tax-identifiers/au_medicare",
        "pattern/uae_emirates_id",
        "pattern/ca_on_drivers_licence",
        "pattern/ca_immigration_doc",
        "pattern/fr_nir",
        "pattern/uoft_tcard",
        "pattern/sg_uen",
        "pattern/ca_ohip",
        "pattern/ca_sin",
        "pattern/eu_vat",
        "pattern/nl_bsn_contextual",
        "pattern/au_tfn",
        "pattern/uoft_student_id",
        "pattern/us_ssn",
        "pattern/us_ssn_no_dash",
        "pattern/br_cpf",
        "pattern/br_cpf_unformatted",
        "pattern/br_cnpj",
        "pattern/br_rg",
        "pattern/sg_nric",
        "pattern/uoft_utorid"
      ],
      "testCaseOverrides": {
        "local-australian-tax-health-identifiers/rule-au-pii-tax-identifiers/au_abn-acceptance/input": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [au_abn_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_abn"
            }
          ]
        },
        "local-australian-tax-health-identifiers/rule-au-pii-tax-identifiers/au_abn-acceptance/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [au_abn_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_abn"
            }
          ]
        },
        "local-australian-tax-health-identifiers/rule-au-pii-tax-identifiers/au_medicare-acceptance/input": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [au_medicare_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_medicare"
            }
          ]
        },
        "local-australian-tax-health-identifiers/rule-au-pii-tax-identifiers/au_medicare-acceptance/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [au_medicare_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_medicare"
            }
          ]
        },
        "accept/nl_bsn_contextual/input": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: BSN [nl_bsn_contextual_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/nl_bsn_contextual"
            }
          ]
        },
        "accept/nl_bsn_contextual/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: BSN [nl_bsn_contextual_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/nl_bsn_contextual"
            }
          ]
        },
        "accept/br_cpf_unformatted/input": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [au_abn_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_abn"
            }
          ]
        },
        "accept/br_cpf_unformatted/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [au_abn_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_abn"
            }
          ]
        },
        "accept/au_tfn/input": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Tax file number [au_tfn_REDACTED].",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_tfn"
            }
          ]
        },
        "accept/au_tfn/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Tax file number [au_tfn_REDACTED].",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_tfn"
            }
          ]
        },
        "accept/au_abn/input": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [au_abn_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_abn"
            }
          ]
        },
        "accept/au_abn/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [au_abn_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_abn"
            }
          ]
        },
        "accept/au_medicare/input": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [au_medicare_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_medicare"
            }
          ]
        },
        "accept/au_medicare/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [au_medicare_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_medicare"
            }
          ]
        },
        "accept/fr_nir/input": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [fr_nir_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/fr_nir"
            }
          ]
        },
        "accept/fr_nir/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [fr_nir_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/fr_nir"
            }
          ]
        },
        "accept/eu_vat/input": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: VAT [eu_vat_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/eu_vat"
            }
          ]
        },
        "accept/eu_vat/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: VAT [eu_vat_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/eu_vat"
            }
          ]
        },
        "accept/uae_emirates_id/input": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [uae_emirates_id_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/uae_emirates_id"
            }
          ]
        },
        "accept/uae_emirates_id/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [uae_emirates_id_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/uae_emirates_id"
            }
          ]
        },
        "accept/sg_uen/input": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: UEN [sg_uen_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/sg_uen"
            }
          ]
        },
        "accept/sg_uen/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: UEN [sg_uen_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/sg_uen"
            }
          ]
        },
        "accept/ca_on_drivers_licence/input": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Driver's licence [ca_on_drivers_licence_REDACTED].",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/ca_on_drivers_licence"
            }
          ]
        },
        "accept/ca_on_drivers_licence/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Driver's licence [ca_on_drivers_licence_REDACTED].",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/ca_on_drivers_licence"
            }
          ]
        },
        "accept/ca_immigration_doc/input": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "UCI [ca_immigration_doc_REDACTED].",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/ca_immigration_doc"
            }
          ]
        },
        "accept/ca_immigration_doc/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "UCI [ca_immigration_doc_REDACTED].",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/ca_immigration_doc"
            }
          ]
        },
        "accept/uoft_student_id/input": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "University of Toronto student number [au_medicare_REDACTED].",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_medicare"
            }
          ]
        },
        "accept/uoft_student_id/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "University of Toronto student number [au_medicare_REDACTED].",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_medicare"
            }
          ]
        },
        "accept/uoft_tcard/input": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "TCard number [uoft_tcard_REDACTED].",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/uoft_tcard"
            }
          ]
        },
        "accept/uoft_tcard/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "TCard number [uoft_tcard_REDACTED].",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/uoft_tcard"
            }
          ]
        },
        "advanced-au-pii-protection/rule-au-pii-tax-identifiers/au_abn-acceptance": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [au_abn_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_abn"
            }
          ]
        },
        "advanced-au-pii-protection/rule-au-pii-tax-identifiers/au_medicare-acceptance": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [au_medicare_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_medicare"
            }
          ]
        },
        "baseline-pii-protection/rule-au-pii-tax-identifiers/au_abn-acceptance": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [au_abn_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_abn"
            }
          ]
        },
        "baseline-pii-protection/rule-au-pii-tax-identifiers/au_medicare-acceptance": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [au_medicare_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_medicare"
            }
          ]
        },
        "pattern-matching/accept/nl_bsn_contextual": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: BSN [nl_bsn_contextual_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/nl_bsn_contextual"
            }
          ]
        },
        "pattern-matching/accept/br_cpf_unformatted": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [au_abn_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_abn"
            }
          ]
        },
        "pattern-matching/accept/au_tfn": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Tax file number [au_tfn_REDACTED].",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_tfn"
            }
          ]
        },
        "pattern-matching/accept/au_abn": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [au_abn_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_abn"
            }
          ]
        },
        "pattern-matching/accept/au_medicare": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [au_medicare_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_medicare"
            }
          ]
        },
        "pattern-matching/accept/fr_nir": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [fr_nir_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/fr_nir"
            }
          ]
        },
        "pattern-matching/accept/eu_vat": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: VAT [eu_vat_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/eu_vat"
            }
          ]
        },
        "pattern-matching/accept/uae_emirates_id": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [uae_emirates_id_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/uae_emirates_id"
            }
          ]
        },
        "pattern-matching/accept/sg_uen": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: UEN [sg_uen_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/sg_uen"
            }
          ]
        },
        "pattern-matching/accept/ca_on_drivers_licence": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Driver's licence [ca_on_drivers_licence_REDACTED].",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/ca_on_drivers_licence"
            }
          ]
        },
        "pattern-matching/accept/ca_immigration_doc": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "UCI [ca_immigration_doc_REDACTED].",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/ca_immigration_doc"
            }
          ]
        },
        "pattern-matching/accept/uoft_student_id": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "University of Toronto student number [au_medicare_REDACTED].",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_medicare"
            }
          ]
        },
        "pattern-matching/accept/uoft_tcard": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "TCard number [uoft_tcard_REDACTED].",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/uoft_tcard"
            }
          ]
        },
        "pattern-matching/accept/nl_bsn_contextual/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: BSN [nl_bsn_contextual_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/nl_bsn_contextual"
            }
          ]
        },
        "pattern-matching/accept/br_cpf_unformatted/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [au_abn_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_abn"
            }
          ]
        },
        "pattern-matching/accept/au_tfn/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Tax file number [au_tfn_REDACTED].",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_tfn"
            }
          ]
        },
        "pattern-matching/accept/au_abn/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [au_abn_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_abn"
            }
          ]
        },
        "pattern-matching/accept/au_medicare/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [au_medicare_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_medicare"
            }
          ]
        },
        "pattern-matching/accept/fr_nir/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [fr_nir_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/fr_nir"
            }
          ]
        },
        "pattern-matching/accept/eu_vat/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: VAT [eu_vat_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/eu_vat"
            }
          ]
        },
        "pattern-matching/accept/uae_emirates_id/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [uae_emirates_id_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/uae_emirates_id"
            }
          ]
        },
        "pattern-matching/accept/sg_uen/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: UEN [sg_uen_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/sg_uen"
            }
          ]
        },
        "pattern-matching/accept/ca_on_drivers_licence/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Driver's licence [ca_on_drivers_licence_REDACTED].",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/ca_on_drivers_licence"
            }
          ]
        },
        "pattern-matching/accept/ca_immigration_doc/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "UCI [ca_immigration_doc_REDACTED].",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/ca_immigration_doc"
            }
          ]
        },
        "pattern-matching/accept/uoft_student_id/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "University of Toronto student number [au_medicare_REDACTED].",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_medicare"
            }
          ]
        },
        "pattern-matching/accept/uoft_tcard/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "TCard number [uoft_tcard_REDACTED].",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/uoft_tcard"
            }
          ]
        },
        "uae-regulatory-compliance/rule-uae-data-protection-pii/uae_emirates_id-acceptance": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [uae_emirates_id_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "pattern/uae_emirates_id"
            }
          ]
        }
      },
      "ruleActions": {},
      "enabledRails": [
        "input",
        "output"
      ],
      "reasoningPolicy": null
    },
    {
      "policyId": "local-passports",
      "policyVersion": "4.0.0",
      "action": null,
      "parameterValues": {},
      "enabledRuleIds": [
        "pattern/passport_singapore",
        "pattern/passport_china",
        "pattern/passport_us",
        "pattern/passport_germany",
        "pattern/passport_france",
        "pattern/passport_netherlands",
        "pattern/passport_canada",
        "pattern/passport_india",
        "identity/passport"
      ],
      "ruleOrder": [
        "pattern/passport_singapore",
        "pattern/passport_china",
        "pattern/passport_us",
        "pattern/passport_germany",
        "pattern/passport_france",
        "pattern/passport_netherlands",
        "pattern/passport_canada",
        "pattern/passport_india",
        "identity/passport"
      ],
      "testCaseOverrides": {
        "local-passport-formats/accept/passport_china/input": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [passport_china_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-passports",
              "ruleId": "pattern/passport_china"
            }
          ]
        },
        "local-passport-formats/accept/passport_china/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [passport_china_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-passports",
              "ruleId": "pattern/passport_china"
            }
          ]
        },
        "passport-en/input": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Passport: [passport_china_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-passports",
              "ruleId": "pattern/passport_china"
            }
          ]
        },
        "passport-en/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Passport: [passport_china_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-passports",
              "ruleId": "pattern/passport_china"
            }
          ]
        },
        "passport-zh/input": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "护照号码：[passport_india_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-passports",
              "ruleId": "pattern/passport_india"
            }
          ]
        },
        "passport-zh/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "护照号码：[passport_india_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-passports",
              "ruleId": "pattern/passport_india"
            }
          ]
        },
        "passport-mixed/input": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Passport number: [passport_france_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-passports",
              "ruleId": "pattern/passport_france"
            }
          ]
        },
        "passport-mixed/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Passport number: [passport_france_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-passports",
              "ruleId": "pattern/passport_france"
            }
          ]
        },
        "advanced-au-pii-protection/rule-international-pii-identifiers/passport_china-acceptance": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [passport_china_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-passports",
              "ruleId": "pattern/passport_china"
            }
          ]
        },
        "pattern-matching/accept/passport_china": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [passport_china_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-passports",
              "ruleId": "pattern/passport_china"
            }
          ]
        },
        "pattern-matching/accept/passport_china/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [passport_china_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-passports",
              "ruleId": "pattern/passport_china"
            }
          ]
        }
      },
      "ruleActions": {},
      "enabledRails": [
        "input",
        "output"
      ],
      "reasoningPolicy": null
    },
    {
      "policyId": "local-contact-data",
      "policyVersion": "4.3.0",
      "action": null,
      "parameterValues": {},
      "enabledRuleIds": [
        "pattern/sg_phone",
        "pattern/uae_phone",
        "pattern/fr_phone",
        "pattern/br_phone_mobile",
        "pattern/br_phone_landline",
        "pattern/br_cep",
        "pattern/fr_postal_code",
        "pattern/street_address",
        "pattern/sg_postal_code",
        "pattern/ca_postal_code",
        "pattern/email",
        "pattern/us_phone"
      ],
      "ruleOrder": [
        "pattern/sg_phone",
        "pattern/uae_phone",
        "pattern/fr_phone",
        "pattern/br_phone_mobile",
        "pattern/br_phone_landline",
        "pattern/br_cep",
        "pattern/fr_postal_code",
        "pattern/street_address",
        "pattern/sg_postal_code",
        "pattern/ca_postal_code",
        "pattern/email",
        "pattern/us_phone"
      ],
      "testCaseOverrides": {
        "local-regional-contact-formats/accept/br_phone_mobile/input": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [br_phone_mobile_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/br_phone_mobile"
            }
          ]
        },
        "local-regional-contact-formats/accept/br_phone_mobile/output": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [br_phone_mobile_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/br_phone_mobile"
            }
          ]
        },
        "local-regional-contact-formats/accept/fr_phone/input": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: +[au_abn_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_abn"
            }
          ]
        },
        "local-regional-contact-formats/accept/fr_phone/output": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: +[au_abn_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_abn"
            }
          ]
        },
        "local-regional-contact-formats/accept/uae_phone/input": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [uae_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/uae_phone"
            }
          ]
        },
        "local-regional-contact-formats/accept/uae_phone/output": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [uae_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/uae_phone"
            }
          ]
        },
        "local-regional-contact-formats/accept/sg_phone/input": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [sg_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/sg_phone"
            }
          ]
        },
        "local-regional-contact-formats/accept/sg_phone/output": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [sg_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/sg_phone"
            }
          ]
        },
        "advanced-au-pii-protection/rule-contact-information-pii/br_phone_mobile-acceptance": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [br_phone_mobile_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/br_phone_mobile"
            }
          ]
        },
        "gdpr-eu-pii-protection/rule-gdpr-eu-contact-information/fr_phone-acceptance": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: +[au_abn_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_abn"
            }
          ]
        },
        "pattern-matching/accept/br_phone_mobile": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [br_phone_mobile_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/br_phone_mobile"
            }
          ]
        },
        "pattern-matching/accept/fr_phone": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: +[au_abn_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_abn"
            }
          ]
        },
        "pattern-matching/accept/uae_phone": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [uae_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/uae_phone"
            }
          ]
        },
        "pattern-matching/accept/sg_phone": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [sg_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/sg_phone"
            }
          ]
        },
        "pattern-matching/accept/br_phone_mobile/output": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [br_phone_mobile_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/br_phone_mobile"
            }
          ]
        },
        "pattern-matching/accept/fr_phone/output": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "The earlier configured Policy redacts the complete sensitive value. Assert its Policy/Rule and the complete output instead of detecting already-redacted text again.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: +[au_abn_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-government-identifiers",
              "ruleId": "au-pii-tax-identifiers/au_abn"
            }
          ]
        },
        "pattern-matching/accept/uae_phone/output": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [uae_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/uae_phone"
            }
          ]
        },
        "pattern-matching/accept/sg_phone/output": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [sg_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/sg_phone"
            }
          ]
        },
        "pdpa-singapore/rule-sg-pdpa-contact-information/sg_phone-acceptance": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [sg_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/sg_phone"
            }
          ]
        },
        "singapore-customer-identifiers/rule-sg-pdpa-contact-information/sg_phone-acceptance/input": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [sg_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/sg_phone"
            }
          ]
        },
        "singapore-customer-identifiers/rule-sg-pdpa-contact-information/sg_phone-acceptance/output": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [sg_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/sg_phone"
            }
          ]
        },
        "uae-regulatory-compliance/rule-uae-data-protection-pii/uae_phone-acceptance": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "Require complete identifier redaction, not merely a transform decision or a partially masked value.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [uae_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/uae_phone"
            }
          ]
        },
        "advanced-au-pii-protection/rule-contact-information-pii/br_phone_landline-acceptance": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "The Brazilian mobile detector precedes the landline detector and covers this shared sample. Require complete redaction and the first matching Rule.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [br_phone_mobile_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/br_phone_mobile"
            }
          ]
        },
        "pattern-matching/accept/br_phone_landline": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "The Brazilian mobile detector precedes the landline detector and covers this shared sample. Require complete redaction and the first matching Rule.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [br_phone_mobile_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/br_phone_mobile"
            }
          ]
        },
        "pattern-matching/accept/br_phone_landline/output": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "The Brazilian mobile detector precedes the landline detector and covers this shared sample. Require complete redaction and the first matching Rule.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [br_phone_mobile_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/br_phone_mobile"
            }
          ]
        }
      },
      "ruleActions": {},
      "enabledRails": [
        "input",
        "output"
      ],
      "reasoningPolicy": null
    },
    {
      "policyId": "local-network-addresses",
      "policyVersion": "4.0.0",
      "action": null,
      "parameterValues": {},
      "enabledRuleIds": [
        "pattern/ipv4",
        "pattern/ipv6",
        "pattern/url"
      ],
      "ruleOrder": [
        "pattern/ipv4",
        "pattern/ipv6",
        "pattern/url"
      ],
      "testCaseOverrides": {},
      "ruleActions": {},
      "enabledRails": [
        "input",
        "output"
      ],
      "reasoningPolicy": null
    },
    {
      "policyId": "local-sensitive-attribute-terms",
      "policyVersion": "4.1.0",
      "action": null,
      "parameterValues": {},
      "enabledRuleIds": [
        "pattern/gender_sexual_orientation",
        "pattern/race_ethnicity_national_origin",
        "pattern/religion",
        "pattern/age_discrimination",
        "pattern/disability",
        "pattern/marital_family_status",
        "pattern/military_status",
        "pattern/public_assistance"
      ],
      "ruleOrder": [
        "pattern/gender_sexual_orientation",
        "pattern/race_ethnicity_national_origin",
        "pattern/religion",
        "pattern/age_discrimination",
        "pattern/disability",
        "pattern/marital_family_status",
        "pattern/military_status",
        "pattern/public_assistance"
      ],
      "testCaseOverrides": {
        "accept/religion/input": {
          "sourcePolicyVersion": "4.1.0",
          "reason": "The earlier configured Policy rejects and terminates the chain. Assert its Policy/Rule; later Rules must not execute.",
          "expectedDecision": "block",
          "expectedOutputContent": "",
          "expectedMatches": [
            {
              "policyId": "local-content-safety",
              "ruleId": "category/bias_religious"
            }
          ]
        },
        "accept/religion/output": {
          "sourcePolicyVersion": "4.1.0",
          "reason": "The earlier configured Policy rejects and terminates the chain. Assert its Policy/Rule; later Rules must not execute.",
          "expectedDecision": "block",
          "expectedOutputContent": "",
          "expectedMatches": [
            {
              "policyId": "local-content-safety",
              "ruleId": "category/bias_religious"
            }
          ]
        },
        "pattern-matching/accept/religion": {
          "sourcePolicyVersion": "4.1.0",
          "reason": "The earlier configured Policy rejects and terminates the chain. Assert its Policy/Rule; later Rules must not execute.",
          "expectedDecision": "block",
          "expectedOutputContent": "",
          "expectedMatches": [
            {
              "policyId": "local-content-safety",
              "ruleId": "category/bias_religious"
            }
          ]
        },
        "pattern-matching/accept/religion/output": {
          "sourcePolicyVersion": "4.1.0",
          "reason": "The earlier configured Policy rejects and terminates the chain. Assert its Policy/Rule; later Rules must not execute.",
          "expectedDecision": "block",
          "expectedOutputContent": "",
          "expectedMatches": [
            {
              "policyId": "local-content-safety",
              "ruleId": "category/bias_religious"
            }
          ]
        }
      },
      "ruleActions": {},
      "enabledRails": [
        "input",
        "output"
      ],
      "reasoningPolicy": null
    },
    {
      "policyId": "local-risk-content-terms",
      "policyVersion": "4.0.0",
      "action": null,
      "parameterValues": {},
      "enabledRuleIds": [
        "pattern/explosives",
        "pattern/weapons_firearms",
        "pattern/weapons_other",
        "pattern/violence_threats",
        "pattern/terrorism",
        "pattern/self_harm_suicide",
        "pattern/illegal_activities",
        "pattern/harassment_hate"
      ],
      "ruleOrder": [
        "pattern/explosives",
        "pattern/weapons_firearms",
        "pattern/weapons_other",
        "pattern/violence_threats",
        "pattern/terrorism",
        "pattern/self_harm_suicide",
        "pattern/illegal_activities",
        "pattern/harassment_hate"
      ],
      "testCaseOverrides": {
        "accept/weapons_firearms/input": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy rejects and terminates the chain. Assert its Policy/Rule; later Rules must not execute.",
          "expectedDecision": "block",
          "expectedOutputContent": "",
          "expectedMatches": [
            {
              "policyId": "local-content-safety",
              "ruleId": "category/harmful_illegal_weapons"
            }
          ]
        },
        "accept/weapons_firearms/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy rejects and terminates the chain. Assert its Policy/Rule; later Rules must not execute.",
          "expectedDecision": "block",
          "expectedOutputContent": "",
          "expectedMatches": [
            {
              "policyId": "local-content-safety",
              "ruleId": "category/harmful_illegal_weapons"
            }
          ]
        },
        "accept/explosives/input": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy rejects and terminates the chain. Assert its Policy/Rule; later Rules must not execute.",
          "expectedDecision": "block",
          "expectedOutputContent": "",
          "expectedMatches": [
            {
              "policyId": "local-content-safety",
              "ruleId": "category/harmful_illegal_weapons"
            }
          ]
        },
        "accept/explosives/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy rejects and terminates the chain. Assert its Policy/Rule; later Rules must not execute.",
          "expectedDecision": "block",
          "expectedOutputContent": "",
          "expectedMatches": [
            {
              "policyId": "local-content-safety",
              "ruleId": "category/harmful_illegal_weapons"
            }
          ]
        },
        "accept/terrorism/input": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy rejects and terminates the chain. Assert its Policy/Rule; later Rules must not execute.",
          "expectedDecision": "block",
          "expectedOutputContent": "",
          "expectedMatches": [
            {
              "policyId": "local-content-safety",
              "ruleId": "category/harmful_violence"
            }
          ]
        },
        "accept/terrorism/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy rejects and terminates the chain. Assert its Policy/Rule; later Rules must not execute.",
          "expectedDecision": "block",
          "expectedOutputContent": "",
          "expectedMatches": [
            {
              "policyId": "local-content-safety",
              "ruleId": "category/harmful_violence"
            }
          ]
        },
        "accept/self_harm_suicide/input": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy rejects and terminates the chain. Assert its Policy/Rule; later Rules must not execute.",
          "expectedDecision": "block",
          "expectedOutputContent": "",
          "expectedMatches": [
            {
              "policyId": "local-content-safety",
              "ruleId": "category/harmful_self_harm"
            }
          ]
        },
        "accept/self_harm_suicide/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy rejects and terminates the chain. Assert its Policy/Rule; later Rules must not execute.",
          "expectedDecision": "block",
          "expectedOutputContent": "",
          "expectedMatches": [
            {
              "policyId": "local-content-safety",
              "ruleId": "category/harmful_self_harm"
            }
          ]
        },
        "pattern-matching/accept/weapons_firearms": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy rejects and terminates the chain. Assert its Policy/Rule; later Rules must not execute.",
          "expectedDecision": "block",
          "expectedOutputContent": "",
          "expectedMatches": [
            {
              "policyId": "local-content-safety",
              "ruleId": "category/harmful_illegal_weapons"
            }
          ]
        },
        "pattern-matching/accept/explosives": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy rejects and terminates the chain. Assert its Policy/Rule; later Rules must not execute.",
          "expectedDecision": "block",
          "expectedOutputContent": "",
          "expectedMatches": [
            {
              "policyId": "local-content-safety",
              "ruleId": "category/harmful_illegal_weapons"
            }
          ]
        },
        "pattern-matching/accept/terrorism": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy rejects and terminates the chain. Assert its Policy/Rule; later Rules must not execute.",
          "expectedDecision": "block",
          "expectedOutputContent": "",
          "expectedMatches": [
            {
              "policyId": "local-content-safety",
              "ruleId": "category/harmful_violence"
            }
          ]
        },
        "pattern-matching/accept/self_harm_suicide": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy rejects and terminates the chain. Assert its Policy/Rule; later Rules must not execute.",
          "expectedDecision": "block",
          "expectedOutputContent": "",
          "expectedMatches": [
            {
              "policyId": "local-content-safety",
              "ruleId": "category/harmful_self_harm"
            }
          ]
        },
        "pattern-matching/accept/weapons_firearms/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy rejects and terminates the chain. Assert its Policy/Rule; later Rules must not execute.",
          "expectedDecision": "block",
          "expectedOutputContent": "",
          "expectedMatches": [
            {
              "policyId": "local-content-safety",
              "ruleId": "category/harmful_illegal_weapons"
            }
          ]
        },
        "pattern-matching/accept/explosives/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy rejects and terminates the chain. Assert its Policy/Rule; later Rules must not execute.",
          "expectedDecision": "block",
          "expectedOutputContent": "",
          "expectedMatches": [
            {
              "policyId": "local-content-safety",
              "ruleId": "category/harmful_illegal_weapons"
            }
          ]
        },
        "pattern-matching/accept/terrorism/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy rejects and terminates the chain. Assert its Policy/Rule; later Rules must not execute.",
          "expectedDecision": "block",
          "expectedOutputContent": "",
          "expectedMatches": [
            {
              "policyId": "local-content-safety",
              "ruleId": "category/harmful_violence"
            }
          ]
        },
        "pattern-matching/accept/self_harm_suicide/output": {
          "sourcePolicyVersion": "4.0.0",
          "reason": "The earlier configured Policy rejects and terminates the chain. Assert its Policy/Rule; later Rules must not execute.",
          "expectedDecision": "block",
          "expectedOutputContent": "",
          "expectedMatches": [
            {
              "policyId": "local-content-safety",
              "ruleId": "category/harmful_self_harm"
            }
          ]
        }
      },
      "ruleActions": {},
      "enabledRails": [
        "input",
        "output"
      ],
      "reasoningPolicy": null
    }
  ],
  "draftSettings": {
    "topicControlMode": "strict",
    "allowedTopics": [],
    "restrictedTopics": [],
    "safetyLevel": "balanced",
    "outputDelivery": "full_buffered"
  },
  "suggestedTopics": [],
  "optionalPolicyIds": [],
  "limitations": [
    "Local Rules do not provide model-based semantic detection."
  ]
} satisfies GuardrailProfile;
