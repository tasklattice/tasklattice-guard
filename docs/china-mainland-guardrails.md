# China mainland Guardrails design

Reviewed: 2026-09-22

This design turns the shared-page proposal into deployable runtime controls without
presenting a Guardrail as legal compliance. The shared page was used as a requirements
input, not as an authority. Every retained legal or standards reference below points to
an official publisher page. Vendor articles, secondary summaries, draft standards and
future roadmap claims are not Policy authority.

This document is an engineering scope statement, not legal advice. Applicability,
sector classification and conformity require qualified independent review.

## Product model

China support uses the existing executable hierarchy rather than one monolithic
“China compliance Policy”:

1. **Standard or regulation** — external legal/standards context and evidence; never
   executable by itself.
2. **Profile** — a pinned starting composition for a jurisdiction and use case.
3. **Control** — a documented risk objective and ownership boundary. A control may be
   runtime-enforced, require integration, or remain governance-only.
4. **Policy** — a versioned deployable unit with explicit Rails, effects, limitations
   and Test Cases.
5. **Rule** — one independently testable detector or transformation.

Standards remain in Sources & Compliance metadata and this crosswalk. They are not
copied into Rule names as a claim that the entire standard is automated.

## Shipped Profiles

### China mainland runtime baseline

`china-mainland-runtime@1.0.0` pins:

- `local-credentials@2.0.0`
- `local-passports@2.0.0`
- `china-personal-identifiers@1.0.0`
- `china-prompt-manipulation@1.0.0` on the Input Rail

This Profile is intentionally smaller than the global baseline. Existing English
harmful-content vocabularies are not described as Chinese-language safety coverage.
Model content safety, Topic Control, grounding, formal reasoning and organization-code
redaction remain explicit optional additions.

### China mainland banking assistant

`china-banking-assistant@1.0.0` adds
`china-banking-assistant-boundaries@1.0.0`. It screens selected requests or responses
involving verification-code theft, assistant solicitation of sensitive credentials,
identity-check evasion and positive return guarantees. It does not make credit,
suitability, KYC, AML, transaction-authorization or fraud determinations.

Profiles expand to ordinary, version-pinned Policies. They do not create hidden Rules,
a runtime inheritance layer, or a certification state.

## Capability boundary

| Control | Status | Current implementation | Boundary |
| --- | --- | --- | --- |
| Resident identity card, mainland mobile and labelled UnionPay card redaction | **Runtime Enforced** | `china-personal-identifiers`; resident ID date/MOD 11-2 and card Luhn checks reduce format-only matches | Does not verify identity, ownership, issuance, consent, processing purpose or PIPL compliance |
| Labelled Unified Social Credit Code redaction | **Runtime Enforced, optional** | `china-organization-identifiers`; context plus GB 32100 checksum | An organization code is not classified as personal information merely by this Policy; confidentiality is deployment-specific |
| Explicit Chinese instruction override, prompt extraction and jailbreak-mode phrases | **Runtime Enforced** | `china-prompt-manipulation` Input Rules | Phrase screening cannot detect arbitrary paraphrases or eliminate prompt injection |
| Selected banking credential abuse and misleading claims | **Runtime Enforced** | `china-banking-assistant-boundaries` | Text screening is not transaction monitoring, customer authentication, KYC/AML, suitability review or JR/T evaluation |
| Broader Chinese-language harmful or prohibited-content classification | **Requires Integration** | Optional `builtin-content-safety` or configured Topic Control with a Chinese-capable model | Provider/model category coverage must be mapped, tested and approved; it must not be described as implementing all GB/T 45654 categories |
| Factual grounding for product terms, fees and policy answers | **Requires Integration** | Optional `builtin-contextual-grounding` plus supplied authoritative sources | No source context means no grounding claim; model validation is required |
| Visible and implicit generated-content labels | **Requires Integration** | Application/gateway response transformation and metadata or file-format support | Text Rails alone cannot reliably add all implicit metadata required across text, image, audio and video formats |
| High-impact approval, rejection, pricing or transaction decisions | **Requires Integration** | Authenticated business service, authorization policy, evidence and human-review path | Do not infer authority from assistant text; a phrase filter cannot determine whether a decision is authorized |
| Filing, security assessment, training-data governance, lawful basis, consent, retention, cross-border review, incident response and regulatory reporting | **Governance Only** | Organizational process and retained evidence | These obligations are not performed or certified by Guardrails |

## Executable Policy details

### `china-personal-identifiers@1.0.0`

- **Resident ID Rule:** requires an 18-character candidate, a valid calendar date and
  MOD 11-2 checksum. It deliberately does not maintain an administrative-division
  registry or verify a holder.
- **Mobile Rule:** accepts domestic and `+86`/`86` forms with a standalone 11-digit
  mainland mobile pattern. Allocation and ownership are not checked. Redaction can also
  remove values needed by an authorized support flow; approved structured channels and
  field-level handling remain an application responsibility.
- **UnionPay Rule:** requires nearby card context, a 62 prefix, 16–19 digits and a Luhn
  result. Unlabelled long numbers are allowed to reduce false positives.
- All matches are redacted and output requires complete-response buffering.

### `china-organization-identifiers@1.0.0`

- Requires a nearby Unified Social Credit Code label, valid alphabet and checksum.
- It is separate from the personal-information Policy to avoid representing an
  organization identifier as PIPL personal information.

### `china-prompt-manipulation@1.0.0`

- Input-only reject Rules cover three narrow Chinese phrase families.
- Semantic or obfuscated attacks remain outside local pattern coverage; a validated
  jailbreak model is an optional defense-in-depth control.

### `china-banking-assistant-boundaries@1.0.0`

- Credential-theft and identity-evasion Rules inspect requests and responses.
- Assistant credential solicitation and positive return guarantees are Output-only to
  avoid blocking ordinary customer questions.
- Negative Test Cases allow “验证码收不到”, “请勿提供验证码” and an explicit
  no-guarantee disclaimer.

## Official source crosswalk

The links were checked against their final desktop pages on 2026-09-22. Publication
status and effective dates must be rechecked before a production legal review.

| Source | Use in this design | Enforcement boundary |
| --- | --- | --- |
| [中华人民共和国个人信息保护法](https://flk.npc.gov.cn/detail?id=ff8081817b6472a3017b656cc2040044&title=%E4%B8%AD%E5%8D%8E%E4%BA%BA%E6%B0%91%E5%85%B1%E5%92%8C%E5%9B%BD%E4%B8%AA%E4%BA%BA%E4%BF%A1%E6%81%AF%E4%BF%9D%E6%8A%A4%E6%B3%95) — 全国人大常委会 | Articles 4, 28 and 51 provide context for personal information, sensitive personal information and security measures | Identifier redaction is one technical safeguard; it does not decide lawful basis, consent, purpose, retention, transfer duties or compliance |
| [生成式人工智能服务管理暂行办法](https://www.cac.gov.cn/2023-07/13/c_1690898327029107.htm) — 国家互联网信息办公室等 | General service-governance context | Filing, assessment, provider duties and governance are not runtime phrase checks |
| [GB/T 45654-2025 生成式人工智能服务安全基本要求](https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=F67D3F376E0A0A0FF5317FB36B32A30A) — 国家标准全文公开系统 | Current recommended national-standard context; published 2025-04-25, effective 2025-11-01 | No current Policy claims full category or clause coverage; broader classification requires a validated model and a reviewed crosswalk |
| [人工智能生成合成内容标识办法](https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm) and [GB 45438-2025](https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=F32EA2A561F1886CD8D606513512D547) | Visible and implicit generated-content labelling context; effective 2025-09-01 | Marked Requires Integration because complete multi-format and implicit labelling is not implemented by current text Rules |
| [互联网信息服务深度合成管理规定](https://www.cac.gov.cn/2022-12/11/c_1672221949354811.htm) | Deep-synthesis service context | Service identity, data, consent, labelling and operational duties require product and governance controls |
| [互联网信息服务算法推荐管理规定](https://www.cac.gov.cn/2022-01/04/c_1642894606364259.htm) | Algorithm-service governance context where the deployment is in scope | Scope, filing, user rights and operational governance are not inferred by a Guardrail |
| [GB/T 45652-2025 生成式人工智能预训练和优化训练数据安全规范](https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=82710B59110419C285BDC48AB4D7D1F3) and [GB/T 45674-2025 生成式人工智能数据标注安全规范](https://std.samr.gov.cn/gb/search/gbDetailed?id=33D40F1160F95D92E06397BE0A0A5B93) | Training and labelling data governance context | Governance Only for the gateway runtime; request/response screening is not training-data governance |
| [JR/T 0221-2021 人工智能算法金融应用评价规范](https://std.samr.gov.cn/hb/search/stdHBDetailed?id=BF61550E44D6DEDDE05397BE0A0A63D6) — 中国人民银行主管行业标准 | Financial-AI evaluation and governance context for the banking Profile | The banking Policy does not implement the standard's evaluation methods or prove conformity |
| [银行保险机构数据安全管理办法（金规〔2024〕24号）](https://app.www.gov.cn/govdata/gov/202412/29/523120/article.html) — 国家金融监督管理总局 | Banking and insurance data-security governance context | Data classification, access control, lifecycle governance, incident handling and reporting remain integration/governance responsibilities |

## Validation and release criteria

- Every Rule has a required acceptance case; negative scenarios cover checksum,
  context and disclaimer boundaries.
- Resident ID, Unified Social Credit Code and card candidates are not accepted on
  broad regex shape alone.
- Profile expansion rejects missing Policies, stale versions, unsupported Rails and
  missing required parameters.
- Sources & Compliance metadata is version-bound, bilingual and references real Rule
  IDs. An empty external-reference state is retained where no defensible mapping
  exists.
- Before release, run representative Chinese adversarial, benign, dialect, spacing,
  Unicode and streaming tests on the actual selected model and gateway. Passing the
  bundled fixtures proves only those fixtures.

## Next controls

Healthcare and government Profiles should be added only after their own data classes,
business authority context, escalation paths and official sector sources are reviewed.
Do not clone the banking Profile and relabel it. A generated-content labelling control
should be added only after the gateway contract can express visible labels and the
required implicit metadata for each supported content type.
