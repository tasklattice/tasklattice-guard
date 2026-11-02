import type { ProtectionPreset } from "./protection-map.js";

// Profiles select current capability Rules; composition expectations retain first-match evidence.
export const protectionPresets: readonly ProtectionPreset[] = [
  {
    "id": "banking-assistant",
    "version": "1.0.0",
    "name": "Banking customer service",
    "industry": "banking",
    "jurisdictions": [],
    "description": "Common baseline plus identity-check evasion and misleading investment-guarantee patterns. Banking education stays available.",
    "policies": [
      {
        "policyId": "local-credentials",
        "policyVersion": "1.0.0",
        "enabledRails": [
          "input",
          "output"
        ],
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
        ]
      },
      {
        "policyId": "local-content-safety",
        "policyVersion": "1.0.0",
        "enabledRails": [
          "input",
          "output"
        ],
        "parameterValues": {},
        "enabledRuleIds": [
          "category/denied_insults",
          "category/harmful_self_harm",
          "category/harmful_violence",
          "category/harmful_child_safety",
          "category/harmful_illegal_weapons",
          "category/bias_racial",
          "category/bias_gender",
          "category/bias_religious",
          "category/bias_sexual_orientation",
          "category/harm_toxic_abuse"
        ],
        "ruleOrder": [
          "category/denied_insults",
          "category/harmful_self_harm",
          "category/harmful_violence",
          "category/harmful_child_safety",
          "category/harmful_illegal_weapons",
          "category/bias_racial",
          "category/bias_gender",
          "category/bias_religious",
          "category/bias_sexual_orientation",
          "category/harm_toxic_abuse"
        ]
      },
      {
        "policyId": "local-injection-protection",
        "policyVersion": "1.0.0",
        "enabledRails": [
          "input",
          "output"
        ],
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
          "category/prompt_injection_data_exfiltration"
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
          "category/prompt_injection_data_exfiltration"
        ]
      },
      {
        "policyId": "local-payment-data",
        "policyVersion": "1.0.0",
        "enabledRails": [
          "input",
          "output"
        ],
        "parameterValues": {},
        "enabledRuleIds": [
          "financial-pii/credit_card",
          "financial-pii/iban"
        ],
        "ruleOrder": [
          "financial-pii/credit_card",
          "financial-pii/iban"
        ]
      },
      {
        "policyId": "local-passports",
        "policyVersion": "1.0.0",
        "enabledRails": [
          "input",
          "output"
        ],
        "parameterValues": {},
        "enabledRuleIds": [
          "identity/passport"
        ],
        "ruleOrder": [
          "identity/passport"
        ]
      },
      {
        "policyId": "local-contact-data",
        "policyVersion": "1.0.0",
        "enabledRails": [
          "input",
          "output"
        ],
        "parameterValues": {},
        "enabledRuleIds": [
          "pattern/email",
          "pattern/us_phone"
        ],
        "ruleOrder": [
          "pattern/email",
          "pattern/us_phone"
        ]
      },
      {
        "policyId": "local-fraud-prevention",
        "policyVersion": "1.0.0",
        "enabledRails": [
          "input",
          "output"
        ],
        "parameterValues": {},
        "enabledRuleIds": [
          "banking/identity-evasion",
          "banking/return-guarantee"
        ],
        "ruleOrder": [
          "banking/identity-evasion",
          "banking/return-guarantee"
        ]
      }
    ],
    "suggestedTopics": [
      "Accounts, cards and payments",
      "Banking product information",
      "Customer service and fraud reporting"
    ],
    "optionalPolicyIds": [
      "builtin-content-safety",
      "builtin-jailbreak",
      "builtin-topic-safety",
      "builtin-contextual-grounding",
      "local-contact-data",
      "local-government-identifiers",
      "local-payment-data"
    ],
    "limitations": [
      "Local patterns provide basic screening, not complete semantic coverage or guaranteed attack prevention.",
      "Selected output transformations require complete-response buffering, including streaming requests.",
      "Optional model-backed protection is not enabled until explicitly selected, configured and validated.",
      "Financial reference controls are text checks, not regulatory compliance, suitability decisions, transaction authorization or certification."
    ]
  },
  {
    "id": "securities-assistant",
    "version": "1.0.0",
    "name": "Securities & brokerage",
    "industry": "securities",
    "jurisdictions": [],
    "description": "Common baseline plus insider-trading, market-manipulation and misleading return-guarantee patterns.",
    "policies": [
      {
        "policyId": "local-credentials",
        "policyVersion": "1.0.0",
        "enabledRails": [
          "input",
          "output"
        ],
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
        ]
      },
      {
        "policyId": "local-content-safety",
        "policyVersion": "1.0.0",
        "enabledRails": [
          "input",
          "output"
        ],
        "parameterValues": {},
        "enabledRuleIds": [
          "category/denied_insults",
          "category/harmful_self_harm",
          "category/harmful_violence",
          "category/harmful_child_safety",
          "category/harmful_illegal_weapons",
          "category/bias_racial",
          "category/bias_gender",
          "category/bias_religious",
          "category/bias_sexual_orientation",
          "category/harm_toxic_abuse"
        ],
        "ruleOrder": [
          "category/denied_insults",
          "category/harmful_self_harm",
          "category/harmful_violence",
          "category/harmful_child_safety",
          "category/harmful_illegal_weapons",
          "category/bias_racial",
          "category/bias_gender",
          "category/bias_religious",
          "category/bias_sexual_orientation",
          "category/harm_toxic_abuse"
        ]
      },
      {
        "policyId": "local-injection-protection",
        "policyVersion": "1.0.0",
        "enabledRails": [
          "input",
          "output"
        ],
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
          "category/prompt_injection_data_exfiltration"
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
          "category/prompt_injection_data_exfiltration"
        ]
      },
      {
        "policyId": "local-payment-data",
        "policyVersion": "1.0.0",
        "enabledRails": [
          "input",
          "output"
        ],
        "parameterValues": {},
        "enabledRuleIds": [
          "financial-pii/credit_card",
          "financial-pii/iban"
        ],
        "ruleOrder": [
          "financial-pii/credit_card",
          "financial-pii/iban"
        ]
      },
      {
        "policyId": "local-passports",
        "policyVersion": "1.0.0",
        "enabledRails": [
          "input",
          "output"
        ],
        "parameterValues": {},
        "enabledRuleIds": [
          "identity/passport"
        ],
        "ruleOrder": [
          "identity/passport"
        ]
      },
      {
        "policyId": "local-contact-data",
        "policyVersion": "1.0.0",
        "enabledRails": [
          "input",
          "output"
        ],
        "parameterValues": {},
        "enabledRuleIds": [
          "pattern/email",
          "pattern/us_phone"
        ],
        "ruleOrder": [
          "pattern/email",
          "pattern/us_phone"
        ]
      },
      {
        "policyId": "local-fraud-prevention",
        "policyVersion": "1.0.0",
        "enabledRails": [
          "input",
          "output"
        ],
        "parameterValues": {},
        "enabledRuleIds": [
          "banking/identity-evasion",
          "banking/return-guarantee",
          "securities/inside-information",
          "securities/manipulation"
        ],
        "ruleOrder": [
          "banking/identity-evasion",
          "banking/return-guarantee",
          "securities/inside-information",
          "securities/manipulation"
        ]
      }
    ],
    "suggestedTopics": [
      "Securities products and risk education",
      "Brokerage account support",
      "Public market information"
    ],
    "optionalPolicyIds": [
      "builtin-content-safety",
      "builtin-jailbreak",
      "builtin-topic-safety",
      "builtin-contextual-grounding",
      "local-contact-data",
      "local-government-identifiers",
      "local-payment-data"
    ],
    "limitations": [
      "Local patterns provide basic screening, not complete semantic coverage or guaranteed attack prevention.",
      "Selected output transformations require complete-response buffering, including streaming requests.",
      "Optional model-backed protection is not enabled until explicitly selected, configured and validated.",
      "Financial reference controls are text checks, not regulatory compliance, suitability decisions, transaction authorization or certification."
    ]
  },
  {
    "id": "internet-customer-support",
    "version": "1.0.0",
    "name": "Internet platform support",
    "industry": "internet",
    "jurisdictions": [],
    "description": "Common baseline plus phishing, session theft, SQL/code and rendered-content injection patterns.",
    "policies": [
      {
        "policyId": "local-credentials",
        "policyVersion": "1.0.0",
        "enabledRails": [
          "input",
          "output"
        ],
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
        ]
      },
      {
        "policyId": "local-content-safety",
        "policyVersion": "1.0.0",
        "enabledRails": [
          "input",
          "output"
        ],
        "parameterValues": {},
        "enabledRuleIds": [
          "category/denied_insults",
          "category/harmful_self_harm",
          "category/harmful_violence",
          "category/harmful_child_safety",
          "category/harmful_illegal_weapons",
          "category/bias_racial",
          "category/bias_gender",
          "category/bias_religious",
          "category/bias_sexual_orientation",
          "category/harm_toxic_abuse"
        ],
        "ruleOrder": [
          "category/denied_insults",
          "category/harmful_self_harm",
          "category/harmful_violence",
          "category/harmful_child_safety",
          "category/harmful_illegal_weapons",
          "category/bias_racial",
          "category/bias_gender",
          "category/bias_religious",
          "category/bias_sexual_orientation",
          "category/harm_toxic_abuse"
        ]
      },
      {
        "policyId": "local-injection-protection",
        "policyVersion": "1.0.0",
        "enabledRails": [
          "input",
          "output"
        ],
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
          "category/prompt_injection_data_exfiltration",
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
          "application/template-traversal"
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
          "category/prompt_injection_data_exfiltration",
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
          "application/template-traversal"
        ]
      },
      {
        "policyId": "local-payment-data",
        "policyVersion": "1.0.0",
        "enabledRails": [
          "input",
          "output"
        ],
        "parameterValues": {},
        "enabledRuleIds": [
          "financial-pii/credit_card",
          "financial-pii/iban"
        ],
        "ruleOrder": [
          "financial-pii/credit_card",
          "financial-pii/iban"
        ]
      },
      {
        "policyId": "local-passports",
        "policyVersion": "1.0.0",
        "enabledRails": [
          "input",
          "output"
        ],
        "parameterValues": {},
        "enabledRuleIds": [
          "identity/passport"
        ],
        "ruleOrder": [
          "identity/passport"
        ]
      },
      {
        "policyId": "local-contact-data",
        "policyVersion": "1.0.0",
        "enabledRails": [
          "input",
          "output"
        ],
        "parameterValues": {},
        "enabledRuleIds": [
          "pattern/email",
          "pattern/us_phone"
        ],
        "ruleOrder": [
          "pattern/email",
          "pattern/us_phone"
        ]
      },
      {
        "policyId": "local-fraud-prevention",
        "policyVersion": "1.0.0",
        "enabledRails": [
          "input",
          "output"
        ],
        "parameterValues": {},
        "enabledRuleIds": [
          "internet/phishing",
          "internet/session-theft"
        ],
        "ruleOrder": [
          "internet/phishing",
          "internet/session-theft"
        ]
      }
    ],
    "suggestedTopics": [
      "Product support and troubleshooting",
      "Account and subscription help",
      "Trust and safety reporting"
    ],
    "optionalPolicyIds": [
      "builtin-content-safety",
      "builtin-jailbreak",
      "builtin-topic-safety",
      "builtin-contextual-grounding",
      "keyword-blocking",
      "competitor-mention-detection"
    ],
    "limitations": [
      "Local patterns provide basic screening, not complete semantic coverage or guaranteed attack prevention.",
      "Selected output transformations require complete-response buffering, including streaming requests.",
      "Optional model-backed protection is not enabled until explicitly selected, configured and validated.",
      "Content screening does not replace output encoding, parameterized queries, sandboxing or access control."
    ]
  }
];
