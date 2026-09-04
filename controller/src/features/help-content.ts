import {
  enforcementActionConflictOrder,
  enforcementActionDescriptions,
  enforcementActionDisplayOrder,
  type EnforcementAction,
} from "../../shared/enforcement-action.generated";

export type HelpAudience = "user" | "developer" | "operator";
export type HelpLocale = "en" | "zh-CN";
export type HelpLinkTo = "/policy-library" | "/guardrails" | "/deployments" | "/integrations" | "/evidence" | "/playground";

export type HelpStep = { title: string; description: string };
export type HelpTermRow = { name: string; description: string };
export type HelpArticle = {
  id: string;
  title: string;
  summary: string;
  paragraphs?: string[];
  steps?: HelpStep[];
  bullets?: string[];
  terms?: HelpTermRow[];
  links?: Array<{ label: string; to: HelpLinkTo }>;
  note?: string;
};

export type HelpGuide = {
  id: HelpAudience;
  label: string;
  title: string;
  summary: string;
  outcome: string;
  articles: HelpArticle[];
};

export type GlossaryEntry = {
  id: string;
  term: string;
  aliases: string[];
  definition: string;
  background: string;
  audiences: HelpAudience[];
};

export type HelpContent = {
  title: string;
  description: string;
  searchLabel: string;
  searchPlaceholder: string;
  searchHint: string;
  clearSearch: string;
  noResultsTitle: string;
  noResultsDescription: string;
  contents: string;
  overviewLabel: string;
  overviewTitle: string;
  overviewDescription: string;
  architectureTitle: string;
  architectureDescription: string;
  architecture: HelpTermRow[];
  choosePath: string;
  choosePathDescription: string;
  guideLabel: string;
  articleLabel: string;
  relatedPages: string;
  keyConcepts: string;
  glossaryTitle: string;
  glossaryDescription: string;
  searchResults: string;
  roleResults: string;
  glossaryResults: string;
  audienceLabels: Record<HelpAudience, string>;
  guides: HelpGuide[];
  glossary: GlossaryEntry[];
};

export type HelpSearchResults = {
  guides: Array<{ guide: HelpGuide; articles: HelpArticle[] }>;
  glossary: GlossaryEntry[];
};

// Localized presentation text is intentionally separate from the wire
// contract, while Record<EnforcementAction, ...> makes additions fail typecheck
// until Help documents every newly introduced directive.
const ZH_ENFORCEMENT_ACTION_DESCRIPTIONS = Object.freeze({
  reject: "阻断当前阶段。输入阶段不调用模型；输出阶段不交付原始响应。",
  clarify: "要求用户补充或澄清信息后再继续，适合意图不确定但不应直接放行的情况。",
  fallback: "使用预先批准的兜底响应或降级路径。",
  regenerate: "要求拥有模型调用生命周期的上游重新生成；独立检查 API 返回该指令，由调用方执行。",
  rewrite: "使用评估器返回的完整替代内容替换当前内容。",
  redirect: "把交互引导到安全主题、流程或替代响应；通常需要提供替换内容。",
  redact: "用经过审查的占位符或替换片段遮盖敏感内容，然后继续。",
  pass: "记录发现但不执行内容干预；仅在明确接受该风险时使用。",
} as const satisfies Readonly<Record<EnforcementAction, string>>);

function enforcementActionTerms(
  descriptions: Readonly<Record<EnforcementAction, string>>,
): HelpTermRow[] {
  return enforcementActionDisplayOrder.map((name) => ({
    name,
    description: descriptions[name],
  }));
}

export function getHelpContent(locale: HelpLocale): HelpContent {
  return locale === "zh-CN" ? ZH_CONTENT : EN_CONTENT;
}

export function searchHelpContent(content: HelpContent, query: string): HelpSearchResults {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return { guides: content.guides.map((guide) => ({ guide, articles: guide.articles })), glossary: content.glossary };
  const matches = (values: Array<string | undefined>) => {
    const haystack = normalize(values.filter(Boolean).join(" "));
    const latinTokens = haystack.split(/[^a-z0-9]+/).filter(Boolean);
    return words.every((word) => /^[a-z0-9]+$/.test(word) ? latinTokens.includes(word) : haystack.includes(word));
  };
  const guides = content.guides.map((guide) => {
    const guideMatches = matches([guide.label, guide.title, guide.summary, guide.outcome]);
    const articles = guideMatches ? guide.articles : guide.articles.filter((article) => matches([
      article.title,
      article.summary,
      ...(article.paragraphs ?? []),
      ...(article.steps ?? []).flatMap((step) => [step.title, step.description]),
      ...(article.bullets ?? []),
      ...(article.terms ?? []).flatMap((term) => [term.name, term.description]),
      article.note,
    ]));
    return { guide, articles };
  }).filter((item) => item.articles.length > 0);
  const glossary = content.glossary.filter((entry) => matches([entry.term, ...entry.aliases, entry.definition, entry.background]));
  return { guides, glossary };
}

function normalize(value: string) {
  return value.trim().toLocaleLowerCase().replace(/[，。、：；（）/·—_-]+/g, " ");
}

const ZH_CONTENT: HelpContent = {
  title: "帮助中心",
  description: "理解 TaskLattice Guard 的核心概念，并按你的职责完成策略设计、开发集成和生产运维。",
  searchLabel: "搜索帮助文档",
  searchPlaceholder: "搜索 Policy、Rail、Flow、Validation、Deployment…",
  searchHint: "可搜索产品术语、操作步骤、运行时行为和故障处理。",
  clearSearch: "清除搜索",
  noResultsTitle: "没有匹配的帮助内容",
  noResultsDescription: "尝试更短的概念名称，例如 Rail、Action、版本或部署。",
  contents: "文档目录",
  overviewLabel: "系统背景",
  overviewTitle: "从业务策略到受保护流量",
  overviewDescription: "TaskLattice Guard 是独立的 Guardrail 决策服务。业务团队定义可理解的保护意图，系统把已验证版本编译为 NeMo Guardrails 配置，应用或网关在模型前后调用检查接口并执行返回的决策。",
  architectureTitle: "一条请求如何被保护",
  architectureDescription: "下面是产品对象与运行时对象之间的主链路。每一步都有明确的版本和审计边界。",
  architecture: [
    { name: "Integration", description: "识别并认证调用 TaskLattice 的应用、Agent 或网关。" },
    { name: "Deployment", description: "按 Traffic Scope 为该 Integration 选择一个已发布的 Guardrail Version。" },
    { name: "Guardrail Version", description: "固定所选 Policies、Rules、参数和编译结果，是发布与回滚单元。" },
    { name: "NeMo Rail / Flow", description: "在模型输入或输出阶段编排实际执行的检查。" },
    { name: "Action", description: "执行确定性检测、专用模型判断或内容变换，并返回结构化发现。" },
    { name: "Decision & Evidence", description: "返回放行、转换或阻断决策，并记录不含受保护正文的审计证据。" },
  ],
  choosePath: "选择你的使用路径",
  choosePathDescription: "角色不是权限等级，而是阅读顺序。一个人可以同时使用多条路径。",
  guideLabel: "角色指南",
  articleLabel: "本节内容",
  relatedPages: "前往相关页面",
  keyConcepts: "关键概念",
  glossaryTitle: "概念词典",
  glossaryDescription: "产品界面、API、运行日志和审计证据使用同一组术语。这里给出简短定义和它存在的原因。",
  searchResults: "搜索结果",
  roleResults: "角色指南",
  glossaryResults: "概念词典",
  audienceLabels: { user: "普通用户", developer: "开发者", operator: "运维人员" },
  guides: [
    {
      id: "user",
      label: "普通用户",
      title: "设计、验证并发布保护策略",
      summary: "适合安全、合规、产品和业务负责人。重点是表达意图、复用 Policy、验证行为和检查证据。",
      outcome: "最终产出：一个经过测试、可以被 Deployment 引用的 Guardrail Version。",
      articles: [
        {
          id: "user-lifecycle",
          title: "标准工作流：从 Policy 到保护",
          summary: "先复用经过审查的能力，再组合、验证、发布和部署。",
          steps: [
            { title: "1. 浏览 Policy Library", description: "阅读 Policy 的用途、Rules、参数和 Test Cases，确认它能表达所需保护行为。" },
            { title: "2. 创建 Guardrail", description: "描述业务用途和边界，选择 Policy Version，并确认实际启用的 Rules 与 Rails。" },
            { title: "3. 运行 Validation Run", description: "让当前草稿的 Test Cases 通过与生产相同的 NeMo 运行时；失败结果也会保留为证据。" },
            { title: "4. 发布版本", description: "把已通过验证的草稿固化为不可变 Guardrail Version。后续修改不会改变已有版本。" },
            { title: "5. 创建 Deployment", description: "选择 Integration 和 Traffic Scope，把匹配流量绑定到确切版本。" },
            { title: "6. 观察与改进", description: "在 Playground 进行端到端试用，并通过 Evidence 和运行指标检查真实结果。" },
          ],
          links: [
            { label: "打开 Policy Library", to: "/policy-library" },
            { label: "管理 Guardrails", to: "/guardrails" },
            { label: "在 Guardrail 中查看 Validation", to: "/guardrails" },
          ],
        },
        {
          id: "user-review-policy",
          title: "如何阅读一个 Policy",
          summary: "不要只看名称；至少检查 Rules、Test Cases、版本和参数。",
          bullets: [
            "Policy 是可复用能力，不是某个应用的部署配置。",
            "Rule 是最小可执行行为；禁用一条 Rule 会改变实际编译内容。",
            "Test Case 说明该 Rule 或业务场景应该放行、转换还是阻断。",
            "Policy Version 是不可变快照；Guardrail 会固定到确切版本。",
            "必填参数必须在绑定到 Guardrail 时解析，不能留到生产请求时临时决定。",
          ],
          note: "内建 Policy 由系统管理；自定义 Policy 由开发者在 Policy Studio 中维护。两者在 Guardrail 中使用相同的 Policy → Rule → Test Case 模型。",
          links: [{ label: "浏览 Policy Library", to: "/policy-library" }],
        },
        {
          id: "user-decisions",
          title: "理解放行、转换和阻断",
          summary: "最终 Decision 是业务调用方必须执行的结果，不只是一个风险标签。",
          terms: [
            { name: "Allow / pass", description: "内容可继续进入下一阶段；未触发需要执行的干预。" },
            { name: "Transform", description: "系统返回经过脱敏、重写或其他变换后的有效内容，调用方应使用返回内容。" },
            { name: "Block / reject", description: "停止当前阶段。输入被阻断时不应调用模型；输出被阻断时不应把原始响应交付给用户。" },
          ],
          note: "Playground 会展示模型前检查、模型调用和模型后检查的完整链路，适合在上线前确认调用方行为。",
          links: [{ label: "打开 Playground", to: "/playground" }, { label: "查看 Evidence", to: "/evidence" }],
        },
      ],
    },
    {
      id: "developer",
      label: "开发者",
      title: "编写 Policy 并接入受保护流量",
      summary: "适合 Policy 开发者、应用开发者和网关集成开发者。重点是版本化源码、运行契约、测试覆盖和 API 决策处理。",
      outcome: "最终产出：可复用的 Policy Version，或一个正确执行 Guardrail 决策的 Integration。",
      articles: [
        {
          id: "developer-policy-or-guardrail",
          title: "什么时候创建 Policy，什么时候创建 Guardrail",
          summary: "Policy 解决复用行为，Guardrail 解决一个业务场景的组合与发布。",
          terms: [
            { name: "创建 Policy", description: "当你需要新的可执行能力、Colang Flow、版本化 Action 依赖或可复用参数契约时。" },
            { name: "创建 Guardrail", description: "当能力已经存在，只需要为具体应用选择 Policies、Rules、参数、强度和交付方式时。" },
            { name: "创建 Deployment", description: "当 Guardrail 已发布，需要把某个 Integration 的一部分或全部流量路由到该版本时。" },
          ],
          links: [{ label: "进入 Policy Studio", to: "/policy-library" }, { label: "管理 Guardrails", to: "/guardrails" }],
        },
        {
          id: "developer-policy-runtime",
          title: "理解 Policy Studio 的运行配置",
          summary: "截图中的 Rail、Flow、执行模式、Action 和参数共同组成 Policy 的运行契约。",
          paragraphs: [
            "自定义 Policy 自动使用 Colang 2.x 可编程运行时，开发者不需要在 Colang 1 与 2 之间做选择。系统只允许调用已注册、带版本的 Actions，不接受任意 Python 上传。",
          ],
          terms: [
            { name: "Rail", description: "NeMo 的执行阶段。Input Rail 在模型调用前检查用户输入；Output Rail 在模型响应交付前检查输出。" },
            { name: "Flow 名称", description: "Colang 源码中声明的命名 Flow。绑定名称必须与源码完全一致，并形成 Rule ID：flow/{rail}/{flow_name}。" },
            { name: "执行模式：detect", description: "只判断并记录安全状态，不把修改内容作为主要目的；不安全时仍按配置的 Action 执行。" },
            { name: "执行模式：mutate", description: "该 Flow 预期可能返回有效替换内容，例如脱敏或重写。" },
            { name: "高级运行设置", description: "parallel group 控制可安全并发的绑定；timeout 限制执行时间。超时及 provider error 按版本化 failure mode 处理。" },
            { name: "Action 依赖", description: "Flow 调用的注册 Provider 及其精确版本。发布前会检查存在性、Rail 兼容性和输入输出契约。" },
            { name: "绑定参数", description: "Policy 暴露给 Guardrail 的审查值。Guardrail 固定 Policy Version 时必须解析必填参数。" },
          ],
          links: [{ label: "打开 Policy Library", to: "/policy-library" }],
        },
        {
          id: "developer-actions",
          title: `“不安全时”的 ${enforcementActionConflictOrder.length} 种检测后处理`,
          summary: "检测后处理（Enforcement Action）表示 Policy 决策后希望运行时或调用方采取的干预，不是 NeMo Action。多项结果冲突时使用优先级最高的处理。",
          terms: enforcementActionTerms(ZH_ENFORCEMENT_ACTION_DESCRIPTIONS),
          note: `冲突优先级：${enforcementActionConflictOrder.join(" → ")}。TaskLattice 是决策服务；regenerate、redirect、fallback、clarify 等动作是否真正改变交互，取决于调用方是否正确执行返回的 action/texts。`,
        },
        {
          id: "developer-release-transfer",
          title: "测试、发布与跨环境迁移",
          summary: "源码通过编译还不等于可以发布；每条 Flow-backed Rule 都需要必需 Test Case。",
          bullets: [
            "Test Case 必须指定 Rail、内容、期望 Decision 和 covered Rule IDs。",
            "Validate & run tests 会先保存草稿、用生产编译器校验，再通过真实 NeMo runtime 执行测试。",
            "失败的当前草稿不能发布；修改源码、Rails、Actions、参数或测试后必须重新运行。",
            "导出包携带可编辑定义，不携带另一个环境的 Validation Run 或发布状态。目标环境必须重新验证。",
            "发布后的 Policy Version 不可变；后续修改形成新的 draft revision 和版本。",
          ],
          links: [{ label: "在 Guardrail 中查看 Validation", to: "/guardrails" }, { label: "打开 Policy Library", to: "/policy-library" }],
        },
        {
          id: "developer-integration",
          title: "应用与网关如何执行决策",
          summary: "调用方拥有模型调用；TaskLattice 在输入和输出边界返回明确 Decision。",
          steps: [
            { title: "输入检查", description: "发送用户输入和可信上下文。若 block/reject，停止并且不要调用模型；若 transform，使用返回内容调用模型。" },
            { title: "模型调用", description: "应用或网关继续拥有模型请求、重试、流式输出和业务会话。" },
            { title: "输出检查", description: "把完整或按配置缓冲的模型响应送入相同 Guardrail Version。阻断时不要泄露原始响应。" },
            { title: "关联调用", description: "使用稳定 call ID 关联输入与输出，保证两阶段固定到同一个版本；Integration 身份隔离不同网关。" },
          ],
          links: [{ label: "管理 Integrations", to: "/integrations" }, { label: "查看 Deployments", to: "/deployments" }],
        },
      ],
    },
    {
      id: "operator",
      label: "运维人员",
      title: "发布、路由并运维 NeMo Guardrails",
      summary: "适合平台工程、SRE 和安全运营人员。重点是可信身份、版本路由、运行健康、容量、回滚和证据。",
      outcome: "最终产出：可观测、可回滚且不会绕过 Guardrail 的生产流量路径。",
      articles: [
        {
          id: "operator-runtime",
          title: "生产运行时边界",
          summary: "控制面管理版本，NeMo 执行检查，应用或网关执行最终决策。",
          bullets: [
            "发布时编译并验证不可变 NeMoConfigSnapshot，计算 checksum，再预热确切 runtime profile。",
            "活动版本常驻 runtime registry；生产请求不会在热路径临时构建运行时。",
            "简单计划可由编译器选择 Colang 1 standard profile；自定义可编程 Policy 使用 Colang 2。不要手工切换 profile。",
            "每个 Guardrail Version 有独立并发限制；排队时间计入请求总 deadline。",
            "必需检查的超时、队列超时或 Provider 错误会按版本化 fail-open/fail-closed 配置处理。",
          ],
        },
        {
          id: "operator-routing",
          title: "Integration、Deployment 与 Traffic Scope",
          summary: "从集成身份到部署路由：先确认流量身份，再按顺序匹配；不能用可伪造字段代替认证边界。",
          steps: [
            { title: "注册 Integration", description: "为每个应用、Agent、网关或信任边界创建独立身份和凭据。" },
            { title: "创建 Deployment", description: "选择已发布 Guardrail Version 和 Traffic Scope。一个 Integration 内按顺序 first-match-wins。" },
            { title: "保留 fallback", description: "All traffic 路由保持在最后；未匹配任何 Integration 路由的流量使用系统管理 baseline。" },
            { title: "验证可信上下文", description: "优先使用 Integration 身份、已验证 JWT claims 或由可信代理重写的 headers。" },
          ],
          links: [{ label: "管理 Integrations", to: "/integrations" }, { label: "管理 Deployments", to: "/deployments" }],
        },
        {
          id: "operator-release-rollback",
          title: "安全发布与回滚",
          summary: "发布和回滚都在切换指针前验证、预热目标版本。",
          bullets: [
            "发布前确认当前 Validation Run 通过、checksum 已生成、依赖和专用模型可用。",
            "观察 Runtime health 中活动 Deployment、Integration 和可选能力状态。",
            "回滚会验证并预热历史不可变快照，再在数据库事务中切换 Guardrail 与绑定的 Deployments。",
            "进行中的调用继续使用开始时固定的版本；新调用使用回滚后的版本。",
            "不要修改历史 artifact 或在进程外替换源码；任何语义变化都应创建新版本。",
          ],
          links: [{ label: "查看 Guardrails", to: "/guardrails" }, { label: "查看 Evidence", to: "/evidence" }],
        },
        {
          id: "operator-troubleshooting",
          title: "故障处理顺序",
          summary: "先判断路由与版本，再看 Rail、Action 和 Provider，最后看容量。",
          steps: [
            { title: "1. 身份与路由", description: "确认 Integration 已启用、凭据匹配、Deployment 顺序正确，Traffic Scope 使用可信字段。" },
            { title: "2. 版本状态", description: "确认 Deployment 指向预期 Guardrail Version，checksum 与发布记录一致。" },
            { title: "3. Rail 与 Action", description: "从 Evidence/trace 检查命中的 Policy、Rule、Rail、Action、实际 Decision 和延迟。" },
            { title: "4. Provider 与依赖", description: "确认专用 evaluator、模型、网络和 Secret 可用；不要用通用聊天模型冒充 runtime judge。" },
            { title: "5. 容量与超时", description: "查看排队、Rail、Action 和 Provider 延迟，区分并发饱和、deadline 与真实检测失败。" },
          ],
          links: [{ label: "查看 Evidence", to: "/evidence" }, { label: "查看 Integrations", to: "/integrations" }],
        },
      ],
    },
  ],
  glossary: [],
};

ZH_CONTENT.glossary = [
  ["policy", "Policy", ["策略"], "可复用的保护能力，包含一个或多个可执行 Rules 及其 Test Cases。", "Policy 与具体应用解耦，因此可以被多个 Guardrails 按版本复用。", ["user", "developer"]],
  ["rule", "Rule", ["规则"], "最小的产品级可执行行为，有稳定 ID、阶段、效果和实现映射。", "Rule ID 会贯穿 Policy、Guardrail binding、runtime finding 和 Validation result，避免不同 Flow 被错误合并。", ["user", "developer"]],
  ["test-case", "Test Case", ["测试用例", "case"], "输入或输出示例、期望 Decision，以及它验证的 Rule IDs。", "必需验收用例是发布 Gate；场景用例用于覆盖真实业务边界。", ["user", "developer"]],
  ["guardrail", "Guardrail", ["安全护栏"], "为一个业务场景组合版本化 Policies、Rules、参数和运行姿态的可发布对象。", "Policy 负责复用能力，Guardrail 负责场景组合和生命周期。", ["user", "operator"]],
  ["policy-binding", "Policy Binding", ["策略绑定"], "Guardrail 对某个 Policy Version 的固定引用，包含启用 Rules、Rails、参数和动作覆盖。", "绑定保证运行的正是审查时选择的行为。", ["user", "developer"]],
  ["policy-version", "Policy Version", ["策略版本"], "已发布、不可修改的 Policy 源码和运行契约快照。", "后续编辑产生新草稿和新版本，已有 Guardrails 不会被静默改变。", ["user", "developer", "operator"]],
  ["guardrail-version", "Guardrail Version", ["护栏版本"], "不可变的发布与回滚单元，包含编译 artifact、依赖和 checksum。", "Deployment 总是引用确切版本；回滚切换版本指针而不是重写历史。", ["user", "operator"]],
  ["rail", "Rail", ["input rail", "output rail"], "NeMo 在模型前或模型后执行安全逻辑的阶段。", "Input Rail 能在模型调用前阻断；Output Rail 能在交付前转换或阻断响应。", ["developer", "operator"]],
  ["flow", "Flow", ["Colang Flow", "flow name"], "Colang 中命名的编排单元，把事件、Actions 和决策组织成一个 Rail 行为。", "Policy Studio 的 Flow 名称必须与源码声明一致。", ["developer"]],
  ["colang", "Colang", ["Colang 1", "Colang 2"], "NVIDIA NeMo Guardrails 的对话与安全编排语言。", "TaskLattice 编译器为简单内建计划选择 Colang 1；自定义 Policy 自动使用 Colang 2，开发者无需选择。", ["developer", "operator"]],
  ["action", "Action", ["Provider", "Python Action", "NeMo Action"], "由 NeMo Flow 调用的版本化能力，执行检测、专用模型判断或内容变换。", "它不同于检测完成后的 Enforcement Action；只允许调用 Action Catalog 中已注册的版本。", ["developer", "operator"]],
  ["enforcement-action", "检测后处理", ["Enforcement Action", "响应指令", "不安全时"], "Policy 决策后要求运行时或调用方采取的具体处理，例如脱敏、阻断或重新生成。", "它不是评估器 verdict，也不是 NeMo 调用的 Python Action；部分生命周期指令由集成调用方执行。", ["user", "developer", "operator"]],
  ["action-reference", "Action Reference", ["Action 依赖"], "Policy 对 Action 名称和精确版本的引用。", "发布前检查可用性、Rail 兼容性和契约，保证以后可复现。", ["developer"]],
  ["parameter", "Binding Parameter", ["绑定参数", "parameter"], "Policy 暴露、由 Guardrail 绑定时解析的审查值。", "参数属于配置版本，不应从不可信的生产请求临时覆盖。", ["user", "developer"]],
  ["validation-run", "Validation Run", ["验证记录"], "当前草稿的 Test Cases 通过真实运行时执行后形成的不可变结果。", "只有当前 revision 的必需用例全部通过，才能发布。", ["user", "developer", "operator"]],
  ["deployment", "Deployment", ["部署", "route"], "把一个 Integration 的匹配 Traffic Scope 路由到已发布 Guardrail Version。", "同一 Integration 内按顺序 first-match-wins；All traffic 保持最后。", ["user", "operator"]],
  ["integration", "Integration", ["集成", "adapter"], "代表一个经过认证的应用、Agent 或网关实例。", "不同信任边界使用独立 Integration，避免身份、凭据和 call context 混用。", ["developer", "operator"]],
  ["traffic-scope", "Traffic Scope", ["流量范围", "路由条件"], "基于可信请求事实构造的 AND/OR 路由表达式。", "空表达式表示该 Integration 的全部流量；外部 headers 若未被可信代理重写可能被伪造。", ["developer", "operator"]],
  ["evidence", "Evidence", ["审计证据", "trace"], "记录版本变化、验证、部署和脱敏运行决策的不可变证据。", "Evidence 默认不保存受保护请求或响应正文，但保留 Policy、Rule、版本、Decision 和延迟等判断依据。", ["user", "operator"]],
  ["runtime-profile", "Runtime Profile", ["llmrails", "iorails"], "编译器选择的 NeMo 执行形态和 Colang 版本组合。", "Profile 是编译结果，不是日常用户选项；它由行为复杂度和执行边界决定。", ["developer", "operator"]],
  ["checksum", "Checksum", ["配置哈希", "SHA-256"], "不可变编译配置的内容摘要。", "用于确认当前运行 artifact 与已发布版本完全一致。", ["developer", "operator"]],
  ["failure-mode", "Failure Mode", ["fail-open", "fail-closed"], "Action 超时或错误时的安全处理方式。", "fail-open 继续但记录错误；fail-closed 阻断。必需检查通常采用更保守的策略。", ["developer", "operator"]],
  ["output-delivery", "Output Delivery", ["interruptible", "window buffered", "full buffered"], "模型输出在完成 Output Rail 检查前如何缓冲和交付。", "缓冲越完整，越能避免泄露后来被阻断的内容，但会增加首字延迟。", ["user", "operator"]],
  ["decision", "Decision", ["allow", "transform", "block"], "TaskLattice 对当前阶段的最终结论。", "调用方必须执行 Decision 和 action；它不是仅供展示的风险分数。", ["user", "developer", "operator"]],
].map(([id, term, aliases, definition, background, audiences]) => ({ id, term, aliases, definition, background, audiences } as GlossaryEntry));

const EN_CONTENT: HelpContent = {
  ...ZH_CONTENT,
  title: "Help Center",
  description: "Understand TaskLattice Guard concepts and follow the right path for policy use, development, and production operations.",
  searchLabel: "Search help",
  searchPlaceholder: "Search Policy, Rail, Flow, Validation, Deployment…",
  searchHint: "Search product terms, procedures, runtime behavior, and troubleshooting.",
  clearSearch: "Clear search",
  noResultsTitle: "No matching help content",
  noResultsDescription: "Try a shorter concept such as Rail, Action, version, or deployment.",
  contents: "Contents",
  overviewLabel: "System background",
  overviewTitle: "From business policy to protected traffic",
  overviewDescription: "TaskLattice Guard is an explicit Guardrail decision service. Teams define reviewable protection intent, the system compiles validated versions into NeMo Guardrails configuration, and applications or gateways call checks around the model and execute the returned decision.",
  architectureTitle: "How one request is protected",
  architectureDescription: "This is the main path from product objects to runtime execution. Every transition has a version and audit boundary.",
  architecture: [
    { name: "Integration", description: "Identifies and authenticates the application, agent, or gateway calling TaskLattice." },
    { name: "Deployment", description: "Uses Traffic Scope to select a published Guardrail Version for that Integration." },
    { name: "Guardrail Version", description: "Pins Policies, Rules, parameters, and compiled output as the release and rollback unit." },
    { name: "NeMo Rail / Flow", description: "Orchestrates checks before the model or before its output is delivered." },
    { name: "Action", description: "Runs local checks, specialized evaluators, or content transformations." },
    { name: "Decision & Evidence", description: "Returns allow, transform, or block and records privacy-conscious evidence." },
  ],
  choosePath: "Choose your path",
  choosePathDescription: "Roles define a reading order, not a permission level. One person may use more than one path.",
  guideLabel: "Role guides",
  articleLabel: "In this section",
  relatedPages: "Open related pages",
  keyConcepts: "Key concepts",
  glossaryTitle: "Concept glossary",
  glossaryDescription: "The product UI, API, runtime logs, and evidence use the same vocabulary. These definitions explain both meaning and purpose.",
  searchResults: "Search results",
  roleResults: "Role guides",
  glossaryResults: "Concept glossary",
  audienceLabels: { user: "Everyday user", developer: "Developer", operator: "Operator" },
  guides: [
    {
      id: "user",
      label: "Everyday user",
      title: "Design, validate, and release protection",
      summary: "For security, compliance, product, and business owners. Focus on intent, reusable Policies, validation, and evidence.",
      outcome: "Outcome: a tested Guardrail Version that a Deployment can reference.",
      articles: [
        {
          id: "user-lifecycle",
          title: "Standard workflow: Policy to protection",
          summary: "Reuse reviewed capabilities, then compose, validate, publish, and deploy.",
          steps: [
            { title: "1. Browse Policy Library", description: "Review purpose, Rules, parameters, and Test Cases." },
            { title: "2. Create a Guardrail", description: "Describe business boundaries and select Policy Versions, Rules, and Rails." },
            { title: "3. Run Validation", description: "Execute the current draft's Test Cases through the production-equivalent NeMo runtime." },
            { title: "4. Publish", description: "Freeze the passing draft as an immutable Guardrail Version." },
            { title: "5. Deploy", description: "Bind an Integration and Traffic Scope to the exact version." },
            { title: "6. Observe", description: "Use Playground, Evidence, and metrics to verify real behavior." },
          ],
          links: [{ label: "Open Policy Library", to: "/policy-library" }, { label: "Manage Guardrails", to: "/guardrails" }, { label: "View Validation in a Guardrail", to: "/guardrails" }],
        },
        {
          id: "user-review-policy",
          title: "How to read a Policy",
          summary: "Do not stop at the name; inspect Rules, Test Cases, version, and parameters.",
          bullets: [
            "A Policy is a reusable capability, not an application deployment.",
            "A Rule is the smallest executable behavior; disabling one changes compiled behavior.",
            "A Test Case states whether a Rule or scenario should allow, transform, or block.",
            "A Guardrail pins an immutable Policy Version.",
            "Required parameters are resolved when the Policy is bound to a Guardrail.",
          ],
          note: "Built-in and custom Policies use the same Policy → Rule → Test Case product model.",
          links: [{ label: "Browse Policy Library", to: "/policy-library" }],
        },
        {
          id: "user-decisions",
          title: "Understand allow, transform, and block",
          summary: "The final Decision is something the caller must execute, not merely a risk label.",
          terms: [
            { name: "Allow / pass", description: "The content may continue to the next phase." },
            { name: "Transform", description: "Use the returned redacted, rewritten, or otherwise transformed content." },
            { name: "Block / reject", description: "Stop the phase. Do not call the model for blocked input or deliver blocked output." },
          ],
          note: "Playground shows the input check, model call, and output check as one inspectable path.",
          links: [{ label: "Open Playground", to: "/playground" }, { label: "View Evidence", to: "/evidence" }],
        },
      ],
    },
    {
      id: "developer",
      label: "Developer",
      title: "Author Policies and integrate protected traffic",
      summary: "For Policy, application, and gateway developers. Focus on versioned source, runtime contracts, test coverage, and decision handling.",
      outcome: "Outcome: a reusable Policy Version or an Integration that correctly executes Guardrail decisions.",
      articles: [
        {
          id: "developer-policy-or-guardrail",
          title: "Policy vs Guardrail vs Deployment",
          summary: "Policies provide reusable behavior, Guardrails compose a scenario, and Deployments route traffic.",
          terms: [
            { name: "Create a Policy", description: "When you need a new executable capability, Colang Flow, Action dependency, or reusable parameter contract." },
            { name: "Create a Guardrail", description: "When capabilities exist and a business scenario needs selected Policies, Rules, parameters, and posture." },
            { name: "Create a Deployment", description: "When a published Guardrail must protect an Integration's traffic." },
          ],
          links: [{ label: "Open Policy Studio", to: "/policy-library" }, { label: "Manage Guardrails", to: "/guardrails" }],
        },
        {
          id: "developer-policy-runtime",
          title: "Understand Policy Studio runtime configuration",
          summary: "Rail, Flow, execution mode, Actions, and parameters form the Policy runtime contract.",
          paragraphs: ["Custom Policies automatically use the Colang 2.x programmable runtime. Only registered, versioned Actions can be referenced; arbitrary Python upload is not supported."],
          terms: [
            { name: "Rail", description: "NeMo execution phase. Input runs before the model; Output runs before model output is delivered." },
            { name: "Flow name", description: "A named Flow declared in Colang. It must match source exactly and creates Rule ID flow/{rail}/{flow_name}." },
            { name: "detect mode", description: "Evaluates and records safety; any unsafe result still applies the configured action." },
            { name: "mutate mode", description: "The Flow may return effective replacement content such as redaction or rewrite." },
            { name: "Advanced runtime", description: "Parallel group identifies safely concurrent bindings; timeout bounds execution. Failure mode governs errors." },
            { name: "Action dependencies", description: "Registered provider names and exact versions invoked by the Flow." },
            { name: "Binding parameters", description: "Reviewed values exposed by a Policy and resolved when a Guardrail pins its version." },
          ],
          links: [{ label: "Open Policy Library", to: "/policy-library" }],
        },
        {
          id: "developer-actions",
          title: `The ${enforcementActionConflictOrder.length} post-evaluation directives`,
          summary: "An Enforcement Action is the intervention requested after a Policy decision; it is not a NeMo Action. Conflicts resolve to the highest-priority directive.",
          terms: enforcementActionTerms(enforcementActionDescriptions),
          note: `Priority: ${enforcementActionConflictOrder.join(" → ")}. TaskLattice is a decision service; callers must implement action/texts for lifecycle actions such as regenerate or fallback.`,
        },
        {
          id: "developer-release-transfer",
          title: "Test, publish, and transfer",
          summary: "Successful compilation is not enough; every Flow-backed Rule needs a required Test Case.",
          bullets: [
            "A Test Case declares Rail, content, expected Decision, and covered Rule IDs.",
            "Validate & run tests saves, compiles, and executes through real NeMo runtime.",
            "Editing source, Rails, Actions, parameters, or tests invalidates the prior run.",
            "Export packages carry editable definition, not another environment's validation or publication state.",
            "Published Policy Versions are immutable.",
          ],
          links: [{ label: "View Validation in a Guardrail", to: "/guardrails" }, { label: "Open Policy Library", to: "/policy-library" }],
        },
        {
          id: "developer-integration",
          title: "Execute decisions in an application or gateway",
          summary: "The caller owns model invocation; TaskLattice returns explicit decisions at input and output boundaries.",
          steps: [
            { title: "Input check", description: "Stop before the model on block; use returned content on transform." },
            { title: "Model call", description: "The application or gateway still owns requests, retries, streaming, and business sessions." },
            { title: "Output check", description: "Check model output and never leak original content when blocked." },
            { title: "Call correlation", description: "Use a stable call ID so input and output remain pinned to one version." },
          ],
          links: [{ label: "Manage Integrations", to: "/integrations" }, { label: "View Deployments", to: "/deployments" }],
        },
      ],
    },
    {
      id: "operator",
      label: "Operator",
      title: "Release, route, and operate NeMo Guardrails",
      summary: "For platform engineering, SRE, and security operations. Focus on trusted identity, version routing, runtime health, capacity, rollback, and evidence.",
      outcome: "Outcome: an observable, rollback-safe production path that cannot bypass the Guardrail.",
      articles: [
        {
          id: "operator-runtime",
          title: "Production runtime boundaries",
          summary: "The control plane manages versions, NeMo executes checks, and callers execute final decisions.",
          bullets: [
            "Publishing validates an immutable NeMoConfigSnapshot, computes checksum, and prewarms the exact runtime profile.",
            "Active versions stay resident; production requests do not build runtimes on the hot path.",
            "The compiler chooses profiles. Custom programmable Policies use Colang 2.",
            "Each Guardrail Version has independent concurrency admission and whole-request deadlines.",
            "Required timeouts and provider errors follow versioned fail-open/fail-closed behavior.",
          ],
        },
        {
          id: "operator-routing",
          title: "Integration, Deployment, and Traffic Scope",
          summary: "Authenticate traffic first, then match ordered routes. Do not use spoofable fields as a trust boundary.",
          steps: [
            { title: "Register Integration", description: "Create separate identity and credentials for each app, agent, gateway, or trust boundary." },
            { title: "Create Deployment", description: "Select a published version and Traffic Scope. Routes are first-match-wins." },
            { title: "Keep fallback", description: "All traffic stays last; unmatched traffic uses the system baseline." },
            { title: "Verify context", description: "Prefer Integration identity, verified JWT claims, or trusted-proxy rewritten headers." },
          ],
          links: [{ label: "Manage Integrations", to: "/integrations" }, { label: "Manage Deployments", to: "/deployments" }],
        },
        {
          id: "operator-release-rollback",
          title: "Safe release and rollback",
          summary: "Both publication and rollback validate and prewarm before switching pointers.",
          bullets: [
            "Confirm the current Validation Run, checksum, dependencies, and specialized models.",
            "Watch Runtime health for active Deployments, Integrations, and optional capabilities.",
            "Rollback prewarms a historical immutable snapshot, then switches Guardrail and Deployment pointers transactionally.",
            "In-flight calls remain on their original version; new calls use the selected version.",
            "Never patch historical artifacts; create a new version for semantic changes.",
          ],
          links: [{ label: "View Guardrails", to: "/guardrails" }, { label: "View Evidence", to: "/evidence" }],
        },
        {
          id: "operator-troubleshooting",
          title: "Troubleshooting order",
          summary: "Check routing and version first, then Rail, Action, provider, and capacity.",
          steps: [
            { title: "1. Identity and route", description: "Confirm Integration state, credentials, Deployment order, and trusted Traffic Scope fields." },
            { title: "2. Version", description: "Confirm the expected Guardrail Version and checksum." },
            { title: "3. Rail and Action", description: "Inspect Policy, Rule, Rail, Action, Decision, and latency in Evidence/trace." },
            { title: "4. Provider", description: "Check specialized evaluators, models, networking, and Secrets." },
            { title: "5. Capacity", description: "Separate queue saturation, deadlines, and provider latency from true policy failures." },
          ],
          links: [{ label: "View Evidence", to: "/evidence" }, { label: "View Integrations", to: "/integrations" }],
        },
      ],
    },
  ],
  glossary: [],
};

EN_CONTENT.glossary = ZH_CONTENT.glossary.map((entry) => {
  const translations: Record<string, Pick<GlossaryEntry, "definition" | "background">> = {
    policy: { definition: "A reusable protection capability containing executable Rules and Test Cases.", background: "Policies are independent of applications so multiple Guardrails can pin and reuse them." },
    rule: { definition: "The smallest product-level executable behavior with a stable ID and implementation mapping.", background: "The same Rule ID follows binding, runtime findings, and Validation results." },
    "test-case": { definition: "An input or output example, expected Decision, and the Rule IDs it validates.", background: "Required acceptance cases gate publication; scenarios cover business boundaries." },
    guardrail: { definition: "A publishable composition of versioned Policies, Rules, parameters, and runtime posture.", background: "Policies provide reusable behavior; Guardrails provide scenario lifecycle." },
    "policy-binding": { definition: "A Guardrail's pinned Policy Version plus enabled Rules, Rails, parameters, and action overrides.", background: "Bindings ensure runtime behavior is exactly what reviewers selected." },
    "policy-version": { definition: "An immutable published snapshot of Policy source and runtime contract.", background: "Later edits create new drafts and versions without silently changing existing Guardrails." },
    "guardrail-version": { definition: "The immutable release and rollback unit containing compiled artifacts, dependencies, and checksum.", background: "Deployments reference exact versions; rollback switches pointers instead of rewriting history." },
    rail: { definition: "A NeMo phase that runs safety logic before the model or before output delivery.", background: "Input can stop model invocation; Output can transform or block delivery." },
    flow: { definition: "A named Colang orchestration unit that coordinates events, Actions, and decisions.", background: "The Policy Studio Flow name must match source declaration exactly." },
    colang: { definition: "NVIDIA NeMo Guardrails' orchestration language.", background: "The compiler selects Colang 1 for supported simple plans; custom Policies use Colang 2 automatically." },
    action: { definition: "A versioned capability invoked by a NeMo Flow for detection, specialized evaluation, or transformation.", background: "It is distinct from the post-evaluation Enforcement Action; only registered Action Catalog versions are allowed." },
    "enforcement-action": { definition: "The specific response requested after a Policy decision, such as redaction, rejection, or regeneration.", background: "It is neither an evaluator verdict nor a Python Action invoked by NeMo; some lifecycle directives are applied by the integrating caller." },
    "action-reference": { definition: "A Policy reference to an Action name and exact version.", background: "Publication checks availability, Rail compatibility, and contracts for reproducibility." },
    parameter: { definition: "A reviewed Policy value resolved when a Guardrail pins its version.", background: "Parameters are versioned configuration and should not be overridden by untrusted runtime input." },
    "validation-run": { definition: "An immutable result from executing the current draft's Test Cases through the real runtime.", background: "All required cases for the current revision must pass before publication." },
    deployment: { definition: "A route from an Integration's matching Traffic Scope to a published Guardrail Version.", background: "Routes are first-match-wins; All traffic stays last." },
    integration: { definition: "An authenticated application, agent, or gateway instance.", background: "Separate trust boundaries use separate Integrations to isolate identity, credentials, and call context." },
    "traffic-scope": { definition: "An AND/OR route expression over trusted request facts.", background: "An empty scope means all Integration traffic; untrusted headers may be spoofed." },
    evidence: { definition: "Immutable records of versions, validation, deployment, and privacy-conscious runtime decisions.", background: "Evidence omits protected bodies while retaining Policy, Rule, version, Decision, and latency context." },
    "runtime-profile": { definition: "The compiler-selected NeMo engine and Colang execution shape.", background: "Profile is a compilation result, not an ordinary user setting." },
    checksum: { definition: "A content digest of immutable compiled configuration.", background: "It proves the running artifact exactly matches the published version." },
    "failure-mode": { definition: "The safety behavior when an Action times out or errors.", background: "Fail-open continues with evidence; fail-closed blocks. Required checks commonly use conservative behavior." },
    "output-delivery": { definition: "How model output is buffered before Output Rail checks finish.", background: "More buffering prevents leakage of later-blocked content but increases delivery latency." },
    decision: { definition: "TaskLattice's final conclusion for the current phase: allow, transform, or block.", background: "The caller must execute the Decision and action; it is not merely a displayed score." },
  };
  return { ...entry, ...(translations[entry.id] ?? {}) };
});
