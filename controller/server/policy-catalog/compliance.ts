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

// References describe regulatory or industry context. They are deliberately
// separate from implementation lineage and never imply that a detector was
// authored, approved, or certified by the referenced organisation.
const sources = {
  nistPii: official("NIST SP 800-122 — Protecting the Confidentiality of Personally Identifiable Information", "https://csrc.nist.gov/pubs/sp/800/122/final", "National Institute of Standards and Technology", "PII protection guidance", bilingual(
    "This guidance provides privacy and security context for reducing PII exposure. Pattern detection is only one possible safeguard and does not implement the full guidance.",
    "该指引为减少 PII 暴露提供隐私与安全背景。模式检测仅是可能采用的保护措施之一，不能实现指引的全部要求。",
  )),
  nistGenAi: official("NIST AI 600-1 — Generative Artificial Intelligence Profile", "https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence", "National Institute of Standards and Technology", "Generative-AI risk-management profile", bilingual(
    "This profile supplies industry risk context for harmful content, information integrity, human-AI configuration and related risks. It does not prescribe this Policy's phrases or validate its effectiveness.",
    "该 Profile 为有害内容、信息完整性、人机交互配置等风险提供行业背景，但不规定本 Policy 的检测短语，也不验证其有效性。",
  )),
  nistBias: official("NIST SP 1270 — Towards a Standard for Identifying and Managing Bias in Artificial Intelligence", "https://www.nist.gov/publications/towards-standard-identifying-and-managing-bias-artificial-intelligence", "National Institute of Standards and Technology", "AI bias identification and management", bilingual(
    "This report provides bias-risk terminology and management context. Term matching cannot assess discriminatory outcomes, fairness, or conformance with the report.",
    "该报告提供偏差风险术语及管理背景。词语匹配不能评估歧视性结果、公平性或是否符合该报告。",
  )),
  whoHealth: official("Ethics and governance of artificial intelligence for health", "https://www.who.int/publications/i/item/9789240029200", "World Health Organization", "Guidance on AI used for health", bilingual(
    "This guidance supplies health-sector governance context. Blocking selected medical or claims phrases is not clinical validation, medical advice control, or implementation of the WHO guidance.",
    "该指引提供医疗行业治理背景。拦截特定医疗或理赔短语不构成临床验证、医疗建议控制，也不表示已实施 WHO 指引。",
  )),
  unicefChildren: official("Guidance on AI and children", "https://www.unicef.org/innocenti/reports/policy-guidance-ai-children", "UNICEF Innocenti", "Child-centred AI policy guidance", bilingual(
    "This guidance provides child-rights and safety context. Vocabulary or classifier screening alone cannot establish child safety or implementation of its recommendations.",
    "该指引提供儿童权利与安全背景。仅靠词表或分类器筛查不能证明儿童安全，也不表示已落实其建议。",
  )),
  owaspPrompt: official("OWASP LLM Prompt Injection Prevention Cheat Sheet", "https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html", "OWASP Foundation", "Prompt-injection defenses and implementation guidance", bilingual(
    "OWASP describes the application-security risk and layered mitigations. Keyword or classifier checks are defense-in-depth controls and do not eliminate prompt injection.",
    "OWASP 说明了该应用安全风险及分层缓解措施。关键词或分类器检查属于纵深防御控制，不能消除提示注入。",
  )),
  owaspSensitive: official("OWASP Secrets Management Cheat Sheet", "https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html", "OWASP Foundation", "Secret lifecycle and handling guidance", bilingual(
    "OWASP provides application-security context for managing credentials and secrets. Detection does not replace access control, secret management, rotation, monitoring, or incident response.",
    "OWASP 为凭据和密钥管理提供应用安全背景。检测不能替代访问控制、密钥管理、轮换、监控或事件响应。",
  )),
  owaspSql: official("OWASP SQL Injection Prevention Cheat Sheet", "https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html", "OWASP Foundation", "Primary defenses against SQL injection", bilingual(
    "OWASP identifies parameterized queries and other engineering controls as primary defenses. Text signatures are supplemental and do not make database access safe.",
    "OWASP 将参数化查询等工程控制列为主要防线。文本特征仅为补充措施，不能保证数据库访问安全。",
  )),
  owaspCommand: official("OWASP OS Command Injection Defense Cheat Sheet", "https://cheatsheetseries.owasp.org/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.html", "OWASP Foundation", "Command-injection engineering defenses", bilingual(
    "OWASP describes parameterization, validation and least-privilege defenses. Blocking selected code-like text does not safely authorize or sandbox execution.",
    "OWASP 说明了参数化、验证和最小权限防线。拦截特定代码文本不能安全地授权执行，也不能替代沙箱。",
  )),
  owaspXss: official("OWASP Cross Site Scripting Prevention Cheat Sheet", "https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html", "OWASP Foundation", "Output encoding and HTML sanitization guidance", bilingual(
    "OWASP describes context-aware encoding and sanitization. Screening selected HTML signatures does not make arbitrary rendered content safe.",
    "OWASP 说明了上下文相关编码与清理措施。筛查特定 HTML 特征不能保证任意渲染内容安全。",
  )),
  nistIdentity: official("NIST SP 800-63B — Authentication and Authenticator Management", "https://pages.nist.gov/800-63-4/sp800-63b.html", "National Institute of Standards and Technology", "Authentication and phishing-resistance guidance", bilingual(
    "This publication provides authentication and phishing-resistance context. Phrase screening does not authenticate users, protect sessions, or implement the specified controls.",
    "该出版物提供身份认证与抗钓鱼背景。短语筛查不能认证用户、保护会话或实现其中规定的控制。",
  )),
  euAiAct: official("Regulation (EU) 2024/1689 — Artificial Intelligence Act", "https://eur-lex.europa.eu/eli/reg/2024/1689/oj", "EUR-Lex", "Article 5 — Prohibited AI practices", bilingual(
    "The Rules screen selected phrases related to Article 5 topics. They do not determine whether a system is in scope, whether an exception applies, or whether it is legally compliant.",
    "Rules 筛查与第 5 条主题相关的特定措辞，不判断系统是否属于适用范围、例外是否适用或系统是否符合法律要求。",
  )),
  gdpr: official("Regulation (EU) 2016/679 — General Data Protection Regulation", "https://eur-lex.europa.eu/eli/reg/2016/679/oj", "EUR-Lex", "Article 32 — Security of processing", bilingual(
    "Identifier redaction can be one security measure. It does not by itself satisfy Article 32 or obligations concerning lawful basis, rights, governance, transfers, or breach response.",
    "标识符脱敏可以是安全措施之一，但不能单独满足第 32 条，也不能满足合法依据、权利、治理、传输或泄露响应等义务。",
  )),
  singaporeAi: official("Model AI Governance Framework for Generative AI", "https://aiverifyfoundation.sg/resources/mgf-gen-ai/", "AI Verify Foundation and Infocomm Media Development Authority", "Singapore generative-AI governance framework", bilingual(
    "This is broader Singapore governance context for accountability, data, trusted development, testing and security. It is not a MAS rule and does not substantiate MAS-specific compliance.",
    "这是关于问责、数据、可信开发、测试与安全的新加坡广义治理背景；它不是 MAS 规则，也不能证明符合 MAS 特定义务。",
  )),
  pdpa: official("Personal Data Protection Act", "https://www.pdpc.gov.sg/overview-of-pdpa/the-legislation/personal-data-protection-act", "Personal Data Protection Commission Singapore", "Singapore personal-data legislation overview", bilingual(
    "The Rules can flag selected identifiers or risky requests. They do not determine consent, purpose limitation, transfer obligations, Do Not Call duties, or PDPA compliance.",
    "Rules 可标记特定标识符或风险请求，但不判断同意、目的限制、传输义务、谢绝来电义务或 PDPA 合规性。",
  )),
  uae: official("Data protection laws in the UAE", "https://u.ae/en/about-the-uae/digital-uae/data/data-protection-laws", "The Official Platform of the UAE Government", "UAE data-protection overview", bilingual(
    "This official overview supplies jurisdictional context. Pattern matching does not establish applicability, lawful processing, sector-specific requirements, or compliance with UAE law.",
    "该官方概览提供司法辖区背景。模式匹配不判断适用性、合法处理、行业特定义务或是否符合阿联酋法律。",
  )),
  oaic: official("Australian Privacy Principles guidelines", "https://www.oaic.gov.au/privacy/australian-privacy-principles-guidelines", "Office of the Australian Information Commissioner", "Australian Privacy Principles", bilingual(
    "This official privacy guidance supplies Australian context. Text screening does not determine APP applicability or satisfy an entity's privacy obligations.",
    "该官方隐私指引提供澳大利亚背景。文本筛查不判断 APP 的适用性，也不能满足组织的隐私义务。",
  )),
  australiaOnlineSafety: official("Online Safety Act 2021", "https://www.legislation.gov.au/C2021A00076/latest/text", "Australian Government Federal Register of Legislation", "Current text of the Online Safety Act", bilingual(
    "This Act supplies Australian online-safety context. A content filter does not determine whether a service is in scope or fulfil provider duties under the Act.",
    "该法案提供澳大利亚在线安全背景。内容过滤器不判断服务是否属于适用范围，也不能履行法案规定的服务商义务。",
  )),
  pci: official("Payment Card Industry Data Security Standard", "https://www.pcisecuritystandards.org/standards/pci-dss/", "PCI Security Standards Council", "Payment-account data security standard", bilingual(
    "Card-number detection may support data discovery. It is not PCI DSS validation, scope determination, implementation of required controls, or evidence of compliance.",
    "卡号检测可辅助数据发现，但不构成 PCI DSS 验证、范围判定、必要控制的实施或合规证据。",
  )),
  asic: official("Market integrity rules", "https://www.asic.gov.au/regulatory-resources/markets/market-integrity-rules/", "Australian Securities and Investments Commission", "Australian market-integrity reference", bilingual(
    "This is contextual market-integrity material. Phrase checks are not market surveillance and do not determine misconduct, jurisdiction, or legal compliance.",
    "这是市场诚信背景资料。短语检查不属于市场监控，也不判断不当行为、司法辖区或法律合规性。",
  )),
  bisCustomerDueDiligence: official("Customer due diligence for banks", "https://www.bis.org/publications/200110-guidelines-customer-due-diligence-banks", "Basel Committee on Banking Supervision", "Bank customer-identification and due-diligence guidance", bilingual(
    "This guidance supplies banking-sector context for customer identification. Phrase screening neither performs due diligence nor determines suspicious activity or compliance.",
    "该指引提供银行客户识别与尽职调查背景。短语筛查既不执行尽职调查，也不判断可疑活动或合规情况。",
  )),
  iataCybersecurity: official("Aviation Cyber Security", "https://www.iata.org/en/programs/security/cyber-security/", "International Air Transport Association", "Aviation-industry cybersecurity programme", bilingual(
    "This industry programme supplies aviation-security context. Keyword and identifier checks do not implement aviation security, operational controls, access control, or IATA guidance.",
    "该行业项目提供航空安全背景。关键词和标识符检查不能实现航空安全、运营控制、访问控制或 IATA 指引。",
  )),
} as const;
type SourceKey = keyof typeof sources;

const industrySourceByPolicy: Partial<Record<string, SourceKey>> = {
  "eu-ai-act-article5": "euAiAct",
  "gdpr-eu-pii-protection": "gdpr",
  "mas-ai-risk-management": "singaporeAi",
  "pdpa-singapore": "pdpa",
  "singapore-customer-identifiers": "pdpa",
  "singapore-data-use-boundaries": "pdpa",
  "singapore-financial-conduct": "singaporeAi",
  "airline-passenger-data-protection-uae": "uae",
  "uae-regulatory-compliance": "uae",
  "aviation-operations-security": "iataCybersecurity",
  "nsfw-content-filter-australia": "australiaOnlineSafety",
  "local-australian-tax-health-identifiers": "oaic",
  "local-payment-data": "pci",
  "banking-customer-protection": "bisCustomerDueDiligence",
  "securities-market-integrity": "asic",
  "internet-account-abuse": "nistIdentity",
  "claims-agent-safety": "whoHealth",
  "filter-denied-medical-advice": "whoHealth",
  "filter-harmful-child-safety": "unicefChildren",
  "local-credentials": "owaspSensitive",
  "local-sql-injection": "owaspSql",
  "filter-prompt-injection-sql": "owaspSql",
  "local-code-injection": "owaspCommand",
  "local-rendered-content-injection": "owaspXss",
  "block-code-execution": "owaspCommand",
};

const policiesWithoutExternalMapping = new Set([
  "airline-off-topic-restriction",
  "builtin-company-policy",
  "builtin-topic-safety",
  "configured-phrase-filter",
  "competitor-mention-detection",
  "filter-denied-financial-advice",
  "filter-denied-legal-advice",
  "keyword-blocking",
  "topic-filtering",
]);

function contextualSources(policy: PolicyInput): SourceKey[] {
  const explicit = industrySourceByPolicy[policy.id];
  if (explicit) return [explicit];
  if (policiesWithoutExternalMapping.has(policy.id)) return [];
  if (/medical|health|claims/.test(policy.id)) return ["whoHealth"];
  if (/child/.test(policy.id)) return ["unicefChildren"];
  if (/bias|sensitive-attribute/.test(policy.id)) return ["nistBias"];
  if (/sql/.test(policy.id)) return ["owaspSql"];
  if (/credential/.test(policy.id)) return ["owaspSensitive"];
  if (/rendered-content/.test(policy.id)) return ["owaspXss"];
  if (/code-execution|code-injection/.test(policy.id)) return ["owaspCommand"];
  if (/prompt|jailbreak|injection/.test(policy.id)) return ["owaspPrompt"];
  if (policy.tags?.some(tag => tag.namespace === "guardrail_category" && tag.value === "pii_detection")) return ["nistPii"];
  if (policy.tags?.some(tag => tag.namespace === "guardrail_category" && tag.value === "content_safety")) return ["nistGenAi"];
  if (/grounding|reasoning/.test(policy.id)) return ["nistGenAi"];
  return [];
}

function provenance(sourceFile: string): { provenance: Text; upstream: Text; license: Text } {
  if (sourceFile === "local_content_filters.json") return {
    provenance: bilingual("TaskLattice maintains the Policy definition, Rule grouping, runtime mapping and Test Cases. Its regulatory or industry context is documented separately below and is not inherited from a software library.", "TaskLattice 维护此 Policy 的定义、Rule 分组、运行时映射和 Test Cases。其监管或行业背景在下方单独说明，并非继承自某个软件库。"),
    upstream: bilingual("Implementation lineage only: selected detector seed material was reproducibly imported from pinned LiteLLM commit ead62528e607b9d8e61273def638799c9c3a69ba. LiteLLM is not the Policy's compliance authority, industry basis, or runtime dependency.", "仅说明实现沿革：部分检测器初始材料以可复现方式导入自固定的 LiteLLM commit ead62528e607b9d8e61273def638799c9c3a69ba。LiteLLM 不是此 Policy 的合规权威、行业依据或运行时依赖。"),
    license: bilingual("The imported implementation material is MIT-licensed; attribution and license text are retained in THIRD_PARTY_NOTICES.md. Regulatory and industry documents below are references, not incorporated software.", "导入的实现材料采用 MIT 许可，归属与许可全文保存在 THIRD_PARTY_NOTICES.md。下方监管及行业文件仅作为参考，并非被并入的软件。"),
  };
  if (sourceFile === "focused_policies.json") return {
    provenance: bilingual("TaskLattice maintains this focused Policy and its business-purpose grouping. Regulatory or industry context is selected independently from the detector implementation.", "TaskLattice 维护此聚焦 Policy 及其业务用途分组。监管或行业背景与检测器实现相互独立地选择。"),
    upstream: bilingual("Implementation lineage is repository-maintained. Where detector material was incorporated from a third party, THIRD_PARTY_NOTICES.md remains authoritative; that lineage is not a compliance mapping.", "实现沿革由仓库维护。若检测器材料包含第三方内容，以 THIRD_PARTY_NOTICES.md 为准；该沿革不构成合规映射。"),
    license: bilingual("Distributed under the repository license, subject to THIRD_PARTY_NOTICES.md for incorporated material. External regulatory and industry references grant no software rights.", "依据仓库许可分发；所含材料受 THIRD_PARTY_NOTICES.md 约束。外部监管及行业参考不授予软件权利。"),
  };
  if (sourceFile === "model_capability_policies.json") return {
    provenance: bilingual("TaskLattice maintains this capability contract. It invokes a configured model through the local runtime; results depend on the selected provider, model profile and validation evidence.", "TaskLattice 维护此能力契约。它通过本地运行时调用已配置模型；结果取决于所选 Provider、模型 Profile 和验证证据。"),
    upstream: bilingual("No model weights or provider behavior are bundled. Runtime framework and provider documentation describe implementation dependencies, not regulatory or industry authority.", "不随附模型权重或 Provider 行为。运行时框架及 Provider 文档说明实现依赖，而不是监管或行业权威依据。"),
    license: bilingual("The integration contract follows the repository license. Model services, weights and outputs are governed by their respective providers.", "集成契约遵循仓库许可；模型服务、权重和输出受各 Provider 条款约束。"),
  };
  if (sourceFile === "configurable_policies.json") return {
    provenance: bilingual("TaskLattice maintains this configurable Policy. Its effective behavior comes from administrator-supplied phrases and parameters, not an external standard.", "TaskLattice 维护此可配置 Policy；实际行为来自管理员提供的短语和参数，而非外部标准。"),
    upstream: bilingual("No external detector list or regulatory mapping is bundled for this Policy.", "此 Policy 不包含外部检测词表或监管映射。"),
    license: bilingual("The implementation follows the repository license. Administrators are responsible for rights to configured content.", "实现遵循仓库许可；管理员负责确保对配置内容拥有相应权利。"),
  };
  return {
    provenance: bilingual(`TaskLattice maintains this built-in catalog definition in runner/toolkit/policy_library/assets/${sourceFile}. Regulatory and industry references are selected separately from implementation provenance.`, `TaskLattice 在 runner/toolkit/policy_library/assets/${sourceFile} 中维护此内置目录定义。监管及行业参考与实现来源分别选择。`),
    upstream: bilingual("The repository does not assert a separate upstream Policy unless implementation lineage is explicitly documented. External documents below provide context and are not the source code or authorship of this Policy.", "除非明确记录实现沿革，否则仓库不声明存在独立上游 Policy。下方外部文件仅提供背景，不是此 Policy 的源代码或作者来源。"),
    license: bilingual("The Policy definition follows the repository license and THIRD_PARTY_NOTICES.md. External references do not grant additional software rights.", "Policy 定义遵循仓库许可及 THIRD_PARTY_NOTICES.md。外部参考不授予额外软件权利。"),
  };
}

export function builtInPolicyCompliance(policy: PolicyInput, sourceFile: string): PolicyCompliance {
  const ruleIds = policy.rules.slice(0, 3).map(rule => rule.id);
  if (!ruleIds.length) throw new Error(`Policy ${policy.id} needs at least one Rule for source documentation.`);
  const origin = provenance(sourceFile);
  const forms = [...new Set(policy.rules.map(rule => rule.form))];
  const references = contextualSources(policy).map(source => ({ ...sources[source], rule_ids: ruleIds }));
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
    references,
    coverage: [{
      rule_ids: ruleIds,
      description: bilingual(
        `The implementation evaluates configured ${forms.join(", ")} Rules. The related Rules below are representative; inspect the Policy tab for the complete executable inventory and Test Cases for sampled behavior.`,
        `实现会执行已配置的 ${forms.join("、")} Rules。下列关联 Rules 为代表性示例；完整可执行清单见 Policy 页签，抽样行为见 Test Cases。`,
      ),
    }],
    limitations: [
      bilingual("Detection is bounded by configured patterns, phrases, classifier/model behavior and request context; false positives and false negatives are possible.", "检测能力受已配置模式、短语、分类器或模型行为及请求上下文限制，可能出现误报和漏报。"),
      bilingual("Regulatory and industry references provide context only. The Policy does not determine legal scope, consent, lawful basis, governance, operational controls or an organisation's compliance status.", "监管及行业参考仅提供背景。Policy 不判断法律适用范围、同意、合法依据、治理、运营控制或组织合规状态。"),
      bilingual("Passing Test Cases demonstrates only the recorded examples and does not establish production effectiveness against all inputs.", "Test Cases 通过仅说明记录样例符合预期，不证明对所有生产输入均有效。"),
    ],
    review: {
      status: "reviewed",
      reviewed_on: reviewedOn,
      reviewer: "TaskLattice Engineering",
      notes: bilingual("Engineering reviewed the implementation lineage, reference relevance, link target and technical boundary. Legal applicability and compliance conclusions require qualified independent review.", "工程团队已审查实现沿革、参考相关性、链接目标和技术边界。法律适用性及合规结论仍需具备资质的独立审查。"),
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
    upstream_status: bilingual("No external implementation source is declared in the Policy metadata.", "Policy 元数据未声明外部实现来源。"),
    license_status: bilingual("No external license or attribution is declared. The owner is responsible for source and licensing records.", "未声明外部许可或归属；所有者负责维护来源及许可记录。"),
    references: [],
    coverage: ruleIds.length ? [{ rule_ids: ruleIds, description: bilingual("Coverage is defined by the published Rail bindings and executable Test Cases shown in this inspector.", "覆盖范围由此检查器中展示的已发布 Rail 绑定及可执行 Test Cases 定义。") }] : [],
    limitations: [bilingual("TaskLattice has not independently verified the implementation source, legal mapping or compliance status of this custom Policy.", "TaskLattice 未独立核验此自定义 Policy 的实现来源、法律映射或合规状态。")],
    review: { status: "pending", reviewed_on: null, reviewer: null, notes: bilingual("Add qualified source and compliance review outside the current Policy editor when required.", "如有需要，请在当前 Policy 编辑器之外补充具备资质的来源与合规审查。") },
  };
}
