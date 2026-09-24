# Evaluation 客户报告模板评估与设计建议

日期：2026-09-24。状态：模板设计建议，不是产品实测报告，也不是已批准的发布门槛。

依据：[共享讨论](https://chatgpt.com/share/6ab4cbeb-7bd4-83ee-bcc3-6f6134a0154c)、[现有生成 Prompt](prompts/generate-guardrails-validation-report.md)、本地产品文档和评测入口，以及下文链接的公开一手资料。本次没有执行收费模型评测，也没有重新验证历史测试结果。

## 1. 建议结论

保留现有 Prompt 的安全、检测质量、业务可用性、性能、成本五个维度，以及公开基准、产品回归集、客户领域集的结构。将报告的主线改为：

**保护对象 → 具体损害 → 执行控制 → 最终可观察结果 → 客户验收门槛 → 可复现证据。**

建议报告名称为 **TaskLattice Guard — Protection Effectiveness & Operational Acceptance Report（保护效果与运行验收报告）**。

报告需要支持三个层次的陈述：

| 陈述 | 所需证据 | 可以得出的结论 |
| --- | --- | --- |
| 方法具有通用性 | 公认方法、固定指标口径、公开测试协议、领域扩展方式 | 同一方法可应用于多个场景 |
| 结果在已测范围内具有可迁移性 | 多模型、语言、行业、攻击族、集成方式的分层结果与未覆盖清单 | 在列明的配置与场景中观察到一致效果 |
| 某个客户可以接受 | 真实集成、客户盲测集、业务 SLO、预先冻结的门槛、剩余风险处置 | 指定版本适合明确限定的用途 |

有限测试不能证明所有行业、模型和攻击下的普适安全性。可信的产品声明应当是“使用可复用的评估方法，证明指定配置在已测范围内达到可接受水平”。

## 2. 现有 Prompt 应保留和修正的内容

| 项目 | 评估 | 建议 |
| --- | --- | --- |
| ASR、FPR、性能、成本并列 | 正确，避免单一 Accuracy | 保留，并增加业务任务成功率与最终暴露指标 |
| 公开基准 + 两层 Golden Set | 正确 | 补数据独立性、版本、语言、划分、近重复与污染说明 |
| Baseline vs Guarded | 正确 | 基线保留业务 system prompt、原有模型安全机制与相同应用链路，只移除待评估防护 |
| “TP = unsafe correctly blocked” | 对多动作产品过窄 | 分类检测、策略动作、最终结果分别评估；正确脱敏不是检测失败 |
| “FNR represents residual unsafe traffic” | 分母容易误导 | FNR 是已知不安全样本中的漏检比例，不是所有线上流量的残余风险比例 |
| Benign Pass = Utility | 不充分 | 放行不等于回答正确；增加正常业务任务成功率和相对基线变化 |
| p95 差值称作 Guard-only p95 | 不准确 | 区分两个端到端分布的 p95 差值、配对额外时延分布、直接测得的 Guard 服务时间 |
| Basic / Standard / Advanced / Strict | 可用于示意，不能冒充已有产品档位 | 正式报告用真实配置 ID、Policy 顺序、动作、阈值、模型与版本 |
| 默认“越多策略越安全、收益递减” | 预设了实验结论 | 正式结果允许非单调、负收益、无显著差异和没有可推荐配置 |
| CI、样本量可选 | 不适合正式验收 | 正式主指标必须带分子/分母、区间和有效样本数；不足时标记证据不足 |
| 单独一页 Garak | 可以调整 | 将一部分扫描细节移到附录，腾出完整页面证明脱敏、流式和故障边界 |
| 产品是自动串联的 AI 代理网关 | 与本地职责划分不完全一致 | 画出应用/网关执行决策、调用业务模型、控制最终交付的责任 |
| 编造示例结果 | 仅适合版式样稿 | `illustrative` 与 `measured` 明确分离；实测缺失必须留空，不能补一个“合理数字” |

现有 Prompt 可以继续作为版式样稿的基础，但应先增加第 12 节的约束，再生成客户验收报告。

## 3. 必须以本地产品的实际边界为中心

本地[快速开始](document/zh-CN/overview/01-quickstart-protection.mdx)和[集成契约](gateway-integration.md)明确：Guard 执行检查并返回 Decision；应用/网关负责业务模型调用和最终交付。因此端到端 SUT 必须包含实际使用的适配器。

```text
应用 / 网关
  ├─ Input 检查 → Guard Runner → 决策 / 替换文本
  ├─ 执行决策 → 用允许的文本调用业务模型
  ├─ Output / Stream 检查 → Guard Runner → 决策 / released_text
  └─ 执行决策 → 最终消费者

Guard Controller：配置、版本、发布、证据管理（与同步检查路径区分）
```

报告分别列出三种受测对象：单个 evaluator、已组合 Guardrail、应用端到端系统。不得把其中一个的成绩填到另一个的指标中。

| 被保护对象 | 损害事件 | 应观测的位置 | 主要证据 |
| --- | --- | --- | --- |
| 业务模型的输入与业务指令 | 未授权指令覆盖、禁止输入继续进入模型 | 业务模型实际收到的请求 | 输入阻断后业务模型调用数为 0；脱敏后上游仅收到替换内容 |
| 客户数据、内部信息、凭证 | 敏感内容到达未授权接收方 | 输入方向的模型请求；输出方向的最终客户端 | 消息级残余泄露率、实体级漏脱敏率、过度脱敏率 |
| 最终用户与品牌 | 有害或违反业务边界的内容被交付 | 客户端实际收到的完整内容及流式前缀 | 端到端 ASR、Policy violation、拒绝/重写的正确性 |
| 合法业务流程 | 误拦、答非所问、过度改写、超时导致任务失败 | 业务任务结果 | 任务成功率、FPR、非必要改写率、人工转接率（如适用） |
| 应用可用性 | 防护依赖故障、排队、超载、错误路由 | 网关、Runner、客户端 | Goodput、超时、故障安全行为、版本与路由一致性 |
| 下游工具和业务系统 | 未授权调用或执行 | 工具执行点 | 当前不能仅凭文本检查证明实际工具授权保护；需要独立执行控制与测试 |

明确范围限制：当前 Input/Output 是实际执行方向；Retrieval、Dialog、Execution 不能因协议预留就显示为已保护。Grounding 需要真实 query/source，Automated Reasoning 需要兼容服务和版本化形式规则。文本过滤不能代替工具授权、数据访问控制或交易审批。依据：[架构](architecture.md)、[产品化边界](protection-productization.md)。

流式必须显示 requested/effective mode、回退原因、集成版本。仅交付 `released_text`；实际取消上游由集成方负责。增量模式不能撤回已经交付的内容。完整缓冲模式必须把较长的首段等待呈现在报告中。

## 4. 如何证明方法具有业界通用性

采用一张“依据—用途—边界—实际证据”矩阵，避免只排列机构名称。

| 依据 | 在本模板中的用途 | 不能据此声称 |
| --- | --- | --- |
| [NVIDIA NeMo configuration evaluation](https://docs.nvidia.com/nemo/guardrails/evaluation/evaluate-configuration) | 逐 Policy 符合率、资源使用、延迟影响 | NeMo 认证了 TaskLattice；估算延迟等于生产实测延迟 |
| [NeMo evaluation methodology](https://docs.nvidia.com/nemo/guardrails/evaluation/evaluation-methodology) | 专家定义策略、交互集、Judge 与人工校验、基线与不同配置对比 | 某个统一百分比适用于所有客户 |
| [OWASP LLM Top 10 2025](https://genai.owasp.org/llm-top-10/) | 风险分类和覆盖映射，逐项说明全部/部分/不覆盖 | 跑过 jailbreak 就覆盖全部 OWASP 风险；文本检测解决 excessive agency |
| [NIST AI RMF Playbook](https://www.nist.gov/itl/ai-risk-management-framework/nist-ai-rmf-playbook) | 风险管理、测量、处置和责任的组织方式 | NIST 产品认证或特定指标门槛背书 |
| 独立公开基准 | 固定任务、数据、攻击与评分协议 | 自动获得生产代表性或训练数据独立性 |

推荐首版测试矩阵：

| 能力 | 公开参考 | 客户/产品补充 | 首要指标 |
| --- | --- | --- | --- |
| 内容安全 | [Aegis 2.0](https://huggingface.co/datasets/nvidia/Aegis-AI-Content-Safety-Dataset-2.0) | 客户风险定义、中英文及混合表达 | 分类 Recall/FPR，最终有害输出率 |
| 越狱与有害行为 | [JailbreakBench](https://github.com/JailbreakBench/jailbreakbench)、[HarmBench](https://github.com/centerforaisafety/HarmBench/blob/main/docs/evaluation_pipeline.md) | 多轮、编码、客户盲测攻击 | 固定预算下的端到端 ASR |
| 过度拒绝 | [XSTest](https://github.com/paul-rottger/xstest) | 正常投诉、反诈咨询、业务术语、带敏感词的合法任务 | 过度拒绝、合法任务成功率 |
| 话题控制 | [CantTalkAboutThis / NVIDIA 模型卡](https://huggingface.co/nvidia/llama-3.1-nemoguard-8b-topic-control) | strict/permissive、拒绝优先、多意图和完整会话 | 禁止任务漏放、允许任务误拒、会话越界率 |
| 动态攻击面 | [Garak](https://github.com/NVIDIA/garak) | 明确 probe/detector、预算、输入面、版本 | 各 probe 独立结果与回归 |
| PII/凭证保护 | 按实体与语言选择有标注的专门数据；首版没有合适公开集则明确缺口 | 合成敏感值、客户格式、span/实体标注、拆分流式 | 残余泄露、漏脱敏、过度脱敏 |
| 间接提示注入 | 前述通用越狱集不能自动替代 | 在实际被检查的文档/上下文入口注入受控指令 | 预先定义的攻击目标达成率 |
| 策略组合与集成 | TaskLattice 工程用例 | Rule 顺序、覆盖、变换、拒绝短路、故障、发布版本 | 执行契约符合率及最终消费者证据 |

扩展 Grounding/Reasoning 时，单独增加带证据来源和正确判定的套件，不复用内容安全得分。业务事实的正确性、来源支持程度和形式规则一致性分别定义。

公开数据与训练重叠必须逐模型登记。[NemoGuard-JailbreakDetect 模型卡](https://huggingface.co/nvidia/NemoGuard-JailbreakDetect)明确列出 AdvBench、WildJailbreak 和其他数据，以及 Garak 增强；相关结果宜标为回归/参考。不能反过来默认 JBB/HarmBench 对所有模型都“完全独立”。Topic 模型卡的不同段落对训练领域有不一致描述，应固定实际模型版本并澄清后再声称某领域未见过。

[Garak FAQ](https://raw.githubusercontent.com/NVIDIA/garak/main/FAQ.md)说明各 probe 分数没有统一归一尺度。报告可比较相同 probe/detector、预算和配置条件下的版本变化，不能计算一个“通用 Garak 安全总分”。

## 5. 推荐的 12 页正文

采用 12 页正文 + 可扩展技术附录。正文服务客户判断，附录服务复核。页数不足时增加附录，不通过缩小字号塞进证据。

| 页 | 页面主题 | 回答的问题 | 推荐视觉与必备内容 |
| --- | --- | --- | --- |
| 1 | 封面与报告身份 | 这是哪一份报告？ | 产品、客户/应用、日期、评测 ID、证据类型、版本范围；避免大面积装饰 |
| 2 | 验收摘要 | 能否用于我的场景？ | 保护目标、结论及限定条件；六个 KPI；门槛、差值、证据完整性 |
| 3 | 保护对象与 SUT | 保护什么，责任在哪里？ | 实际集成链路、信任边界、输入/输出面、明确不覆盖项 |
| 4 | 方法与数据可信度 | 为什么相信这些测试？ | 公开集/产品回归/客户盲测三层；样本量、污染、标注与 Judge 校验 |
| 5 | 风险与能力覆盖 | 哪些风险真正被测到？ | 风险→Policy/Rule→测试集→方向→样本数→状态；行业与语言切片 |
| 6 | 最终防护效果 | 比没有 Guard 改善多少？ | Baseline/Guarded ASR、绝对/相对变化与区间；最弱攻击族；残余失败 |
| 7 | 正常业务可用性 | 会不会妨碍正常工作？ | FPR、过度拒绝、任务成功率；误拦与错误改写的代表案例 |
| 8 | 执行、脱敏与流式 | 检测结果是否真正落实？ | 上游/最终客户端证据、PII 残余、分段泄露、阻断时间线、故障边界 |
| 9 | 延迟、容量与稳定性 | 在目标负载下够不够快？ | Guard 时间、客户端首段/完整回复 p50/p95/p99、Goodput、超时、负载曲线 |
| 10 | 配置选择与成本 | 哪个配置值得采用？ | 真实配置清单、质量/时延/成本散点、SLO 可接受区域、消融结果 |
| 11 | 客户门槛与发布结论 | 哪些条件已达标？ | 每目标门禁、历史回归、集成契约、证据不足项、限制和负责人 |
| 12 | 适用边界与证据索引 | 何时需重测，如何复核？ | 有效版本范围、剩余风险、补救、重测触发器、引用和附录索引 |

技术附录包含完整指标字典、每数据集/类别原始计数、Garak 明细、Judge 校验、配置与环境 manifest、案例索引、故障注入日志、原始统计与成本口径。

页面视觉：A4 竖版、白底正文、深蓝标题、少量蓝色强调；绿色只用于已满足且证据完整的门禁。每图标注 `n`、单位、版本、证据类型。优先区间图、负载曲线、失败明细和流式时间线；避免用雷达图把不同单位合成“产品力”。

## 6. 第二页摘要的具体模板

> **验收对象**：{客户应用 / 用途}；{Guardrail version}；{Router revision}；{effective release}；{集成版本}。<br />
> **范围**：{语言、模型、风险族、输入/输出、流式模式、负载区间}。<br />
> **结论**：{达标 / 未达标 / 证据不足 / 限定条件下达标}。<br />
> **结论依据**：{已满足目标、最大剩余风险、未覆盖项及允许用途}。

| 主 KPI | 观测值 | 比较 / 目标 | 证据 |
| --- | --- | --- | --- |
| 最终攻击成功率 ASR | {成功攻击数/可评分攻击数，%，CI} | Baseline {值}；目标 {上界} | {suite/run/case 索引} |
| 敏感信息残余泄露率 | {泄露消息数/有效含敏感信息消息数，%，CI} | 目标 {上界} | {输入/输出各自证据} |
| 正常业务任务成功率 | {成功数/计划正常任务数，%，CI} | 基线变化 {百分点}；目标 {下界} | {业务评分 rubric} |
| 合法请求误干预率 | {非必要阻断/改写数/有效正常请求数，%，CI} | 目标 {上界} | {动作与最终结果} |
| 客户端 p95 首段与完整响应 | {首段时延} / {完整时延} | 对应 SLO；相对基线 {差值} | {负载、模式、样本数} |
| SLO 内正常业务 Goodput | {成功且按时完成任务数/秒} | 目标 {值} | {负载曲线与错误率} |

页脚补充：成本/千次业务调用、完整性、异常数、最弱关键分组。PII 不在范围时可替换相应卡片，但必须显示不适用原因。没有数据则填“未测”，不显示 0、绿色或默认通过。

推荐结论文案：

> 在 {测试集及版本}、{应用配置} 和 {负载范围} 下，该配置相对于基线将 {风险结果} 从 {基线} 降至 {受保护结果}；正常业务任务成功率为 {值}，客户端 p95 时延为 {值}，成本为 {值}。按 {门槛版本} 判定为 {结论}。结论限于 {范围}；{剩余风险或缺口} 由 {控制/负责人} 处理。

版式演示如需数字，全部标为 **Illustrative Sample Results — Not a Certification**。例如 2,130/5,000 → 190/5,000 对应 ASR 42.6% → 3.8%，下降 38.8 个百分点、相对下降约 91.1%；这是纯算术示例，不是 TaskLattice 的测试结果，也不说明损失金额下降 91.1%。

## 7. 关键指标的严格口径

### 7.1 检测、动作与结果分开

检测层：在独立标注的有效样本中计算 TP/TN/FP/FN、Precision、Recall、FPR、FNR。输入与输出、各风险族分别列出。多标签数据注明 micro/macro 口径，不把一个样本多个标签当独立请求。

动作层：检查实际行为是否满足预期，包括 allow/block/transform/intervene、命中身份、完整替换结果、顺序与停止条件。正确 redact 不归为 FN；非必要 redact 计入业务误干预。

结果层：以模型实际收到的输入和客户端最终收到的输出判断保护目标是否达成。结果不能只从 detector verdict 或 HTTP 状态码推断。

### 7.2 有效性

- **ASR**：达成预先定义攻击目标的有效攻击数 / 可评分的有效攻击数；同时报告计划数、提交数、错误数、未知数和覆盖率。定义攻击单位为 request、完整 conversation 或 behavior，不能混用。
- 单次 ASR 与固定预算下的多次尝试成功率分别报告。固定攻击集用于版本比较；自适应红队另列攻击者信息、查询/时间/token 预算。多轮或同一行为的变体不是独立样本。
- Guarded 与 Baseline 使用相同任务、模型、提示、参数、预算和环境；顺序交错以降低服务波动。基线 ASR 为 0 时相对下降无定义。
- **Policy 符合率**：满足该策略全部适用断言的有效交互数 / 该策略适用且可评分的交互数。排除/不适用理由必须事先记录；不得看见失败后调整适用范围。
- **PII 消息级残余泄露率**：最终观察面仍暴露至少一个不应暴露实体的有效消息数 / 在对应方向确实包含应保护实体的有效消息数。另报实体级漏脱敏和正常实体误删比例。
- **会话越界率**：至少一次完成禁止任务的完整会话数 / 适用完整会话数。Topic Control 的“未命中允许话题”是否违规取决于 strict/permissive 及具体配置，不能一概视为攻击。

### 7.3 业务可用性

- **任务成功率**：按冻结业务 rubric 正确完成的正常任务数 / 计划执行的正常任务数；在此门禁口径中错误、超时、未完成不算成功，并单列原因。报告 Baseline 差值，防止放行但答错被当成功。
- **过度拒绝**：无须拒绝的任务中实际被拒绝的比例；区分 Guard 拒绝、业务模型本身拒绝和技术失败。
- Benign Pass 只描述通行情况。只有二元 allow/block、无变换且相同分母时，才能直接写 `Benign Pass = 1 − FPR`。
- 客户流量分布与均衡测试集分开。Precision 会随风险基率变化，不能把测试集 Precision 原样作为线上告警可信度。禁止把所有线上拦截都当 TP。

### 7.4 性能与成本

- 测三条时间线：Guard 检查服务时间；客户端第一段可见内容时间；客户端完整响应时间。必要时再分解排队、模型推理、网络、输入和输出检查。
- `p95(Guarded E2E) − p95(Baseline E2E)` 是分位数差值，不等于 `p95(逐请求额外时延)`，也不等于 Guard 服务时间 p95。
- 流式完整缓冲的第一段可见内容通常接近整段生成与检查完成时间；不能只用最后一次检查的几毫秒证明流式体验快。
- 性能按正常成功、阻断、变换、异常分别展示，再给真实业务权重的混合结果。大量快速拒绝不能“优化”正常用户时延。
- 在固定硬件/副本/区域、输入输出长度、并发/到达率、超时、预热、缓存和模型版本下比较；注明闭环或开环负载，记录排队并避免负载发生器漏算排队等待。报告持续稳态、突发和恢复。
- 原始 RPS 与 **Goodput** 分开。正文优先显示正确且在 SLO 内完成的正常业务任务/秒；若统计安全阻断的处理吞吐，另命名并注明分母。
- 成本按**每 1,000 次业务模型调用流程**归集 Input、多个 Output/stream checks、模型/token、重试和基础设施分摊；另可报告每千次 Guard API 请求。币种、价格日期、利用率假设和失败请求成本必须明确。缺少价格时成本为未测，不假定为 0。
- 运行防护成本与离线评估/Judge/红队成本分开；线上升级到大模型与离线 Judge 不得混称 escalation。

### 7.5 故障、未知和区间

技术错误的 fail-closed 可能防止交付，但不是检测 TP，应记录为“故障期间安全拒绝”，同时计入可用性损失。fail-open 必须展示未检查放行的暴露范围。

所有结果满足账目守恒：计划样本 = 已判定样本 + 错误/未知样本 + 未执行样本（类别互斥）。不能删除超时后只用剩余结果宣布通过。关键组存在未知时，给出最坏情况界限并判定是否仍有足够证据。

比例展示分子/分母及 95% 区间；验收使用哪种单侧界限须预先规定。零事件也不写“零风险”：独立同分布的 300 次测试中观察到 0 次事件，其单侧 95% 二项上界约为 0.994%（`1 − 0.05^(1/300)`）。如果 300 条来自少量攻击的改写，不能按 300 个独立样本使用该结论。

成对比较及同源变体按 behavior/conversation 做成组重采样；延迟使用重复批次及区间。关键风险、语言、客户任务必须分别达标，平均值不能掩盖失败分组。Judge 的模型、prompt、rubric、版本、随机抽检与争议复核都需保留，Judge 自评高分不构成独立证据。

## 8. “至少可接受”的验收设计

可接受区域是风险、业务、性能、成本和执行正确性的交集。建议采用下面的门禁表；数值由业务/安全/SRE 在评测前确认，下面不替客户批准任何门槛。

| 门禁 | 判定形式 | 责任人 |
| --- | --- | --- |
| 关键攻击与泄露 | 每个关键组的残余率单侧置信上界 ≤ 对应风险预算 | 安全 / 数据负责人 |
| 正常业务 | 任务成功率下界 ≥ 目标；相对基线退化在容忍范围内 | 应用 / 业务负责人 |
| 误干预 | 各关键正常业务组 FPR/误改写上界 ≤ 容忍值 | 业务 / 安全 |
| 时延与容量 | 目标负载区间内客户端 p95/p99、Goodput、错误率满足 SLO | SRE / 架构 |
| 运行成本 | 每千业务调用成本在预算内，价格与资源假设有效 | 应用 / 采购 |
| 必须成立的执行契约 | 必测集没有未经允许的内容交付、输入阻断后仍调用模型、版本漂移等违约 | 工程 / 安全 |
| 证据完整性 | 无未解释缺失，配置固定，关键样本量足够，Judge 可靠性已校验 | 评测负责人 |

产品稿可以另给一个**明确标为待协商示例**的门槛组（如 ASR 上界 5%、FPR 上界 2%、额外 p95 时延预算 300ms），但这既不是行业标准，也不适用于凭证泄露等所有风险。

判定采用两轴，避免把“没测到”当失败或通过：`measurement_status = complete / incomplete / not_run / not_applicable`；`acceptance_status = pass / fail / inconclusive / conditional`。这是报告层建议，不改写现有 Validation 生命周期。

“限定条件下达标”必须写明允许场景、附加控制、责任人及到期/复测条件。确定性的严重交付违约不能被整体平均分抵消。

## 9. 必须增加的脱敏、流式与故障页

用一次经过脱敏处理的代表案例，展示：输入→策略/Rule→原始上游输出→Guard 结果→最终消费者实际收到的内容。案例只解释机制，统计结论仍来自完整套件。

| 用例族 | 断言与证据 |
| --- | --- |
| 输入 reject / redact | reject 后业务模型调用为 0；redact 后模型侧无原始敏感值 |
| 输出 reject / transform | 最终用户收到拒绝或正确替换内容；不能把业务模型自己拒绝记为输出 Guard 功劳 |
| 跨 chunk、前/中/末段风险 | 不同切分位置、长输出、多字节文本；按客户端实际字节重建已暴露内容 |
| full_buffered | 判定完成前无内容前缀交付；报告首段等待代价 |
| incremental | 记录判定前已暴露文本、暴露事件率、检测时间、停止交付时间；不能回溯抹去已泄露前缀 |
| 超时、无效响应、模型故障 | 安全结果与故障结果分开；检查是否有未检查内容放行 |
| 重复/乱序/丢失响应、重启/切换 | 不重复交付、不推测放行；固定 release 或明确失败；报告可用性影响 |
| dry run | 可提供检测证据；不能据此认定已执行生产防护 |

## 10. 与现有工程的衔接

本次核对的是文件与代码能力，不是新的部署验收。历史文档中的通过数量不应直接抄作当前版本评测成绩。

| 现有基础 | 可复用部分 | 不能直接替代的证据 |
| --- | --- | --- |
| [Validation 协议](../proto/tasklattice/guard/control/v1/validation.proto)与[组合规则](guardrail-policies.md) | 预期/实际 Decision、完整变换、Rule 命中、失败分类、Trace、冻结 override | 大规模独立盲测、生产分布、最终应用成功 |
| [holdout 入口](../scripts/evaluate_model_holdout.py) | 版本/checksum/model evidence、分组 FP/FN、错误与缺失隔离 | 当前限定 allow/block 且要求模型调用证据；不能直接覆盖本地-only、transform、真实生成、流式和端到端 ASR |
| [runtime profile benchmark](../benchmarks/nemo_runtime_profiles.py) | HTTP 时延分位数、吞吐、Action/provider 时间、语义比较 | 比较的是 NeMo runtime profiles；不是已有 Basic/Advanced 产品档位，也不是完整业务 LLM 延迟、流式体验或成本评测 |
| [产品化验证记录](protection-productization.md) | 真实集成与故障用例设计、输出交付断言、历史失败分析 | 不能把录制/固定输出/Mock 故障验证当成语义质量泛化证据 |
| [架构中的签名与 effective release](architecture.md) | 受测配置身份和运行版本对齐 | 已签名的运行 artifact 不自动说明评估 PDF 已签名或获得第三方认证 |

适合逐步建立四层证据：

1. 能力连通与候选 Validation：能执行、满足已知契约。
2. 不可变 Guardrail release Evaluation：公开参考 + 独立质量集 + 性能。
3. 客户部署 Acceptance：真实 Adapter/Router/模型/流式模式 + 客户盲测 + 负载。
4. 运行期 Monitoring：漂移与复测触发；未经标注的生产拦截率不等于准确率。

报告主键建议采用独立 `evaluation_id`，关联源 Guardrail version、Policy/Rule/order/参数、artifact checksum、model revision、Router revision、effective release、Adapter 版本、dataset/judge/tool 版本和环境。每个实际生效的路由分支分别评测；加权总分只作摘要。

## 11. 机器数据与报告的最小契约（建议新增）

以下是未来报告数据结构，不表示仓库已经实现了该 schema。

| 数据块 | 最低字段 |
| --- | --- |
| report | evaluation_id、schema/template version、illustrative/measured、生成时间、执行者/复核者 |
| scope | 保护对象、任务/损害定义、语言、方向、输入面、未覆盖项 |
| sut | 源 commit、实际工作区/构建身份、镜像摘要、配置清单、版本/checksum、模型与适配器、路由与 effective release |
| protocol | 基线、随机性、攻击预算、样本选择、划分、去重、污染、负载、超时/重试、Judge rubric |
| case_results | case/behavior/conversation ID、来源/分组、预期检测/动作/结果、实际结果、故障、证据引用 |
| metrics | 指标 ID、层级/方向/分组、单位、分子/分母、CI 方法、unknown、baseline、变化 |
| gates | gate version、目标、门槛、责任人、measurement/acceptance status、理由、限制 |
| evidence | 配置/数据/原始结果 digest、Trace、客户端捕获、人工复核、性能样本、成本清单 |

保证 PDF、控制台和 CI 的数字由同一汇总结果生成。报告生成器只排版和解释，不自行选择样本、修改门槛、编造缺失指标或优化结论。重新评分产生新 evaluation，不覆盖旧证据。

客户正文使用脱敏案例；完整敏感证据受访问控制并有保留期限。报告文件哈希/签名用于追溯，签署身份与审批流程另行说明。

## 12. 建议追加到生成 Prompt 的约束

```text
Use docs/evaluation-report-template-design.zh-CN.md as the proposed evaluation
and report specification. Reconcile conflicts before generating the report.

1. Identify protected assets, harm events, the actual SUT, and integration
   responsibilities before presenting metrics. Distinguish component,
   composed Guardrail, and application end-to-end results.
2. Separate illustrative and measured evidence. Missing measured data must be
   shown as not measured or inconclusive. Never fill gaps with plausible data.
3. Use actual configuration identities. Do not assume that Basic/Standard/
   Advanced/Strict are existing product tiers, or prescribe a monotonic result.
4. Freeze datasets, splits, contamination notes, judges, thresholds, baselines,
   attack budgets, and environment. Report critical slices and unknowns.
5. Distinguish detection, enforcement-action correctness, and final consumer
   outcomes. Errors and fail-closed rejection are not detection true positives.
6. Include PII residual leakage, redaction correctness, business task success,
   and real Input/Output/stream integration evidence where applicable.
7. Include client-visible first-content and completion latency, direct Guard
   timing, SLO-constrained goodput, failures, and cost per business invocation.
   Do not equate differences of p95 values with p95 per-request overhead.
8. Show counts, uncertainty, evidence completeness, predefined acceptance
   criteria, residual risks, and evidence references beside key conclusions.
9. Use industry methodologies as traceable references, not certifications.
   Public datasets do not automatically establish independence or universality.
10. Use a 12-page customer narrative with an expandable evidence appendix.
    Include the enforcement/streaming page described in the specification.
11. Preserve the original prompt's PDF render-and-inspect requirements when
    generating a PDF. Keep metrics and layout separate for reproducibility.
```

优先顺序：先确认保护对象与损害定义，再冻结指标/门槛/数据协议；随后扩展现有 harness，产出统一证据；最后生成 PDF。当前最缺的不是再增加一个总分，而是把已经有的执行证据与独立质量、最终交付、性能和客户验收连成同一份报告。
