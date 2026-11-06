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
| Rule resources | 208 | about 198-200; 190 is aspirational |
| Policy Rule bindings | 208 | 208 unless behavior changes |
| Local / platform Rules | 200 / 8 | preserve the split |
| Policy | 27 | 20 |
| Mandatory baseline Profiles | 5 | 2 |
| Industry Profiles | 3-4 | 3 baseline, optional 4 |
| Claims | none | optional Profile selection |

The Rule resource count and the binding count are different. Merging two identical
Rule resources into one resource with two bindings lowers the resource count, not the
number of executions. A reduction in effective Rule executions requires a reviewed
behavior change and new tests.

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
variants:
  - variantId: default
    replacement: "[email_REDACTED]"
    taxonomyIds: []
rails: [input, output]
risk_level: medium
tests:
  - tests/acceptance.yaml
```

A Rule resource is immutable once referenced by a published Policy version. A Rule may
declare multiple output variants when the same detector has different replacement
text, taxonomy identity or evidence labels.

### 2.2 Policy

The Policy does not bind a Rule directly. It binds a **Rule binding**, which is the
unit of order, action, parameters and tests:

```yaml
id: contact-data
version: 1.0.0
protection_topic: contact_data
jurisdictions: [global]
frameworks: []
bindings:
  - bindingId: email
    rule:
      id: privacy/contact/email
      version: 1.0.0
    variantId: default
    order: 0
    action: transform
    parameters: {}
    rails: [input, output]
  - bindingId: phone
    rule:
      id: privacy/contact/phone
      version: 1.0.0
    variantId: default
    order: 1
    action: transform
    parameters: {}
    rails: [input, output]
tests:
  - tests/policy-composition.yaml
```

Rules:

- `bindingId` is unique inside the Policy version.
- Rule selection, ordering, action override and Policy tests reference `bindingId`.
- Evidence records both `bindingId` and the Rule resource ID/version.
- One Rule resource may be bound multiple times with different parameters. This is
  required for Topic allowlist and denylist, which share the same detector resource but
  have different injected parameters and execution semantics.
- A shared Rule resource does not reduce the number of executions: each binding remains
  a separate candidate.

### 2.3 Profile

A Profile selects Policy versions and Rule bindings, and may apply versioned parameter
packs. It does not own Rules.

```yaml
id: sg-bank
version: 1.0.0
industry: banking
jurisdictions: [sg]
frameworks: [MAS, PDPA]
benchmarkOnly: false
policyBindings:
  - policyId: payment-data
    policyVersion: 1.0.0
    ruleBindings:
      - bindingId: card-number
        enabled: true
      - bindingId: iban
        enabled: true
  - policyId: contact-data
    policyVersion: 1.0.0
    ruleBindings:
      - bindingId: email
        enabled: true
      - bindingId: phone
        enabled: true
        parameters:
          regions: [sg]
parameterPacks:
  - id: sg-bank-phrases
    version: 1.0.0
    scope:
      - policyId: fraud-account-abuse
        bindingId: misleading-return
    values:
      phrases: [...]
tests:
  - tests/profile-regression.yaml
```

Profile expansion rules:

1. The Profile selects exact Policy versions.
2. It may disable a Policy binding, set its order, action, rails or parameters.
3. Parameter packs are versioned and scoped to a Policy binding.
4. The effective bindings are expanded into ordinary Guardrail bindings.
5. Rank Mode receives the resulting ordered candidates; it never reads a mutable
   Profile or Rule directory at runtime.

#### Parameter precedence

Use one explicit order:

```text
locked compliance value
  > Guardrail user binding
  > Profile parameter pack
  > Policy binding
  > Rule default
```

A `locked` value cannot be overridden by a user or Profile.

#### `requiresModels` derivation

`requiresModels` is derived from the **effective compiled plan**, not from a test run:

- true if any effective Rule binding has `execution_dependency=model`, a model
  detector, a model contract, or a required platform model binding;
- false only when every effective binding is local;
- `modelInvocations=0` in one test suite is not proof, because an earlier Block may
  have stopped execution before model candidates were reached.

## 3. Rule adjustment plan
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

Target: **about 198-200 Rule resources**, with 208 Policy Rule bindings.

### Safe resource consolidation

These merges can reduce resource duplication without changing the effective binding
count or detection behavior:

| Family | Resource reduction | Condition |
|---|---:|---|
| Exact duplicate groups | -2 | same detector; bindings stay separate |
| EU AI Act EN/FR article variants | -5 | same Article 5 semantics; locale patterns in one Rule |
| Toxicity language variants | -3 | same replacement/action/taxonomy; locale patterns in one Rule |

This produces about **198 resources**.

### Conditional merges requiring variants

These cannot be plain merges because the outputs or semantics differ:

| Family | Difference | Required model |
|---|---|---|
| Generic + branded cards | `[credit_card_REDACTED]` vs `[visa_REDACTED]` etc. | Keep separate, or add Rule variants with binding-level variant selection. |
| Passport India/Australia | Same expression; different replacement and identity/taxonomy | Keep separate, or variants with identity metadata. |
| SSN formatted/no-dash | Different validation conditions | Keep separate unless one validated detector replaces both. |
| CPF formatted/unformatted | Different replacement/format behavior | Keep separate unless variants are introduced. |
| TFN aliases | Different context/validation; verify before merge | Keep separate until proven equivalent. |

A Rule `variants` model can reduce resource count while preserving output differences.
It must preserve:

- replacement text
- taxonomy/identity
- action
- evidence and attribution
- Rule tests

The `about 190` figure is therefore aspirational, not an acceptance criterion.

### Rule and binding invariants

- A Rule ID is canonical and versioned.
- A Policy pins exact Rule resource versions.
- A Policy binds via `bindingId`; one Rule resource may have multiple bindings.
- Known overlapping bindings inside one Policy must have documented order, precedence
  and tests. "No overlap at all" is not a hard invariant because keywords, phrases,
  competitor terms and model detections can legitimately overlap.
- Every observed overlap must be explainable through bindingId, Rule ID/version,
  content span/evidence and the effective action.
- Rule tests remain owned by the Rule; Policy tests focus on binding composition.

## 4. Policy adjustment plan

### 4.1 Remove the industry catch-all

`business_rules` (Business & industry rules) is removed as a Policy directory.
Its Rules are redistributed:

- generic fraud -> `Fraud & Account Abuse`
- financial-market conduct -> `Financial Market Misconduct`
- claims-specific -> remains in its topic Policy; Claims Profile selects it
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
| `local-data-use-boundaries` | Regional Compliance: SG PDPA (claims PHI remains in the Policy) |
| `local-fraud-prevention` | Fraud & Account Abuse + Financial Market Misconduct (claims Rules stay in Fraud & Account Abuse) |
| `local-government-identifiers` | Identity Documents |
| `local-injection-protection` | Prompt & Instruction Attacks + Application Injection (claims override stays in Prompt) |
| `local-network-addresses` | Network Identifiers |
| `local-passports` | Identity Documents |
| `local-payment-data` | Payment Data |
| `local-professional-advice` | Business Topics & Advice (claims medical stays in Business Topics) |
| `local-prohibited-practices` | Regional Compliance: EU AI Act |
| `local-risk-content-terms` | Risk Content Terms |
| `local-sensitive-attribute-terms` | Sensitive Attributes |

### 4.3 Internal overlap cleanup

- Merge only exact duplicate resources or language variants with identical
  replacement/action/taxonomy and tests.
- Generic and branded cards must stay separate or become Rule variants with explicit
  replacement variants; do not plain-merge.
- Passport India/Australia must stay separate or use identity variants; the
  replacement text differs.
- TFN, SSN and CPF variants must stay separate until validation conditions are
  proven equivalent.
- Phone variants may merge only when locale metadata and replacement behavior are
  preserved.
- Credential provider variants may merge only when the generic Rule is proven to
  cover the same spans and outputs.
- Merge EU AI Act EN/FR variants per Article 5 practice when the replacement and
  taxonomy are identical.
- Keep `Risk Content Terms` separate from Content Safety to preserve transform vs
  block semantics.
- Move UAE cultural/anti-discrimination Rules to regional compliance.

## 5. Profile update plan

### 5.1 Five-Profile baseline

| Profile | Industry | Region | Model requirement | Benchmark-only |
|---|---|---|---|---|
| Default | general | global | none | no |
| Full-feature | general | global | all model capabilities | yes |
| Singapore Bank | banking | SG | derived from effective plan | no |
| China Financial Services | banking + securities | CN | derived from effective plan | no |
| China Internet | internet | CN | derived from effective plan | no |

`Default` must be verified with zero model dependencies derived from its effective
compiled plan, not merely `modelInvocations=0` in one test run.
`Full-feature` must contain all 20 Policies and all 208 Rule bindings and is not a
production default.

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

### Phase 0: Freeze composition contracts

- Freeze Rule resource identity, `bindingId`, variant model, Policy binding and
  parameter-pack scope.
- Freeze parameter precedence and locked-value behavior.
- Freeze Rule/Policy/Profile schemas and Rule ID naming.
- Define compile-time Artifact pinning; runtime never resolves mutable directories.
- Approve 5 vs 6 Profiles and Claims handling.

### Phase 1: One end-to-end vertical slice

Implement one complete path before extracting all resources:

```text
one Rule resource
  -> one Policy binding
  -> one Profile
  -> one Guardrail binding
  -> one compiled Artifact
  -> Runner execution
  -> evidence with Rule ID, bindingId and variant
```

Validate:

- binding identity and duplicate bindings of one Rule;
- parameter precedence;
- artifact pinning/checksum;
- Rank Mode execution;
- Default no-model derivation.

### Phase 2: Rule extraction

- Add Rule resource directories and loader.
- Add Rule version pinning, variants and checksum validation.
- Add a generated Rule catalog.
- Keep existing Policy loader working through an adapter.
- Add Rule-level tests.

### Phase 3: Rule consolidation

- Merge exact duplicates and safe language variants in small batches.
- Add variants only where replacement/taxonomy differences require them.
- Run Rule/Policy golden tests after each batch.
- Do not perform a single bulk rewrite.
- Target about 198-200 Rule resources; 190 is aspirational.

### Phase 4: Policy refactor

- Create the 20 target Policies.
- Add Rule bindings and remove inline Rule ownership.
- Reclassify protection topic/jurisdiction/framework.
- Remove `business_rules`.
- Add Policy composition tests.

### Phase 5: Profile refactor

- Create Default and Full-feature first.
- Create Singapore Bank, China Financial Services, China Internet.
- Add binding selection, parameter packs, model derivation, benchmark flag and
  regression tests.
- Optionally split China Bank/China Securities or add Claims selection.

### Phase 6: API and UI

- Add Rule/Policy/Profile DTOs and catalog endpoints.
- Policy Library displays Policies only.
- Profile picker displays Profiles only.
- Add Benchmark and No models badges.
- Add import/export entry points.

### Phase 7: Import/export

- Policy package includes pinned Rule closure and exact bindings.
- Profile package includes pinned Policy closure, parameter packs and model metadata.
- Reject missing or checksum-conflicting dependencies.
- Round-trip tests in a clean environment.

### Phase 8: Validation and deployment

- Run Rule, Policy, Profile, control-plane, data-plane and e2e suites.
- Deploy to `tali` with `npm run helm:deploy:dev`.
- Verify Default with CLI and zero model invocations.
- Verify Full-feature benchmark.
- Verify industry Profiles.

## 7. Acceptance criteria

Acceptance is behavior-focused; counts are targets, not the primary gate.

- Rule resources are about 198-200; Policy Rule bindings remain 208 unless a
  reviewed behavior change reduces them.
- Every known overlap has a documented precedence, order and test; no unclassified
  overlap.
- Policy count is 20 and `business_rules` is gone.
- Every Policy binding has a unique `bindingId`; evidence records Rule ID/version and
  bindingId.
- Default Profile has no model dependencies, derived from the effective compiled plan.
- Full-feature includes all 20 Policies and all 208 Rule bindings.
- Profile count is 5 (or 6 if China financial is split).
- Policy/Profile import-export round-trips preserve Rule versions, bindings and
  checksums.
- Coverage, false-positive behavior, replacement output and attribution are verified.
- `tali` deployment passes with the existing CLI workflow.

## 8. Open decisions

1. Five Profiles (combined China Financial Services) or six Profiles (China Bank and
   China Securities separate)?
2. Is Claims a sixth/seventh Profile or a selection overlay only?
3. Are industry Profiles model-required, or should they have local-only variants?
4. Does `Content Safety` remain split into Local/Model/Risk Terms, or become one
   Policy with optional model Rules?
5. Does `PII (Semantic)` remain separate from Contact/Identity/Payment?
6. Which conditional Rule families get variants, and which stay separate?
