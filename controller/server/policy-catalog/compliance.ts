import type { PolicyCompliance } from "../../shared/policy-compliance.js";

type PolicyInput = {
  id: string;
  name: string;
  version: string;
  description: string;
  rules: Array<{ id: string; form: string }>;
  tags?: Array<{ namespace: string; value: string }>;
};
type Reference = PolicyCompliance["references"][number];
type Text = { en: string; zh: string };

const reviewedOn = "2026-09-22";
const bilingual = (en: string, zh: string): Text => ({ en, zh });
const official = (title: string, url: string, publisher: string, provision: string, relevance: Text): Omit<Reference, "rule_ids"> =>
  ({ title, url, publisher, provision, relevance });

const sources = {
  litellm: official("LiteLLM content-filter source at pinned commit ead6252", "https://github.com/BerriAI/litellm/tree/ead62528e607b9d8e61273def638799c9c3a69ba/litellm/proxy/guardrails/guardrail_hooks/litellm_content_filter", "Berri AI / LiteLLM", "Pinned source material used by the reproducible TaskLattice importer", bilingual(
    "This permalink identifies the reviewed upstream source material. TaskLattice imports data into its own Policy model and does not use LiteLLM at runtime.",
    "该固定链接指向已核查的上游来源材料。TaskLattice 将数据导入自身 Policy 模型，运行时不依赖 LiteLLM。",
  )),
  nemo: official("NeMo Guardrails documentation", "https://docs.nvidia.com/nemo/guardrails/latest/index.html", "NVIDIA", "Runtime framework documentation", bilingual(
    "This documents the runtime framework used to execute the Policy. It does not certify the Policy's detector quality or legal compliance.",
    "该资料说明执行 Policy 的运行时框架，不认证 Policy 的检测质量或法律合规性。",
  )),
  nistPii: official("NIST SP 800-122 — Protecting the Confidentiality of Personally Identifiable Information", "https://csrc.nist.gov/pubs/sp/800/122/final", "National Institute of Standards and Technology", "PII protection guidance", bilingual(
    "This is contextual security guidance for protecting PII. Pattern detection can support exposure reduction but does not implement the complete guidance.",
    "这是保护 PII 的背景安全指引。模式检测可辅助减少暴露，但不能实现该指引的全部要求。",
  )),
  nistAi: official("NIST AI Risk Management Framework", "https://www.nist.gov/itl/ai-risk-management-framework", "National Institute of Standards and Technology", "Voluntary AI risk-management framework", bilingual(
    "This is a risk-management reference, not a claim that this text detector implements or conforms to the framework.",
    "这是风险管理参考，不表示此文本检测器已实现或符合该框架。",
  )),
  owaspPrompt: official("OWASP LLM01 — Prompt Injection", "https://genai.owasp.org/llmrisk/llm01-prompt-injection/", "OWASP GenAI Security Project", "Prompt-injection risk reference", bilingual(
    "This reference describes prompt-injection risk. Keyword or classifier checks are defense-in-depth controls and do not eliminate the risk.",
    "该资料说明提示注入风险。关键词或分类器检查属于纵深防御控制，不能消除此风险。",
  )),
  euAiAct: official("Regulation (EU) 2024/1689 — Artificial Intelligence Act", "https://eur-lex.europa.eu/eli/reg/2024/1689/oj", "EUR-Lex", "Article 5 — Prohibited AI practices", bilingual(
    "The Rules screen selected phrases related to Article 5 topics. They do not determine whether a system is in scope or legally compliant.",
    "Rules 筛查与第 5 条主题相关的特定措辞，不判断系统是否属于适用范围或符合法律要求。",
  )),
  gdpr: official("Regulation (EU) 2016/679 — General Data Protection Regulation", "https://eur-lex.europa.eu/eli/reg/2016/679/oj", "EUR-Lex", "Article 32 — Security of processing", bilingual(
    "Identifier redaction can be one security measure. It does not by itself satisfy Article 32 or other GDPR obligations.",
    "标识符脱敏可以是安全措施之一，但不能单独满足第 32 条或 GDPR 的其他义务。",
  )),
  mas: official("FEAT Principles", "https://www.mas.gov.sg/publications/monographs-or-information-paper/2018/feat-principles", "Monetary Authority of Singapore", "Fairness, Ethics, Accountability and Transparency", bilingual(
    "This is a contextual financial-sector reference. Phrase screening does not assess governance, model outcomes, human oversight or institutional compliance.",
    "这是金融行业背景参考。短语筛查不评估治理、模型结果、人工监督或机构合规情况。",
  )),
  pdpa: official("Personal Data Protection Act", "https://www.pdpc.gov.sg/overview-of-pdpa/the-legislation/personal-data-protection-act", "Personal Data Protection Commission Singapore", "Singapore personal-data legislation overview", bilingual(
    "The Rules can flag selected identifiers or risky requests. They do not determine consent, purpose limitation, transfer obligations or PDPA compliance.",
    "Rules 可标记特定标识符或风险请求，但不判断同意、目的限制、传输义务或 PDPA 合规性。",
  )),
  uae: official("Data protection laws in the UAE", "https://u.ae/en/about-the-uae/digital-uae/data/data-protection-laws", "The Official Platform of the UAE Government", "UAE data-protection overview", bilingual(
    "This is a jurisdictional reference. Pattern matching does not establish applicability, lawful processing or compliance with UAE law.",
    "这是司法辖区背景参考。模式匹配不判断适用性、合法处理或是否符合阿联酋法律。",
  )),
  oaic: official("Australian Privacy Principles guidelines", "https://www.oaic.gov.au/privacy/australian-privacy-principles-guidelines", "Office of the Australian Information Commissioner", "Australian Privacy Principles", bilingual(
    "This is an official privacy reference. Text screening does not determine APP applicability or satisfy an entity's privacy obligations.",
    "这是官方隐私参考。文本筛查不判断 APP 的适用性，也不能满足组织的隐私义务。",
  )),
  pci: official("Payment Card Industry Data Security Standard", "https://www.pcisecuritystandards.org/standards/pci-dss/", "PCI Security Standards Council", "Payment-account data security standard", bilingual(
    "Card-number detection may support data discovery. It is not PCI DSS validation, scope determination or evidence of compliance.",
    "卡号检测可辅助数据发现，但不构成 PCI DSS 验证、范围判定或合规证据。",
  )),
  asic: official("Market integrity rules", "https://www.asic.gov.au/regulatory-resources/markets/market-integrity-rules/", "Australian Securities and Investments Commission", "Australian market-integrity reference", bilingual(
    "This is a contextual market-integrity reference. Phrase checks are not market surveillance and do not determine misconduct or legal compliance.",
    "这是市场诚信背景参考。短语检查不属于市场监控，也不判断不当行为或法律合规性。",
  )),
} as const;

const regulatorySourceByPolicy: Record<string, keyof typeof sources> = {
  "eu-ai-act-article5": "euAiAct",
  "gdpr-eu-pii-protection": "gdpr",
  "mas-ai-risk-management": "mas",
  "pdpa-singapore": "pdpa",
  "singapore-customer-identifiers": "pdpa",
  "singapore-data-use-boundaries": "pdpa",
  "singapore-financial-conduct": "mas",
  "airline-passenger-data-protection-uae": "uae",
  "uae-regulatory-compliance": "uae",
  "nsfw-content-filter-australia": "oaic",
  "local-australian-tax-health-identifiers": "oaic",
  "local-payment-data": "pci",
  "banking-customer-protection": "pci",
  "securities-market-integrity": "asic",
};

function contextualSource(policy: PolicyInput, sourceFile: string): keyof typeof sources {
  const explicit = regulatorySourceByPolicy[policy.id];
  if (explicit) return explicit;
  if (sourceFile === "local_content_filters.json") return "litellm";
  if (sourceFile === "model_capability_policies.json" || sourceFile === "configurable_policies.json") return "nemo";
  if (/prompt|jailbreak|injection|credential|code-execution|account-abuse/.test(policy.id)) return "owaspPrompt";
  if (policy.tags?.some(tag => tag.namespace === "guardrail_category" && tag.value === "pii_detection")) return "nistPii";
  return "nistAi";
}

function provenance(sourceFile: string): { provenance: Text; upstream: Text; license: Text } {
  if (sourceFile === "local_content_filters.json") return {
    provenance: bilingual("Generated by scripts/import_litellm_content_filters.py from a pinned LiteLLM commit, then represented and executed by TaskLattice's own Policy and NeMo runtime.", "由 scripts/import_litellm_content_filters.py 从固定 LiteLLM commit 生成，再由 TaskLattice 自有 Policy 模型和 NeMo 运行时表示及执行。"),
    upstream: bilingual("LiteLLM commit ead62528e607b9d8e61273def638799c9c3a69ba; the external link below is immutable.", "上游为 LiteLLM commit ead62528e607b9d8e61273def638799c9c3a69ba；下方站外链接为固定版本。"),
    license: bilingual("The pinned source material is MIT-licensed; attribution and license text are retained in THIRD_PARTY_NOTICES.md.", "固定来源材料采用 MIT 许可；归属和许可全文保存在 THIRD_PARTY_NOTICES.md。"),
  };
  if (sourceFile === "focused_policies.json") return {
    provenance: bilingual("TaskLattice-maintained focused Policy split from reviewed local detector collections to keep one business purpose per Policy.", "由 TaskLattice 维护，从已审查的本地检测集合拆分为聚焦 Policy，使每个 Policy 对应单一业务目的。"),
    upstream: bilingual("The Rule inventory is repository-maintained. Where a Rule originated in imported third-party material, repository third-party notices remain authoritative; no additional upstream identity is inferred.", "Rules 清单由仓库维护。若 Rule 源于第三方导入材料，以仓库第三方声明为准；不会推断额外上游身份。"),
    license: bilingual("Distributed under the repository license, subject to THIRD_PARTY_NOTICES.md for incorporated material. This documentation grants no additional rights.", "依据仓库许可分发；所含材料受 THIRD_PARTY_NOTICES.md 约束。本说明不授予额外权利。"),
  };
  if (sourceFile === "model_capability_policies.json") return {
    provenance: bilingual("TaskLattice-maintained capability contract that invokes a configured model through NeMo Guardrails. Runtime results depend on the selected provider, model profile and validation evidence.", "由 TaskLattice 维护的能力契约，通过 NeMo Guardrails 调用已配置模型。运行结果取决于所选 Provider、模型 Profile 和验证证据。"),
    upstream: bilingual("No model weights or provider behavior are bundled. Consult the selected model provider's documentation and license separately.", "不随附模型权重或 Provider 行为；应单独查阅所选模型 Provider 的文档和许可。"),
    license: bilingual("The integration contract follows the repository license. Model services, weights and outputs are governed by their respective providers.", "集成契约遵循仓库许可；模型服务、权重和输出受各 Provider 条款约束。"),
  };
  if (sourceFile === "configurable_policies.json") return {
    provenance: bilingual("TaskLattice-maintained configurable Policy. Its effective behavior comes from administrator-supplied phrases and parameters.", "由 TaskLattice 维护的可配置 Policy；实际行为来自管理员提供的短语和参数。"),
    upstream: bilingual("No external detector list is bundled for this Policy.", "此 Policy 不包含外部检测词表。"),
    license: bilingual("The implementation follows the repository license. Administrators are responsible for rights to configured content.", "实现遵循仓库许可；管理员负责确保对配置内容拥有相应权利。"),
  };
  return {
    provenance: bilingual(`TaskLattice-maintained built-in catalog asset from runner/toolkit/policy_library/assets/${sourceFile}, executed through the local Policy model and NeMo runtime.`, `由 TaskLattice 维护的内置目录资源 runner/toolkit/policy_library/assets/${sourceFile}，通过本地 Policy 模型和 NeMo 运行时执行。`),
    upstream: bilingual("The repository does not assert a separate upstream Policy unless an external source is explicitly linked below. A catalog version is not proof of upstream identity.", "除非下方明确链接外部来源，仓库不声明存在独立上游 Policy；目录版本号不能证明上游身份。"),
    license: bilingual("The Policy definition follows the repository license and THIRD_PARTY_NOTICES.md. This documentation grants no additional rights.", "Policy 定义遵循仓库许可及 THIRD_PARTY_NOTICES.md；本说明不授予额外权利。"),
  };
}

export function builtInPolicyCompliance(policy: PolicyInput, sourceFile: string): PolicyCompliance {
  const ruleIds = policy.rules.slice(0, 3).map(rule => rule.id);
  if (!ruleIds.length) throw new Error(`Policy ${policy.id} needs at least one Rule for source documentation.`);
  const source = sources[contextualSource(policy, sourceFile)];
  const origin = provenance(sourceFile);
  const forms = [...new Set(policy.rules.map(rule => rule.form))];
  return {
    policy_version: policy.version,
    summary: bilingual(
      `${policy.name} is a technical screening Policy with ${policy.rules.length} configured Rule${policy.rules.length === 1 ? "" : "s"}. Its results support risk controls; they are not legal advice, certification or proof of compliance.`,
      `${policy.name} 是包含 ${policy.rules.length} 条已配置 Rule 的技术筛查 Policy。其结果可辅助风险控制，但不构成法律建议、认证或合规证明。`,
    ),
    jurisdiction: bilingual(
      policy.tags?.some(tag => tag.namespace === "jurisdiction") ? "Jurisdiction tags identify intended context only; applicability requires case-specific review." : "No exclusive legal jurisdiction is asserted for this technical Policy.",
      policy.tags?.some(tag => tag.namespace === "jurisdiction") ? "司法辖区标签仅表示预期背景；具体适用性需结合实际场景审查。" : "此技术 Policy 不声明专属法律司法辖区。",
    ),
    provenance: origin.provenance,
    maintainer: "TaskLattice",
    upstream_status: origin.upstream,
    license_status: origin.license,
    references: [{ ...source, rule_ids: ruleIds }],
    coverage: [{
      rule_ids: ruleIds,
      description: bilingual(
        `The implementation evaluates configured ${forms.join(", ")} Rules. The related Rules below are representative; inspect the Policy tab for the complete executable inventory and Test Cases for sampled behavior.`,
        `实现会执行已配置的 ${forms.join("、")} Rules。下列关联 Rules 为代表性示例；完整可执行清单见 Policy 页签，抽样行为见 Test Cases。`,
      ),
    }],
    limitations: [
      bilingual("Detection is bounded by configured patterns, phrases, classifier/model behavior and request context; false positives and false negatives are possible.", "检测能力受已配置模式、短语、分类器或模型行为及请求上下文限制，可能出现误报和漏报。"),
      bilingual("The Policy does not determine legal scope, consent, lawful basis, governance, operational controls or an organisation's compliance status.", "Policy 不判断法律适用范围、同意、合法依据、治理、运营控制或组织合规状态。"),
      bilingual("Passing Test Cases demonstrates only the recorded examples and does not establish production effectiveness against all inputs.", "Test Cases 通过仅说明记录样例符合预期，不证明对所有生产输入均有效。"),
    ],
    review: {
      status: "reviewed",
      reviewed_on: reviewedOn,
      reviewer: "TaskLattice Engineering",
      notes: bilingual("Engineering reviewed the repository provenance, external reference target and technical scope. Legal applicability and compliance conclusions require qualified independent review.", "工程团队已审查仓库来源、站外参考目标和技术范围。法律适用性及合规结论仍需具备资质的独立审查。"),
    },
  };
}

export function customPolicyCompliance(policy: PolicyInput, owner: string): PolicyCompliance {
  const ruleIds = policy.rules.slice(0, 3).map(rule => rule.id);
  return {
    policy_version: policy.version,
    summary: bilingual("This is a customer-authored technical Policy. Publishing and Test Cases do not make it a compliance certification.", "这是客户自建的技术 Policy。发布和 Test Cases 不构成合规认证。"),
    jurisdiction: bilingual("No jurisdiction is declared by the platform. The Policy owner must document applicable obligations.", "平台未声明司法辖区；适用义务应由 Policy 所有者记录。"),
    provenance: bilingual(`Created and maintained in this TaskLattice workspace by ${owner}.`, `由 ${owner} 在此 TaskLattice 工作区创建并维护。`),
    maintainer: owner,
    upstream_status: bilingual("No external upstream source is declared in the Policy metadata.", "Policy 元数据未声明外部上游来源。"),
    license_status: bilingual("No external license or attribution is declared. The owner is responsible for source and licensing records.", "未声明外部许可或归属；所有者负责维护来源及许可记录。"),
    references: [],
    coverage: ruleIds.length ? [{ rule_ids: ruleIds, description: bilingual("Coverage is defined by the published Rail bindings and executable Test Cases shown in this inspector.", "覆盖范围由此检查器中展示的已发布 Rail 绑定及可执行 Test Cases 定义。") }] : [],
    limitations: [bilingual("TaskLattice has not independently verified the source, legal mapping or compliance status of this custom Policy.", "TaskLattice 未独立核验此自定义 Policy 的来源、法律映射或合规状态。")],
    review: { status: "pending", reviewed_on: null, reviewer: null, notes: bilingual("Add qualified source and compliance review outside the current Policy editor when required.", "如有需要，请在当前 Policy 编辑器之外补充具备资质的来源与合规审查。") },
  };
}
