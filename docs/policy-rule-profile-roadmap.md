# Rule/Policy/Profile Refactor Roadmap

Status: planning proposal for confirmation. No runtime, Policy, Rule, Profile or UI
code has been changed.

Related documents:

- [policy-taxonomy-proposal.md](policy-taxonomy-proposal.md)
- [policy-rule-mapping.csv](policy-rule-mapping.csv)
- [rule-resource-inventory.md](rule-resource-inventory.md)
- [profile-composition.csv](profile-composition.csv)

## 1. Decisions and scope

### Target resources

```text
Rule          atomic detector + action + parameters + tests
Policy        protection topic + jurisdiction/framework + pinned Rule bindings
Profile       industry/use-case composition + parameter packs + tests
```

### Target counts

| Layer | Current | Target |
|---|---:|---:|
| Rule | 208 | about 190 |
| Policy | 27 | 20 |
| Mandatory baseline Profiles | 5 | 2 |
| Industry Profiles | 3-4 | 3 baseline, optional 4 |
| Claims | none | optional Profile pack |

### Baseline Profile decision

Start with **5 Profiles**:

1. `Default` - local-only, no model dependency.
2. `Full-feature` - all Policies/Rules, all models, benchmark only.
3. `Singapore Bank`.
4. `China Financial Services` - China banking + securities.
5. `China Internet`.

If China banking and securities require separate Rule selections, split into:

6. `China Bank`.
7. `China Securities`.

This becomes **6 Profiles**: 2 baselines + 4 industry Profiles.

`Claims` is optional. It is not one of the requested 2-3 industry Profiles.

## 2. Target resource model

### 2.1 Rule

```yaml
id: privacy/contact/email
version: 1.0.0
detector:
  ref: text/regex
  version: 1.0.0
  parameters: {}
default_action: transform
replacement: "[email_REDACTED]"
rails: [input, output]
risk_level: medium
tests:
  - tests/acceptance.yaml
metadata:
  taxonomy_ids: []
```

Rules are immutable once referenced by a published Policy version.

### 2.2 Policy

```yaml
id: contact-data
version: 1.0.0
protection_topic: contact_data
jurisdictions: [global]
frameworks: []
rules:
  - id: privacy/contact/email
    version: 1.0.0
    order: 0
    action: transform
  - id: privacy/contact/phone
    version: 1.0.0
    order: 1
    action: transform
tests:
  - tests/policy-composition.yaml
```

A Policy pins exact Rule versions. A Policy may override action, parameters and rails at
the binding, but it may not mutate the Rule.

### 2.3 Profile

```yaml
id: sg-bank
version: 1.0.0
industry: banking
jurisdictions: [sg]
frameworks: [MAS, PDPA]
requiresModels: true
benchmarkOnly: false
policyBindings:
  - policyId: payment-data
    policyVersion: 1.0.0
  - policyId: contact-data
    policyVersion: 1.0.0
parameterPacks:
  - sg-bank-phrases@1.0.0
tests:
  - tests/profile-regression.yaml
```

Profiles pin Policy versions and parameter-pack versions.

## 3. Rule adjustment plan

### 3.1 Extraction

1. Add a canonical Rule resource layout:

```text
policies/rules/<rule-id>/<version>/rule.yaml
policies/rules/<rule-id>/<version>/tests/
```

2. Move detector/action/parameter/test ownership from inline Policy Rule files into
   canonical Rule resources.
3. Keep compatibility adapters during development so existing Policy sources can be
   read while new Rule resources are introduced.
4. Generate a Rule catalog index with ID, version, checksum, detector and tests.

### 3.2 Consolidation

Target: 208 source Rules -> about 190 Rule resources.

Conservative merges:

| Family | Reduction |
|---|---:|
| Exact duplicate groups | -2 |
| Passport India/Australia shared detector | -1 |
| TFN duplicate | -1 |
| SSN formatted/no-dash | -1 |
| CPF formatted/unformatted | -1 |
| Generic + branded cards | -4 |
| Generic + enhanced IBAN | -1 |
| EU AI Act EN/FR article variants | -5 |
| Toxicity language variants | -3 |

Do not fold all 33 overlap families into one Rule. That would reduce the count to
about 100 but would destroy Rule-level evidence and attribution. Each merge must
preserve detector spans, actions, replacements, evidence and tests.

### 3.3 Rule invariants

- A Rule ID is canonical and versioned.
- A Policy pins exact Rule versions.
- Two Rules inside one Policy must not match the same span unless a reviewed
  fallback contract exists.
- Cross-Policy overlap must be explicit in the Profile composition and tests.
- Rule tests remain owned by the Rule; Policy tests focus on composition.

## 4. Policy adjustment plan

### 4.1 Remove the industry catch-all

`business_rules` (Business & industry rules) is removed as a Policy directory.
Its Rules are redistributed:

- generic fraud -> `Fraud & Account Abuse`
- financial-market conduct -> `Financial Market Misconduct`
- claims-specific -> Claims Profile pack
- SG PDPA -> `Regional Compliance: SG PDPA`
- EU AI Act -> `Regional Compliance: EU AI Act`
- professional advice -> `Business Topics & Advice`

### 4.2 Policy mapping

| Source Policy | Target Policy |
|---|---|
| `block-code-execution` | Application Injection |
| `builtin-automated-reasoning` | Answer Reliability |
| `builtin-content-safety` | Content Safety (Model) |
| `builtin-contextual-grounding` | Answer Reliability |
| `builtin-indirect-prompt-injection` | Prompt & Instruction Attacks |
| `builtin-jailbreak` | Prompt & Instruction Attacks |
| `builtin-jailbreak-strict` | Prompt & Instruction Attacks |
| `builtin-memory-poisoning` | Prompt & Instruction Attacks |
| `builtin-pii` | PII (Semantic) |
| `builtin-topic-safety` | Business Topics & Advice |
| `competitor-mention-detection` | Content Filters |
| `configured-phrase-filter` | Content Filters |
| `keyword-blocking` | Content Filters |
| `local-contact-data` | Contact Data |
| `local-content-safety` | Content Safety (Local) + UAE Content Standards |
| `local-credentials` | Credentials & Secrets |
| `local-data-use-boundaries` | SG PDPA + Claims Profile |
| `local-fraud-prevention` | Fraud & Account Abuse + Financial Market Misconduct + Claims Profile |
| `local-government-identifiers` | Identity Documents |
| `local-injection-protection` | Prompt & Instruction Attacks + Application Injection + Claims Profile |
| `local-network-addresses` | Network Identifiers |
| `local-passports` | Identity Documents |
| `local-payment-data` | Payment Data |
| `local-professional-advice` | Business Topics & Advice + Claims Profile |
| `local-prohibited-practices` | Regional Compliance: EU AI Act |
| `local-risk-content-terms` | Risk Content Terms |
| `local-sensitive-attribute-terms` | Sensitive Attributes |

### 4.3 Internal overlap cleanup

- Merge generic and branded card Rules into `payment/card-number`.
- Merge generic and enhanced IBAN Rules into `payment/iban`.
- Merge phone variants into `contact/phone`; preserve country metadata.
- Merge person-name and address variants only where context is mutually exclusive.
- Merge TFN, SSN, CPF and passport aliases into identity Rule families.
- Merge generic/provider credentials into canonical credential families.
- Merge toxicity language variants.
- Merge EU AI Act EN/FR variants per Article 5 practice.
- Keep `Risk Content Terms` separate from Content Safety to preserve transform vs
  block semantics.
- Move UAE cultural/anti-discrimination Rules to regional compliance.

## 5. Profile update plan

### 5.1 Five-Profile baseline

| Profile | Industry | Region | Model requirement | Benchmark-only |
|---|---|---|---|---|
| Default | general | global | none | no |
| Full-feature | general | global | all model capabilities | yes |
| Singapore Bank | banking | SG | required by default | no |
| China Financial Services | banking + securities | CN | required by default | no |
| China Internet | internet | CN | required by default | no |

`Default` must be verified with `modelInvocations=0`.
`Full-feature` must contain every Policy and Rule and is not a production default.

### 5.2 Six-Profile alternative

Split China financial into:

- `China Bank`
- `China Securities`

This is recommended if bank-specific fraud Rules would overblock securities or if
the two segments have different financial-conduct Rules.

### 5.3 Composition

| Profile | Policies |
|---|---|
| Default | Payment, Contact, Identity, Credentials, Sensitive Attributes, Network, Content Safety (Local), Risk Content Terms, Prompt & Instruction Attacks (local subset), Application Injection, Fraud & Account Abuse, Financial Market Misconduct, Business Topics & Advice (local subset), Content Filters |
| Full-feature | All 20 Policies |
| Singapore Bank | Payment, Contact, Identity, Credentials, Sensitive Attributes, Network, PII (Semantic), Content Safety (Local/Model), Risk Content Terms, Prompt & Instruction Attacks, Application Injection, Fraud & Account Abuse, Financial Market Misconduct, Business Topics & Advice, Content Filters, Regional Compliance: SG PDPA |
| China Financial Services | Payment, Contact, Identity, Credentials, Sensitive Attributes, Network, PII (Semantic), Content Safety (Local/Model), Risk Content Terms, Prompt & Instruction Attacks, Application Injection, Fraud & Account Abuse, Financial Market Misconduct, Business Topics & Advice, Content Filters |
| China Internet | Contact, Payment, Identity, Credentials, Sensitive Attributes, Network, PII (Semantic), Content Safety (Local/Model), Risk Content Terms, Prompt & Instruction Attacks, Application Injection, Fraud & Account Abuse, Business Topics & Advice, Content Filters |

### 5.4 Remove current presets

Current Profile presets in `controller/shared/protection-presets.ts`:

- `banking-assistant`
- `securities-assistant`
- `internet-customer-support`

Replace with the new Profile IDs:

- `sg-bank`
- `cn-financial-services` (or `cn-bank` + `cn-securities`)
- `cn-internet`

The old presets must not remain selectable in the Policy Library.

### 5.5 Policy Library vs Profile UI

- Policy Library: only 20 Policies; filters for protection topic, jurisdiction and
  framework.
- Profile picker: Default, Full-feature, industry Profiles.
- `Full-feature` gets a visible Benchmark badge and is hidden from normal endpoint
  creation where possible.
- `Default` gets a No models badge.

## 6. Technical phases

### Phase 0: Freeze contracts

- Approve 5 vs 6 Profiles.
- Approve Claims handling.
- Freeze Rule/Policy/Profile schemas.
- Freeze Rule ID naming.

### Phase 1: Rule resource model

- Add Rule resource directories and loader.
- Add Rule version pinning and checksum validation.
- Add a generated Rule catalog.
- Keep existing Policy loader working through an adapter.
- Add Rule-level tests.

### Phase 2: Rule consolidation

- Merge exact and semantic duplicates in small batches.
- Run Rule/Policy golden tests after each batch.
- Target about 190 Rules.
- Do not perform a single bulk rewrite.

### Phase 3: Policy refactor

- Create the 20 target Policies.
- Add Rule bindings and remove inline Rule ownership.
- Reclassify protection topic/jurisdiction/framework.
- Remove `business_rules`.
- Add Policy composition tests.

### Phase 4: Profile refactor

- Create Default and Full-feature first.
- Create Singapore Bank, China Financial Services, China Internet.
- Add model flags, benchmark flag, parameter packs and regression tests.
- Optionally split China Bank/China Securities or add Claims.

### Phase 5: API and UI

- Add Rule/Policy/Profile DTOs and catalog endpoints.
- Policy Library displays Policies only.
- Profile picker displays Profiles only.
- Add Benchmark and No models badges.
- Add import/export entry points.

### Phase 6: Import/export

- Policy package includes pinned Rule closure.
- Profile package includes pinned Policy closure and parameter packs.
- Reject missing or checksum-conflicting dependencies.
- Round-trip tests in a clean environment.

### Phase 7: Validation and deployment

- Run Rule, Policy, Profile, control-plane, data-plane and e2e suites.
- Deploy to `tali` with `npm run helm:deploy:dev`.
- Verify Default with CLI and zero model calls.
- Verify Full-feature benchmark.
- Verify industry Profiles.

## 7. Acceptance criteria

- Rule count is about 190, not 208.
- No two Rules in one Policy match the same span without a documented fallback.
- Policy count is 20.
- `business_rules` is gone.
- Default Profile: zero model invocations.
- Full-feature Profile: all 20 Policies; benchmark only.
- Profile count is 5 (or 6 if China financial is split).
- Policy/Profile import-export round-trips preserve Rule versions and checksums.
- `tali` deployment passes with the existing CLI workflow.

## 8. Open decisions

1. Five Profiles (combined China Financial Services) or six Profiles (China Bank and
   China Securities separate)?
2. Is Claims a sixth/seventh Profile or Full-feature-only?
3. Are industry Profiles model-required, or should they have local-only variants?
4. Does `Content Safety` remain split into Local/Model/Risk Terms, or become one
   Policy with optional model Rules?
5. Does `PII (Semantic)` remain separate from Contact/Identity/Payment?
