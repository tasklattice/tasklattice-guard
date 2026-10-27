import type { GuardrailProfile } from "./protection-map.js";

// Version 2 adds the benchmark-family protections to the frozen PII baseline.
// Policy versions, Rule selections and Topic defaults are explicit snapshots.
export const fullFeatureBaseline: GuardrailProfile = {
  "id": "full-feature-baseline",
  "version": "2.0.0",
  "name": "Full-feature baseline",
  "description": "Start with credentials, personal data, semantic PII, input and output content safety, jailbreak, direct and indirect injection, memory poisoning, data-use boundaries and a harmful-task denylist. Remove protections you do not need.",
  "industry": "general",
  "jurisdictions": [],
  "policies": [
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
        "credential/password",
        "credential/url-password",
        "credential/basic-auth",
        "credential/jwt",
        "credential/labelled-hex-key",
        "credential/private-jwk",
        "credential/sql-password",
        "credential/command-password",
        "credential/nkey-seed",
        "credential/base64-private-key"
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
        "credential/password",
        "credential/url-password",
        "credential/basic-auth",
        "credential/jwt",
        "credential/labelled-hex-key",
        "credential/private-jwk",
        "credential/sql-password",
        "credential/command-password",
        "credential/nkey-seed",
        "credential/base64-private-key"
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
        },
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
        },
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
        },
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
        "pattern/titled_person",
        "pattern/contact_list_person",
        "pattern/truncated_address",
        "pattern/structured_username",
        "pattern/structured_address",
        "pattern/labelled_person",
        "pattern/international_phone",
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
        "pattern/titled_person",
        "pattern/contact_list_person",
        "pattern/truncated_address",
        "pattern/structured_username",
        "pattern/structured_address",
        "pattern/labelled_person",
        "pattern/international_phone",
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
        "pattern-matching/accept/sg_phone": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "The explicitly enabled full international phone rule runs before regional suffix rules. Require unchanged Transform, complete value removal and exact first-rule evidence.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [international_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/international_phone"
            }
          ]
        },
        "pattern-matching/accept/uae_phone": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "The explicitly enabled full international phone rule runs before regional suffix rules. Require unchanged Transform, complete value removal and exact first-rule evidence.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [international_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/international_phone"
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
        "pattern-matching/accept/sg_phone/output": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "The explicitly enabled full international phone rule runs before regional suffix rules. Require unchanged Transform, complete value removal and exact first-rule evidence.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [international_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/international_phone"
            }
          ]
        },
        "pattern-matching/accept/uae_phone/output": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "The explicitly enabled full international phone rule runs before regional suffix rules. Require unchanged Transform, complete value removal and exact first-rule evidence.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [international_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/international_phone"
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
        "local-regional-contact-formats/accept/sg_phone/input": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "The explicitly enabled full international phone rule runs before regional suffix rules. Require unchanged Transform, complete value removal and exact first-rule evidence.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [international_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/international_phone"
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
        "local-regional-contact-formats/accept/sg_phone/output": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "The explicitly enabled full international phone rule runs before regional suffix rules. Require unchanged Transform, complete value removal and exact first-rule evidence.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [international_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/international_phone"
            }
          ]
        },
        "local-regional-contact-formats/accept/uae_phone/input": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "The explicitly enabled full international phone rule runs before regional suffix rules. Require unchanged Transform, complete value removal and exact first-rule evidence.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [international_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/international_phone"
            }
          ]
        },
        "local-regional-contact-formats/accept/uae_phone/output": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "The explicitly enabled full international phone rule runs before regional suffix rules. Require unchanged Transform, complete value removal and exact first-rule evidence.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [international_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/international_phone"
            }
          ]
        },
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
        "pdpa-singapore/rule-sg-pdpa-contact-information/sg_phone-acceptance": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "The explicitly enabled full international phone rule runs before regional suffix rules. Require unchanged Transform, complete value removal and exact first-rule evidence.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [international_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/international_phone"
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
        "uae-regulatory-compliance/rule-uae-data-protection-pii/uae_phone-acceptance": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "The explicitly enabled full international phone rule runs before regional suffix rules. Require unchanged Transform, complete value removal and exact first-rule evidence.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [international_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/international_phone"
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
        "singapore-customer-identifiers/rule-sg-pdpa-contact-information/sg_phone-acceptance/input": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "The explicitly enabled full international phone rule runs before regional suffix rules. Require unchanged Transform, complete value removal and exact first-rule evidence.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [international_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/international_phone"
            }
          ]
        },
        "singapore-customer-identifiers/rule-sg-pdpa-contact-information/sg_phone-acceptance/output": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "The explicitly enabled full international phone rule runs before regional suffix rules. Require unchanged Transform, complete value removal and exact first-rule evidence.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [international_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/international_phone"
            }
          ]
        },
        "pattern-matching/accept/us_phone": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "The explicitly enabled full international phone rule runs before regional suffix rules. Require unchanged Transform, complete value removal and exact first-rule evidence.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [international_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/international_phone"
            }
          ]
        },
        "advanced-au-pii-protection/rule-contact-information-pii/us_phone-acceptance": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "The explicitly enabled full international phone rule runs before regional suffix rules. Require unchanged Transform, complete value removal and exact first-rule evidence.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [international_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/international_phone"
            }
          ]
        },
        "accept/us_phone/output": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "The explicitly enabled full international phone rule runs before regional suffix rules. Require unchanged Transform, complete value removal and exact first-rule evidence.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [international_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/international_phone"
            }
          ]
        },
        "pattern-matching/accept/us_phone/output": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "The explicitly enabled full international phone rule runs before regional suffix rules. Require unchanged Transform, complete value removal and exact first-rule evidence.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [international_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/international_phone"
            }
          ]
        },
        "accept/us_phone/input": {
          "sourcePolicyVersion": "4.3.0",
          "reason": "The explicitly enabled full international phone rule runs before regional suffix rules. Require unchanged Transform, complete value removal and exact first-rule evidence.",
          "expectedDecision": "transform",
          "expectedOutputContent": "Acceptance sample: [international_phone_REDACTED]",
          "expectedMatches": [
            {
              "policyId": "local-contact-data",
              "ruleId": "pattern/international_phone"
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
        "pattern/ipv6"
      ],
      "ruleOrder": [
        "pattern/ipv4",
        "pattern/ipv6"
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
      "policyId": "builtin-jailbreak-strict",
      "policyVersion": "1.0.0",
      "action": "block",
      "parameterValues": {
        "on_unknown": "block"
      },
      "enabledRuleIds": [
        "model/jailbreak"
      ],
      "ruleOrder": [
        "model/jailbreak"
      ],
      "testCaseOverrides": {},
      "ruleActions": {},
      "enabledRails": [
        "input"
      ],
      "reasoningPolicy": null
    },
    {
      "policyId": "builtin-content-safety",
      "policyVersion": "1.0.0",
      "action": "block",
      "parameterValues": {},
      "enabledRuleIds": [
        "model/content-safety"
      ],
      "ruleOrder": [
        "model/content-safety"
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
        "category/prompt_injection_system_prompt",
        "cn-prompt-security/instruction-override",
        "cn-prompt-security/prompt-extraction",
        "cn-prompt-security/unrestricted-mode",
        "claims-system-override-filter/claims_system_override",
        "code-injection-blocker/blocked-word-1",
        "code-injection-blocker/blocked-word-2"
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
        "category/prompt_injection_system_prompt",
        "cn-prompt-security/instruction-override",
        "cn-prompt-security/prompt-extraction",
        "cn-prompt-security/unrestricted-mode",
        "claims-system-override-filter/claims_system_override",
        "code-injection-blocker/blocked-word-1",
        "code-injection-blocker/blocked-word-2"
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
      "policyId": "builtin-pii",
      "policyVersion": "1.1.0",
      "action": null,
      "parameterValues": {},
      "enabledRuleIds": [
        "model/pii"
      ],
      "ruleOrder": [
        "model/pii"
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
      "policyId": "local-data-use-boundaries",
      "policyVersion": "4.0.0",
      "action": null,
      "parameterValues": {},
      "enabledRuleIds": [
        "claims-phi-disclosure-filter/claims_phi_disclosure",
        "sg-pdpa-personal-identifiers/sg_pdpa_personal_identifiers",
        "sg-pdpa-sensitive-data/sg_pdpa_sensitive_data",
        "sg-pdpa-do-not-call/sg_pdpa_do_not_call",
        "sg-pdpa-data-transfer/sg_pdpa_data_transfer",
        "sg-pdpa-profiling-automated-decisions/sg_pdpa_profiling_automated_decisions"
      ],
      "ruleOrder": [
        "claims-phi-disclosure-filter/claims_phi_disclosure",
        "sg-pdpa-personal-identifiers/sg_pdpa_personal_identifiers",
        "sg-pdpa-sensitive-data/sg_pdpa_sensitive_data",
        "sg-pdpa-do-not-call/sg_pdpa_do_not_call",
        "sg-pdpa-data-transfer/sg_pdpa_data_transfer",
        "sg-pdpa-profiling-automated-decisions/sg_pdpa_profiling_automated_decisions"
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
      "policyId": "builtin-topic-safety",
      "policyVersion": "2.0.0",
      "action": null,
      "parameterValues": {
        "allowed_topics": "",
        "denied_topics": "Instructions to commit violent crime\nInstructions to build or obtain illegal weapons\nFacilitating fraud, credential theft, or unauthorized data exfiltration\nDeploying malware or exploiting systems without authorization\nSexual exploitation or abuse of children\nEncouragement or instructions for suicide or self-harm",
        "topic_mode": "permissive"
      },
      "enabledRuleIds": [
        "topic/denylist"
      ],
      "ruleOrder": [
        "topic/denylist"
      ],
      "testCaseOverrides": {},
      "ruleActions": {},
      "enabledRails": [
        "input"
      ],
      "reasoningPolicy": null
    }
  ],
  "draftSettings": {
    "allowedTopics": [],
    "restrictedTopics": [],
    "topicControlMode": "permissive",
    "safetyLevel": "balanced",
    "outputDelivery": "full_buffered"
  },
  "suggestedTopics": [],
  "optionalPolicyIds": [],
  "limitations": [
    "Model checks reuse platform assignments: jailbreak.input, content_safety.input/output, pii_semantic.input/output and topic_control.input. Missing assignments do not prevent creation or publication; apply compatible models before running model checks.",
    "Indirect injection and memory poisoning require callers to provide retrieved_content or tool_output provenance, plus memory source-query evidence when applicable. Enabling these Policies does not establish an Agent integration or multi-turn benchmark coverage.",
    "Topic Control enables only a prefilled harmful-task denylist. Ordinary topics remain open; adjust these topics for your application.",
    "The original benchmark Policy pins and 106 expectation overlays are retained. Additional protections can change decisions, so rerun tests; this Profile does not inherit benchmark scores or prove complete PII, PHI or attack detection.",
    "Removing Policies, Rules or Rails restores inherited test assertions where expectations depended on removed selections. User-authored invalid references still require review. Failed tests remain publishable."
  ],
  "category": "full_feature",
  "categoryName": "Full-feature baseline",
  "isDefault": true
};
