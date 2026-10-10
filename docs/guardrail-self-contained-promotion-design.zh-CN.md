# Guardrail 自包含发布包与 UAT → 生产晋级设计

状态：已实现（2026-10-08；版本测试集与 pending / ready 发布模型 2026-10-09）。实现与本文的差异见文末“实现记录”。

本设计以“UAT 独立开发和验证，生产直接接收已经准备好的 Guardrail”为前提。它更新
guardrail-promotion-design.zh-CN.md 中尚未实施的 Guardrail 导入和签名方案；不改变
现有 Router 变更审批规则。每个 Guardrail 最多保留 10 个不可变版本，数量显示为 n/10，不自动清理。

**产品决策**

UAT 使用 Policy Library 创建和编辑 Guardrail，将完整执行内容冻结为不可变版本。
生产接收该版本（Policies 与测试集），不查询或安装 Policy Library，不重新生成执行计划，
不重新执行 TaskLattice 构建流程。导入的版本为待发布，在生产对同一份 Artifact 原样运行
它自带的测试集，通过后才能发布；测试报告各环境独立，不随包导出。

生产仍需要兼容的 Runner、运行时能力和必要的模型连接。这里的“自包含”覆盖
Guardrail 的业务规则、执行配置、提示词和静态素材；运行引擎、外部服务和凭据由
环境提供，要求必须随包声明。模型无关的版本不要求配置模型。

**官方产品参考与采用范围**

| 产品 | 官方行为 | 本设计采用的原则 |
| --- | --- | --- |
| Amazon Bedrock Guardrails | 从工作草稿创建版本快照，应用在生产调用具体版本 | 草稿和生产版本分离 |
| Apigee | 可导出某个 revision 的 ZIP 包，跨组织导入；导入和部署是分别执行的操作 | 素材进入版本库与改变流量分开 |
| Open Policy Agent | Bundle 包含策略、数据及可选 Wasm；支持配置可信公钥后验签加载 | 依赖随包冻结，接收端验证内容与来源 |

以上支持的是设计方向，不代表三种产品都具备相同的包格式或跨环境签名规则。
导入版本原样复测，不重新编译；Guardrail 本身仍有独立的可编辑草稿，修改后通过同一测试、发布流程生成新版本。

参考资料，查阅于 2026-10-08：

- [Bedrock：Deploy your guardrail](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-deploy.html)
- [Apigee：下载与上传配置包](https://docs.cloud.google.com/apigee/docs/api-platform/fundamentals/download-api-proxies)
- [Apigee：Import 和 Deploy 的区别](https://docs.cloud.google.com/apigee/docs/api-platform/fundamentals/configure-proxy-with-yaml-example?hl=en)
- [OPA：Bundles 与签名](https://www.openpolicyagent.org/docs/management-bundles)

**环境职责与完整流程**

~~~mermaid
flowchart LR
  L[UAT Policy Library] --> D[编辑 Guardrail Draft]
  D --> B[冻结并构建候选 Artifact]
  B --> T[UAT 测试此 Artifact]
  T --> V[发布 Immutable Version]
  V --> E[导出 Guardrail 发布包]
  E --> I[生产导入并自动检查]
  I --> S[生产不可变版本库]
  S --> LT[本环境测试并显式 Release]
  LT --> R[Router 选择固定版本并审批]
  R --> P[Runner 加载并承接流量]
~~~

UAT 的编辑、保存、测试、发布交互可以继续沿用现有流程。底层应确保测试通过的
执行内容就是发布和导出的执行内容；签名、包装、生成本地投递信息不构成再次构建。
Runner 启动时必需的运行时解析、初始化和预热仍会进行，不需要用户调试。

UAT 与生产的功能完全相同，不设部署级功能开关，也不按环境名称判断权限。两边唯一
的差别是发布包的身份配置：导出需要签名身份，导入需要受信任来源。“生产通过导入
上线”由 SOP 规定；在生产创建 Guardrail 在技术和产品上都可行，只是不符合 SOP。
导入与 UI 创建的是同一种 Guardrail，来源只用于追溯，不改变编辑、测试和发布能力。“创建 Guardrail”与
“创建 Policy”是同一种拆分按钮：点击按钮直接创建，右侧箭头展开菜单才看到导入
（“导入发布包”／“导入 Policy”），默认不展开。Policy Library 是一个列表，用“使用
情况”筛选区分是否被已发布的 Guardrail 版本使用。

**Guardrail 来源与工作草稿**

来源不构成另一种资源类型。相同角色、相同草稿与版本状态的 Guardrail 使用相同的
Actions、默认 Runtime 页签、测试用例编辑、Playground、测试、发布、复制、丢弃草稿和
导出入口。不可变版本的只读约束对所有来源一致，它不代表整个 Guardrail 只读。

首次导入从用户实际选择的最新版本复制配置与测试用例为工作草稿。后续增量导入仅追加
版本，不覆盖本地草稿、测试用例或报告。复制和丢弃草稿均可使用导入版本的源快照。
升级补齐已有导入版本的源快照，并为仍未编辑、未建立测试用例的旧导入对象补齐草稿。
草稿编辑、Playground 和测试按绑定的确切 Policy 版本解析，包含随包保存的旧目录版本。
新发布生成新的本地不可变版本，原导入版本内容和来源凭证保持不变。草稿测试状态只读取
草稿报告，版本复测不替代草稿测试。

**导出交互与多版本组织**

一个发布包只属于一个 Guardrail，可以包含一个或多个已发布版本。

- Guardrail Actions → Export：不预选任何版本，可多选，显示“已选择 1 / 3 个版本”。
- Immutable Version 的三点菜单 → Export this version：只导出当前版本。
- 常规 UAT → 生产晋级只需最新的一个版本；首次迁移或携带回退版本时可选择多个。
- 导出前检查每个选中版本的 Artifact、冻结依赖与证据。缺项须明确指出，不能静默
  跳过、用本地最新 Policy 补齐，或导出一个无法独立执行的包。
- 不导出未发布 Draft。历史版本缺少必要的冻结信息时，在 UAT 补齐验证并发布新版本。

例如先导入 V1、V2、V3，后续只导入 V4，生产同一个 Guardrail 下保留四个版本。
重新上传 V3 不生成重复版本。系统中没有 Latest 指针，包里也没有“推荐版本”：
Router Target 和运行时基线都固定确切版本，导入任何版本都不改变现有引用和流量。

**发布包契约：资源树（schemaVersion 3）**

发布包是一棵资源树：Guardrail 版本引用 Policy 版本。导出时整棵树一起带走，导入时
从叶子往上建（Policy 版本 → Guardrail → Guardrail 版本）。扩展名 .guardrail.zip，
format 为 tasklattice.guardrail-package，schemaVersion 为 3；不接受旧格式。

~~~text
manifest.json                                       树的索引（被签名）
signatures.json
policies/<policyId>/<policyVersion>/policy.json     叶子：Policy 版本
guardrails/<guardrailId>/guardrail.json             Guardrail 本身
guardrails/<guardrailId>/versions/<version>/
    version.json                                    版本配置
    test-suite.json                                 版本自带的测试集
    artifact.json                                   编译产物，Runner 原样执行
    requirements.json                               运行环境要求
~~~

| 文件 | 契约 |
| --- | --- |
| manifest | 来源身份；节点清单：`policies[] {id, version, kind, digest}`、`guardrail {id, name}`、`versions[] {version, contentDigest, testSuiteDigest, policies[] {id, version, digest}}`（后者即树的边）；每个文件的路径、sha256 和大小 |
| policy.json | `{id, version, kind, definition}`。`kind` 为 `catalog`（Policy 目录中的规则型 Policy，含内建与自定义目录包）或 `programmable`（Policy Studio 编写的 Colang Policy）。`definition` 是 Policy 版本的原生定义：`catalog` 为发布时从目录冻结的完整定义（规则、测试用例、标签、参数），取自按 Guardrail 绑定展开短语规则之前；`programmable` 为 Library 中不可变的版本快照（源码、Rail 绑定、完整测试用例与其 checksum）。`digest` = SHA-256(规范化 `definition`)，与被谁使用无关 |
| guardrail.json | `{id, name}`：不随版本变化的 Guardrail 属性 |
| version.json | `{name, runtimeProfile, draftConfig}`：发布该版本时的 Guardrail 配置 |
| test-suite / artifact / requirements | 与之前相同：冻结测试集、编译产物、由 Artifact 推导的环境要求 |
| signatures | Ed25519，覆盖 manifest 原始字节；manifest 覆盖每个文件的哈希 |

导出：选中的 Guardrail 版本所引用的每个 `Policy@版本` 都放进包，同一版本只放一次。
内建 Policy 也放进去，包是完整的树，不依赖接收端镜像恰好有同一版本。节点在测试候选
生成时与执行计划一起冻结并随版本保存，导出直接读取，不受之后 Library 或目录变化影响；
旧版本没有这些节点时不能导出，需重新发布。

导入时逐层校验，任一不符整包拒绝：
- 每条边指向包内的 Policy 节点且摘要一致；Artifact 实际绑定的 Policy 集合与边完全
  相同。
- Artifact 里嵌入的定义由 Policy 节点生成：`catalog` 定义除短语规则按绑定展开外完全
  相同；`programmable` 快照重新投影后与 Artifact 中的副本相等（忽略传输时省略的空字段），
  且快照 checksum 可重算。
- 内容摘要、测试集摘要、requirements 推导结果与 manifest 一致。

模型凭据、Provider 密钥、生产 Endpoint、Router 配置、分流权重和运行日志不随包迁移。
测试报告不随包迁移。

**生产导入交互**

入口是 Guardrails 列表页“创建 Guardrail”按钮右侧箭头菜单中的“导入发布包”，使用与系统一致的右侧抽屉。

1. 上传包，自动解析并检查签名、文件摘要、依赖完整性、版本冲突和环境兼容性。
2. 预览显示名称、来源、Policy 版本和 Guardrail 版本两层清单（每项为新增、已存在或冲突）、
   每个版本的测试集规模和环境检查结果。不出现 Policy 映射或编辑步骤。
3. 点击 Import 后在一个事务里从叶子往上写入：Policy 版本进入本环境的 Policy Library
   （只读，标明来源），再写 Guardrail 和它的版本。结果显示新增和已存在的数量。
4. 返回 Guardrail 详情及 Immutable versions。导入的版本为待发布：在版本上“运行测试”，
   通过后“发布”；不产生 Draft，不能编辑 Policy 或测试集。生产流量切换仍在 Router 内完成，
   Router 选择版本时待发布的版本置灰并说明原因。

正常路径只需上传、确认导入。来源信任和生产模型绑定由环境管理员预先配置一次。
进度展示实际阶段“读取文件 → 校验内容 → 检查环境 → 写入版本”；只有可计数的
文件或版本步骤显示完成数量，不生成模拟测试百分比。

签名/内容不合法或版本冲突属于导入失败，整批不产生部分可用版本。已验证的完整包
在运行环境暂不满足时可以保存为“已导入 · 环境未就绪”，不能标成可用或被 Router
选用；补齐环境配置后自动重新检查。缺少在线 Runner 时显示“兼容性待确认”。
检查失败给出具体缺项和对应设置入口，不引导用户在生产修改规则。

版本详情读取包内快照，显示来源与“本环境的发布”：状态、绑定的本环境测试报告和发布
时间。UAT 的测试报告不随包导出，也不在生产展示；生产的报告全部来自本环境的实际运行。
导入与本地创建的 Guardrail 均显示相同的“测试报告”页签，按时间倒序平铺本环境的全部报告，
不提供筛选或版本下拉框。统一的“运行测试”按钮打开目标清单：不可变版本逐行展示版本号、
用例数及运行按钮；两种来源均有当前草稿入口，沿用同一草稿检查流程。导入版本运行随包
携带的冻结测试集；可查看、重新运行本环境报告，不能编辑版本测试集。
测试过程显示进度并刷新结果；复测不自动发布版本，也不改变路由。

每个 Guardrail 最多保留 10 个不可变版本，详情标题与版本页签显示“当前数量/10”。
待发布与已发布版本均占一个名额。发布新版本和导入新版本在持有 Guardrail 行锁的事务内
检查容量，超过上限整批拒绝；导入预览也显示容量阻塞原因。重复导入已有内容不占新名额，
已有版本的测试、发布不受容量限制。删除一个未被引用的版本后才释放一个名额，不自动删除
历史版本。旧数据若已超过 10 个，保留原数据、禁止继续增加；自动基线发布遇到上限保留
当前基线，不影响 Controller 启动。

**身份、幂等与版本冲突**

- Guardrail 的逻辑 ID 和版本号随发布包保留，普通新资源首次导入不改写其逻辑身份。
  生产记录该资源的来源实例/发布者关系；公钥轮换不能改变来源实例身份。
- 后续导入仅向同一来源的同一 Guardrail 追加版本。同名不同 ID 不自动合并。
  同一个 ID 已归属不同来源或本地独立开发资源时，阻止自动接管。
- 同一来源、Guardrail ID、版本号、内容摘要相同：幂等成功；摘要不同：拒绝覆盖。
  幂等还须核对该版本冻结文件清单一致，不能仅凭执行内容摘要就替换展示快照、环境
  要求或原始报告。ZIP 压缩时间、包的导出时间不参与版本内容身份。
  内容相同但来源不同也不能绕过来源授权。
- Guardrail 身份为软删除，保留 ID、版本定义、Artifact、测试用例、来源凭证及审计记录；
  测试报告（含候选产物）、测试任务、运行日志、安全事件、Prompt 历史和路由调用记录
  永久删除。版本的本环境测试、发布和环境检查状态清空，回到 pending；审计记录清理数量。
  同源发布包再次
  导入时，预览标明“已删除”和“保留的历史版本”，提供“恢复并导入”；即使包内版本
  全部已存在也可恢复。确认前不恢复，API 必须显式传入 `restoreDeleted: true`，CLI
  使用 `--restore-deleted --confirm`。恢复与新增版本在同一事务中完成并记录审计；
  原有版本定义保留，所有版本都需要重新在本环境测试和发布，不恢复 Router 关联、流量
  或运行时基线。恢复时同样清理旧实现软删除留下的运行数据；共享 Policy 和其他 Guardrail
  的数据不受影响。保留运行数据重置时间，拒收删除期间及恢复之前的延迟遥测，已清理
  测试任务的延迟结果不重建报告。
  本地自建或归属其他来源的同 ID 资源仍不可接管，任何内容冲突都会阻止整次操作。
- Policy 版本与 Guardrail 版本用同一套规则：本环境没有就新增；`ID@版本` 已存在且摘要
  相同视为已存在；摘要不同即冲突，整批回滚。`catalog` 节点以本环境目录中同版本的冻结
  定义比较；目录里没有的版本作为该 Policy 的只读历史版本保存。
- 导入的自定义 Policy 定义仍归来源所有，在任何环境都只读；这不限制 Guardrail 草稿调整其绑定、规则和测试。修改 Policy 定义须
  回来源环境发布新版本。本环境自建的同 ID Policy 或其他来源的同 ID Policy 不被接管。
- 被任何 Guardrail 版本引用的 Policy 不能删除。Library 中的 Policy 是供人查看和追溯的
  副本，运行时仍只使用 Artifact，生产运行不依赖 Library。
- 导入成功与“已用于生产流量”是两个状态。Import API 不修改 Router、Endpoint、
  分流权重或当前运行基线，不自动生成或批准 Routing 变更单。

**完整性、UAT 证据与生产分发**

当前 Artifact 的校验内容包含 Guardrail ID、版本和 generation。不同环境的投递序号
不应改变发布内容身份。建议定义新的内容契约，将本地投递 generation 移到分发信封：

~~~text
不可变内容 = Guardrail ID + version + compiler/runtime contract
           + plan + config + Colang + prompts + action bindings + dependencies
contentDigest = SHA-256(规范化的不可变内容)

UAT 来源证明 → contentDigest、testSuiteDigest、签发身份
生产接收记录 → contentDigest、原来源证明、接收人和接收时间
生产分发信封 → contentDigest、本地 artifact ID、投递 generation、本地签名
~~~

生产 Controller 使用预置信任根验证 UAT 清单和证明，保存原始包及来源签名，再用生产
密钥签发本地接收/投递证明。Runner 继续只信任生产密钥，校验信封和内容摘要后加载。
不能将包内自带公钥直接当作可信公钥；整个流程可离线完成，不回连 UAT。

这里需要新的协议/摘要版本，不能原地改变旧 Artifact 的 checksum 算法。旧单版本
.artifact.json 导出继续可用；新包导入走独立契约。对于旧数据，必须明确验证现有签名
及转换边界，缺失新的证据时在 UAT 重新生成合格发布包，不能在生产伪造来源证明。

测试必须绑定实际执行的内容。UAT 保留测试实际加载的候选 Artifact，发布直接复用该
内容。测试报告属于“动态资源”，是某一次、某一环境的运行结果，不随包导出；随包导出
的是“静态资源”——版本自带的测试集。生产对导入的版本，用同一份 Artifact 原样运行它
自带的测试集，在本环境通过后才能发布（见下文版本状态）。

requirements 区分可替换的连接地址/凭据与影响语义的模型、版本、参数、动作和检测器。
生产按预设绑定自动检查；未满足已验证契约时阻止投入使用，不自动降级为另一模型。
跨环境的模型服务可能不同，生产测试结果与 UAT 不一致时测试即失败，由人工处理，平台
不做自动闭环。

**版本状态：待发布与已发布**

版本在每个环境只有两个持久化状态，版本号和内容永不改变：

~~~text
pending（待发布）──发布（必须绑定一份本环境通过的测试报告）──▶ ready（已发布）
~~~

- 本地发布的版本发布时已经测试通过，直接为 ready。
- 导入的版本为 pending。管理员在本环境运行它自带的测试集（对已签名的 Artifact 原样
  运行，不重新编译）；最近一次完成的测试通过、且测的正是这份 Artifact 和测试集时，
  才能发布。发布绑定这份报告，记录发布时间和发布人；已发布版本始终至少保留一份
  针对相同 Artifact 和冻结测试集的本环境 Passed 报告。
- 只有 ready 的版本能被 Router 引用、设为运行时基线或导出。发布本身不改变任何 Router
  或基线。
- 测试结果不是状态。发布后再测试失败不会撤销发布，只醒目地显示出来，由人通过 Router
  变更决定是否切走流量。界面按测试记录派生出“待发布 · 未测试 / 测试中 / 测试失败 /
  可发布”“已发布 / 已发布 · 复测失败”等显示状态。
- 管理员可从报告详情永久删除已完成的 Testing Report；运行中的任务须先完成。删除前
  展示影响，删除后保留审计事件。若还有内容摘要和测试集摘要都匹配的 Passed 报告，
  自动替换发布依据、保留 ready；否则版本回到 pending，清空本环境发布和加载检查状态，
  必须重新测试和发布。冻结的版本内容和测试集保持不变。
- 版本仍被 Router（含草稿、活动配置、待审批变更或回滚窗口）或运行时基线引用时，
  不允许删除最后一份发布依据；界面列出引用，解除引用并等待流量收敛后才能删除。
  删除事务重新校验影响；并发操作改变了待发布版本时，要求刷新确认后重试。
- 首页使用“就绪状态、不可变版本 n/10（已发布/待发布数量）、流量引用版本”三列，
  不以单个 Policy 数量或最新报告代表整个资源。Ready 至少需要一个已发布且仍保留匹配
  Passed 报告的版本；草稿测试与 Router 引用是独立维度。导入与 UI 创建共用上述规则。

其他信息与状态分开记录：来源（本地 / 导入）、本环境的 Runner 加载检查（pending /
compatible / missing）、是否为运行时基线、是否被已批准的 Router 引用。

导入本身不直接进入默认池。已发布且加载检查为 compatible 的导入版本进入默认池，供
Playground 和内部检查使用；其余版本只在被已批准的 Router 引用时分发（Router 门禁
同时要求已发布和近期的 compatible 检查）。
上线时的运行时初始化失败保持上一可用配置，并显示失败原因，不能因为一个未使用的新
导入包破坏已有 Runner。

Default Guardrail 是必须单独处理的系统资源：生产启动使用随产品交付、已签名且与
运行时匹配的固定基线包。不能在启动时从 Library 重建、自动测试或升级它。普通导入
不改变当前基线指针；需要晋级 UAT 的 Default 版本时，先作为版本入库，在本环境测试并
发布，再通过显式、可审计的基线变更切换。不能利用同名或保留 ID 的导入暗中替换全局保护。

对这个保留 ID，环境管理员可预先授权指定 UAT 来源提供候选版本；不允许普通包自动
取得系统资源所有权。该授权只允许版本入库，不授权替换当前运行基线，且仍执行
同版本冲突检查。基线指针固定一个确切版本，发布或导入新版本都不会移动它。

**源码支持与待改造范围**

| 位置 | 已核对的现状 | 实现要求 |
| --- | --- | --- |
| services/control-plane.ts:430；domain/guardrail-artifact-export.ts | 单版本导出读取冻结 Artifact，不读取实时 Library | 包装多版本并检查完整闭包；保留旧 API |
| services/control-plane.ts:837；runner/artifact_store.py:340 | 本地签名和 Runner 验签包含 generation，Runner 使用本地信任密钥 | 引入稳定内容摘要、来源证据和本地分发信封 |
| services/control-plane.ts:522、683、2422 | 新建/编辑/测试/发布依赖 Library 和本地验证记录 | 新增 importPublishedVersions 领域流程；不借道 createGuardrail/Publish，不伪造本地测试 |
| db/schema.ts:241 | Guardrail 必须带 draftConfig | 首次导入从所选最新版本建立工作 Draft 和测试用例；每个版本保留复制与丢弃草稿所需的源快照 |
| services/control-plane.ts:2236 | 启动从 Catalog 生成和验证 Default Guardrail | 生产使用冻结基线；不加载 Catalog |
| http/app.ts:187 | 创建 HTTP app 就加载 Catalog | 移到 authoring 能力的延迟初始化；生产启动不需要目录存在 |
| model-config/service.ts:986 | 模型覆盖检查读取 Catalog 与 policy_version | 生产从包的 requirements 判断可运行性 |
| src/routes/guardrails.tsx:132 | 详情查询全局 policies，计算草稿就绪性 | Guardrail 详情统一编辑和测试入口；不可变版本始终展示冻结快照 |
| services/control-plane.ts:1904 | 默认 Runner 池会收到全部 ready 版本 | 导入入库与运行时分发分离 |

数据层增加发布包/内容存储、导入来源、内容摘要、接收记录和环境检查结果。Policy
Library 表不作为导入依赖存储。多个版本可共享相同内容 blob；删除使用引用计数与
现有版本删除影响检查，不能按 Policy ID 删除共享素材，也不自动清理旧版本。

建议 API 分为导出指定版本集合、上传检查/预览、确认导入、读取导入进度四部分。
确认导入必须绑定已检查包的摘要，并在事务中重查冲突与权限；不信任前端传回的
检查结论。UI、CLI 和流水线调用同一个导入领域服务。

**实现顺序与验收**

1. 定义发布包、稳定摘要、来源证明及兼容性契约；调整 UAT 的冻结和证据绑定。
2. 实现独立导入事务、幂等追加、同一工作 Draft 生命周期及新版 Runner 分发验证。
3. 解除生产启动、模型检查、Default 基线和详情页面对 Library 的依赖。
4. 实现桌面端导入/多版本导出与统一 Guardrail 页面；联调 Router 引用与生效。

首期聚焦发布素材晋级。生产编辑包内 Policy、将依赖提升到 Library、自动版本清理、
跨来源合并、自动切换流量不属于首期范围。

关键验收场景：

- 两套隔离部署，生产 Policy Library 目录不存在、custom Policy 表为空；从冷启动到
  导入、只读查看、导出、Router 使用和实际 Endpoint 调用完整成功。
- 包含内置规则和自定义 Colang Policy 的版本均可加载；实现与静态数据都来自包。
  全流程断言无 Catalog/Policy 表读取，不产生编译或草稿测试任务；只有对版本 Artifact 的原样测试。
- Library 中加入相同 ID 但不同内容的 Policy 后，包内行为和内容摘要保持不变；导入
  不改变已有 Library 行、版本及内容。
- 多版本首次导入、后续增量导入、重复上传、并发导入、同版本不同内容冲突与整批
  回滚均有覆盖；已有生产 Router 不受导入影响。
- UAT 与生产的不可变内容摘要一致；跨环境 generation 不改变内容；拒绝伪造来源、
  缺失依赖和被篡改的报告或文件。
- 无模型版本直接可用；缺模型/动作/兼容 Runner 时明确未就绪，现有流量仍可用。
- 未通过加载检查的导入版本不预加载；导入不切换 Default 基线；批准 Routing 后检查真实 Runner 加载和
  Endpoint 行为。运行时初始化失败不替换上一可用配置。
- 导入的工作 Draft 可编辑、测试、发布；报告只展示本环境真实测试；桌面验证 Actions、草稿和版本抽屉一致。

以上验收场景已由两套隔离部署的端到端回归覆盖，见“实现记录”。

**实现记录**

| 主题 | 实现 | 与上文的差异 |
| --- | --- | --- |
| 内容摘要 | Artifact checksum 不再包含 `artifact_id` 与 `generation`；TS 与 Python 共用规范化 JSON（ASCII key 按码点排序，整数值浮点写成整数，小数只允许两种语言输出相同数字的范围），并有共享测试向量 | 原地改造，没有并行的新旧两套契约；旧 `.artifact.json` 单版本导出已删除。存量 Artifact 在启动时按新契约重新封存 |
| UAT 证据绑定 | 测试运行把实际编译、执行的候选 Artifact 回传并保存摘要；发布直接签名这份内容，不再重新编译 | 采用“测试候选 Artifact”方案；异步 CompileRequest/CompileResult 通道已移除 |
| 发布包 | 资源树（格式版本 3）：`policies/<id>/<version>/policy.json`、`guardrails/<id>/guardrail.json`、每个版本 `version / test-suite / artifact / requirements`；manifest 列出节点与边；确定性 ZIP，所有文件为规范化 JSON；Ed25519 签名覆盖 manifest 原始字节；导入从叶子往上建，Policy 进入 Library | 当前 Artifact 的静态素材全部内联，没有 `blobs/` 目录；未声明的条目一律拒绝；不兼容格式版本 2 |
| 环境检查 | 每个 Runner 池选一个已连接 Runner，按真实加载路径校验签名、NeMo 版本、Action、模型与 Evaluator 绑定并构建运行时后丢弃（dry-run 加载） | 没有在 Controller 端静态比对能力清单；`requirements.json` 只作为申报证据，导入时重新推导并要求完全一致 |
| Router 门禁 | 提交与批准变更单前对导入版本重新做加载检查，要求 10 分钟内的 compatible 结果 | 本地发布的版本不受此门禁约束 |
| 分发 | 默认池额外预加载本地发布的版本，以及加载检查为 compatible 的导入版本；其余导入版本只在被 Router 引用时分发。检查结论跨过 compatible 时推进 generation | 与设计一致 |
| 基线 | `controller_state.baseline_version` 固定一个确切版本；通过 `PUT /system/baseline` 或启动时基线包（必须只含一个版本）设置；全新安装时第一个发布的 Default 版本成为基线，之后的切换一律显式 | 产品随附基线包的构建流水线不在本期 |
| 版本测试集 | 测试运行冻结实际执行的用例（只含定义：输入、预期结果、预期覆盖、来源 Policy，不含编辑时间等动态字段），并按冻结内容计算测试集摘要；发布时测试集随 Artifact 写入版本，成为版本的静态内容。`GET /guardrails/{id}/versions/{version}/test-suite` 只读，版本详情新增“测试集”页签；之后修改 Guardrail 的用例不影响已发布版本 | 发布包携带测试集（`test-suite`），导入版本在本环境运行测试后发布 |
| 版本状态 | 只有 pending / ready：导入为 pending，`POST /guardrails/{id}/versions/{v}/test-runs` 对已签名 Artifact 原样运行版本自带的测试集，`POST .../release` 绑定最近一次通过且内容和测试集一致的报告后变为 ready（记录发布时间和发布人）。Router、基线、导出只接受 ready。compiling / failed 已删除 | 测试结果不作为状态；发布后复测失败不撤销发布 |
| 版本引用 | 删除 Latest 指针与“标记为 Latest”：Router Target 只能固定版本（草稿与快照相同），导出必须显式选择版本，发布包不再有推荐版本；草稿“未发布更改”只与上一次发布的版本比较；基线版本受删除保护 | 原设计保留 Latest 作为元数据，现彻底移除 |
| 环境一致 | 无功能开关：两边加载同一 Library、都会建立本地 Default，导入和导出只取决于身份配置（未配置时入口仍可见并说明原因）。Default 等保留系统资源在每个环境都存在，受授权的来源可以向本地 Default 添加导入版本，切换基线仍需显式操作 | 曾有 `CONTROLLER_AUTHORING_ENABLED` 开关，已移除 |
| Policy 库 | 一个列表：本环境的内建与自定义 Policy，以及随发布包导入的 Policy 版本（只读，标明来源）。不显示“被谁使用”或“是否承接流量”：这些属于 Guardrail；需要时从 Guardrail 版本的 Policies 页签链接到对应的 `Policy@版本` | `/released-policies` 聚合视图、使用情况筛选和承接流量状态已移除 |
| Playground | 可与任何已发布版本（包括通过加载检查的导入版本）对话，也可试用草稿 | 与设计一致 |
| 再导出 | 两种来源的已发布版本均可导出，均要求本环境通过的测试证据与完整静态内容，使用当前环境签名身份 | 接收端仍须配置信任该签名身份 |
| Runner 升级 | 版本与 Runner 不兼容时由加载检查和 Router 门禁阻止投入使用 | 新旧 Runner 池并行切换的升级流程未实现 |

端到端验证：`npm run helm:deploy:promotion` 在 OrbStack 上部署两个 Helm release（`tali-guard-uat`、`tali-guard-prod`，各自的 namespace、数据库、签名密钥、Controller、Runner；两边功能相同，信任源写在 `controller.promotion.trust.sources`），`npm run test:promotion` 运行 `scripts/regress_guardrail_promotion.mjs`，`scripts/regress_guardrail_promotion.mjs` 覆盖：UAT 测试并发布候选、导出、Library 变化后重新导出逐字节一致、生产冷启动、导入与真实 Runner 加载检查、幂等重复上传、跨环境摘要一致而签名不同、导入版本为待发布且测试前发布被拒、在生产原样运行版本测试集通过后发布并绑定报告、通过加载检查的导入版本在路由前进入默认池、第二位管理员批准变更单后承接真实流量、篡改/不可信签名/同版本不同内容/跨来源接管/保留 ID 均拒绝且不写入、缺失 Action 的版本可导入但测试失败、不能发布、也不能路由、导入不改变基线、Default 在生产测试并发布后显式切换基线。


## 2026-10-10 生命周期复核

以 [产品生命周期说明](document/zh-CN/overview/03-term-guardrail.mdx) 为用户侧完整说明。
本次核对发现并修正：资源首页把草稿 Policy 数量与跨版本最新报告并列；详情把通过的草稿也标为 Ready；文档仍把 Released / disabled 写作终态、把编译状态当版本状态、把修改草稿当作整个资源失去就绪。Ready 现由保留版本及本环境精确匹配的 Passed 依据推导，流量引用单独展示；状态转换表与图同步支持报告删除回退及确认重新导入恢复。删除最后一个已发布版本也同步资源生命周期。
