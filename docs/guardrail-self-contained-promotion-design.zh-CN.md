# Guardrail 自包含发布包与 UAT → 生产晋级设计

状态：已实现（2026-10-08）。实现与本文的差异见文末“实现记录”。

本设计以“UAT 独立开发和验证，生产直接接收已经准备好的 Guardrail”为前提。它更新
guardrail-promotion-design.zh-CN.md 中尚未实施的 Guardrail 导入和签名方案；不改变
现有 Router 变更审批规则。版本只显示实际数量，本期不引入数量上限或自动清理。

**产品决策**

UAT 使用 Policy Library 创建和编辑 Guardrail，将完整执行内容冻结为不可变版本。
生产接收该版本及其来源证据，不查询或安装 Policy Library，不重新生成执行计划，
不重新运行草稿测试，不重新执行 TaskLattice 构建流程。

生产仍需要兼容的 Runner、运行时能力和必要的模型连接。这里的“自包含”覆盖
Guardrail 的业务规则、执行配置、提示词和静态素材；运行引擎、外部服务和凭据由
环境提供，要求必须随包声明。模型无关的版本不要求配置模型。

**官方产品参考与采用范围**

| 产品 | 官方行为 | 本设计采用的原则 |
| --- | --- | --- |
| Amazon Bedrock Guardrails | 从工作草稿创建版本快照，应用在生产调用具体版本 | 草稿和生产版本分离 |
| Apigee | 可导出某个 revision 的 ZIP 包，跨组织导入；导入和部署是分别执行的操作 | 素材进入版本库与改变流量分开 |
| Open Policy Agent | Bundle 包含策略、数据及可选 Wasm；支持配置可信公钥后验签加载 | 依赖随包冻结，接收端验证内容与来源 |

以上支持的是设计方向，不代表三种产品都具备相同的包格式、跨环境签名或免测试规则。
生产无需重复调试是本项目根据 UAT/生产职责划分作出的产品决策。

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
  S --> R[Router 选择固定版本并审批]
  R --> P[Runner 加载并承接流量]
~~~

UAT 的编辑、保存、测试、发布交互可以继续沿用现有流程。底层应确保测试通过的
执行内容就是发布和导出的执行内容；签名、包装、生成本地投递信息不构成再次构建。
Runner 启动时必需的运行时解析、初始化和预热仍会进行，不需要用户调试。

建议增加部署级 authoringEnabled 能力开关，默认保持现有安装行为。UAT 开启；生产
可关闭。关闭时后端同时禁用编辑、测试草稿、编译发布和 Policy Studio 写接口，UI
隐藏相应入口。不能只通过隐藏按钮实现生产只读，也不应根据环境名称字符串判断权限。
生产保留导入、版本检查、报告查看、导出、监控、Routing 和受权限约束的版本删除。
关闭的是写操作，不是功能区域：导航和页面结构与 UAT 一致。Policy Library 用同一套
卡片、筛选和详情抽屉展示已发布版本中冻结的 Policy，只去掉新建、导入、编辑、删除；
Playground 可以与已发布版本对话，只去掉草稿目标；模型能力绑定（Guardrail Catalog）
照常配置，因为生产需要为导入的版本绑定自己的模型。

**导出交互与多版本组织**

一个发布包只属于一个 Guardrail，可以包含一个或多个已发布版本。

- Guardrail Actions → Export：默认选中 Latest，可多选，显示“已选择 1 / 3 个版本”。
- Immutable Version 的三点菜单 → Export this version：只导出当前版本。
- 常规 UAT → 生产晋级只需最新的一个版本；首次迁移或携带回退版本时可选择多个。
- 导出前检查每个选中版本的 Artifact、冻结依赖与证据。缺项须明确指出，不能静默
  跳过、用本地最新 Policy 补齐，或导出一个无法独立执行的包。
- 不导出未发布 Draft。历史版本缺少必要的冻结信息时，在 UAT 补齐验证并发布新版本。

例如先导入 V1、V2、V3，后续只导入 V4，生产同一个 Guardrail 下保留四个版本。
重新上传 V3 不生成重复版本。导入历史版本不移动已经设置的 Latest 指针，也不改变
已冻结的 Router 引用。首次导入没有 Latest 时采用包内明确标记且已导入的推荐版本；
后续设置 Latest 是显式元数据操作，不能改变现有流量。

**发布包契约**

建议扩展名为 .guardrail.zip，format 为 tasklattice.guardrail-package，schemaVersion
为 1。这是新的发布包格式版本，与现有 Protobuf Artifact 的协议版本分别管理。

~~~text
manifest.json
versions/<version>/artifact.json
versions/<version>/inspection.json
versions/<version>/requirements.json
versions/<version>/uat-evidence.json
blobs/<sha256>
signatures.json
~~~

| 内容 | 契约 |
| --- | --- |
| manifest | 源实例身份、Guardrail ID/名称、版本列表、推荐版本、每个文件的哈希、每个版本的内容摘要、包格式版本 |
| artifact | 完整的已构建执行计划、NeMo 配置、Colang、Prompts、动作绑定、冻结参数与依赖；接收端直接加载 |
| inspection | 与该版本一起冻结的 Policy/Rule 名称、定义、顺序、动作及只读展示信息；不得读取接收端 Library 补充 |
| requirements | Runner/NeMo/执行协议兼容要求、动作和检测器能力版本、外部模型及服务契约、环境绑定槽位 |
| uat-evidence | 精确对应此内容摘要的测试结论、报告摘要、用例集摘要、来源环境、运行时/模型指纹与时间；由可信来源签名覆盖 |
| blobs | 被版本引用的静态词表、模板等资源；跨版本相同内容可按哈希去重，逻辑归属仍属于该版本 |
| signatures | 清单及文件集合的签名、算法和 key ID；接收端用预先登记的来源公钥验证 |

每个 Policy/Rule 依赖必须能在包内闭合，或者明确属于 requirements 中的平台执行
能力与外部服务。仅记录一个 Policy ID、版本号或 Library URL 不算自包含；禁止在生产
自动下载 Policy 或静默改用同名实现。包内索引和文件集合须一致，拒绝缺失、摘要
不匹配、重复路径、路径穿越、超限解压和未声明的执行内容。

模型凭据、Provider 密钥、生产 Endpoint、Router 配置、生产分流权重和运行日志不随包
迁移。完整测试输入/输出及用于后续开发的完整源快照可以作为有签名覆盖的可选附件，
不作为生产运行和导入成功的依赖。必需的摘要与执行素材不能被“精简导出”选项移除。

**生产导入交互**

入口放在 Guardrails 列表页的 Import，使用与系统一致的右侧抽屉。

1. 上传包，自动解析并检查签名、文件摘要、依赖完整性、版本冲突和环境兼容性。
2. 预览显示名称、来源、版本列表、UAT 结论、本次新增/已存在的版本和环境检查结果。
   不出现 Policy 映射、导入 Policy Library、编辑测试用例或重新发布步骤。
3. 点击 Import 后事务性追加所选版本，结果显示“已导入 2 个版本，1 个版本已存在”。
4. 返回 Guardrail 详情及 Immutable versions。直接进入版本查看；不产生 Draft，不显示
   Test draft，也不要求再点 Publish。生产流量切换仍在 Router 内完成。

正常路径只需上传、确认导入。来源信任和生产模型绑定由环境管理员预先配置一次。
进度展示实际阶段“读取文件 → 校验内容 → 检查环境 → 写入版本”；只有可计数的
文件或版本步骤显示完成数量，不生成模拟测试百分比。

签名/内容不合法或版本冲突属于导入失败，整批不产生部分可用版本。已验证的完整包
在运行环境暂不满足时可以保存为“已导入 · 环境未就绪”，不能标成可用或被 Router
选用；补齐环境配置后自动重新检查。缺少在线 Runner 时显示“兼容性待确认”。
检查失败给出具体缺项和对应设置入口，不引导用户在生产修改规则。

版本详情读取包内快照。Testing Report 展示“UAT · Passed”、原测试时间与源版本；
不伪造生产 validation_run，不将来源报告表述为生产实测。

**身份、幂等与版本冲突**

- Guardrail 的逻辑 ID 和版本号随发布包保留，普通新资源首次导入不改写其逻辑身份。
  生产记录该资源的来源实例/发布者关系；公钥轮换不能改变来源实例身份。
- 后续导入仅向同一来源的同一 Guardrail 追加版本。同名不同 ID 不自动合并。
  同一个 ID 已归属不同来源或本地独立开发资源时，阻止自动接管。
- 同一来源、Guardrail ID、版本号、内容摘要相同：幂等成功；摘要不同：拒绝覆盖。
  幂等还须核对该版本冻结文件清单一致，不能仅凭执行内容摘要就替换展示快照、环境
  要求或原始报告。ZIP 压缩时间、包的导出时间不参与版本内容身份。
  内容相同但来源不同也不能绕过来源授权。
- Policy ID 和版本号只在包内解释；生产 Library 中同名、同 ID、不同内容的 Policy
  既不覆盖包内实现，也不会被导入包修改。
- 导入成功与“已用于生产流量”是两个状态。Import API 不修改 Router、Endpoint、
  分流权重或当前运行基线，不自动生成或批准 Routing 变更单。

**完整性、UAT 证据与生产分发**

当前 Artifact 的校验内容包含 Guardrail ID、版本和 generation。不同环境的投递序号
不应改变发布内容身份。建议定义新的内容契约，将本地投递 generation 移到分发信封：

~~~text
不可变内容 = Guardrail ID + version + compiler/runtime contract
           + plan + config + Colang + prompts + action bindings + dependencies
contentDigest = SHA-256(规范化的不可变内容)

UAT 来源证明 → contentDigest、UAT evidence digest、签发身份
生产接收记录 → contentDigest、原来源证明、接收人和接收时间
生产分发信封 → contentDigest、本地 artifact ID、投递 generation、本地签名
~~~

生产 Controller 使用预置信任根验证 UAT 清单和证明，保存原始包及来源签名，再用生产
密钥签发本地接收/投递证明。Runner 继续只信任生产密钥，校验信封和内容摘要后加载。
不能将包内自带公钥直接当作可信公钥；整个流程可离线完成，不回连 UAT。

这里需要新的协议/摘要版本，不能原地改变旧 Artifact 的 checksum 算法。旧单版本
.artifact.json 导出继续可用；新包导入走独立契约。对于旧数据，必须明确验证现有签名
及转换边界，缺失新的证据时在 UAT 重新生成合格发布包，不能在生产伪造来源证明。

UAT 测试证据必须绑定实际执行内容和环境指纹。当前代码比较验证时与发布时的 plan，
还不足以声称测试覆盖了完全相同的最终 Artifact。实现应保留测试实际加载的候选
Artifact，发布复用该内容；或者在 UAT 对最终 Artifact 验证后签发匹配的证明。
不增加生产测试步骤。

requirements 区分可替换的连接地址/凭据与影响语义的模型、版本、参数、动作和检测器。
生产按预设绑定自动检查；未满足已验证契约时阻止投入使用，不自动降级为另一模型。
UAT 证据始终注明来源环境，不承诺跨环境模型服务具有完全相同的实际行为。

**入库、环境就绪与生效分别记录**

| 状态维度 | 示例 | 含义 |
| --- | --- | --- |
| 导入结果 | Checking / Imported / Failed | 包是否被合法接收 |
| 环境检查 | Pending / Compatible / Missing dependencies | 本环境是否满足这个版本的运行要求 |
| 分发与使用 | Not assigned / Loading / In use / Load failed | 是否已经被批准的 Router 或显式运行基线引用 |

生产导入本身不直接进入默认池。导入后自动做一次 Runner 加载检查（dry-run），只有
结果为 compatible 的导入版本才进入默认池，供 Playground 和内部检查使用；未检查或
检查未通过的版本只在被已批准的 Router 引用时分发（Router 门禁本身也要求 compatible）。
上线时的运行时初始化失败保持上一可用配置，并显示失败原因，不能因为一个未使用的新
导入包破坏已有 Runner。

Default Guardrail 是必须单独处理的系统资源：生产启动使用随产品交付、已签名且与
运行时匹配的固定基线包。不能在启动时从 Library 重建、自动测试或升级它。普通导入
不改变当前基线指针；需要晋级 UAT 的 Default 版本时，先作为版本入库，再通过显式、
可审计的基线变更切换。不能利用同名或保留 ID 的导入暗中替换全局保护。

对这个保留 ID，环境管理员可预先授权指定 UAT 来源提供候选版本；不允许普通包自动
取得系统资源所有权。该授权只允许版本入库，不授权替换当前运行基线，且仍执行
同版本冲突检查。基线指针与可浏览版本的 Latest 元数据必须分离。

**源码支持与待改造范围**

| 位置 | 已核对的现状 | 实现要求 |
| --- | --- | --- |
| services/control-plane.ts:430；domain/guardrail-artifact-export.ts | 单版本导出读取冻结 Artifact，不读取实时 Library | 包装多版本并检查完整闭包；保留旧 API |
| services/control-plane.ts:837；runner/artifact_store.py:340 | 本地签名和 Runner 验签包含 generation，Runner 使用本地信任密钥 | 引入稳定内容摘要、来源证据和本地分发信封 |
| services/control-plane.ts:522、683、2422 | 新建/编辑/测试/发布依赖 Library 和本地验证记录 | 新增 importPublishedVersions 领域流程；不借道 createGuardrail/Publish，不伪造本地测试 |
| db/schema.ts:241 | Guardrail 必须带 draftConfig | 支持没有工作草稿的已发布 Guardrail；明确区分工作 Draft 与只读源快照 |
| services/control-plane.ts:2236 | 启动从 Catalog 生成和验证 Default Guardrail | 生产使用冻结基线；不加载 Catalog |
| http/app.ts:187 | 创建 HTTP app 就加载 Catalog | 移到 authoring 能力的延迟初始化；生产启动不需要目录存在 |
| model-config/service.ts:986 | 模型覆盖检查读取 Catalog 与 policy_version | 生产从包的 requirements 判断可运行性 |
| src/routes/guardrails.tsx:132 | 详情查询全局 policies，计算草稿就绪性 | 生产详情和版本查看只读冻结快照，不调用 Library |
| services/control-plane.ts:1904 | 默认 Runner 池会收到全部 ready 版本 | 导入入库与运行时分发分离 |

数据层增加发布包/内容存储、导入来源、内容摘要、接收记录和环境检查结果。Policy
Library 表不作为导入依赖存储。多个版本可共享相同内容 blob；删除使用引用计数与
现有版本删除影响检查，不能按 Policy ID 删除共享素材，也不自动清理旧版本。

建议 API 分为导出指定版本集合、上传检查/预览、确认导入、读取导入进度四部分。
确认导入必须绑定已检查包的摘要，并在事务中重查冲突与权限；不信任前端传回的
检查结论。UI、CLI 和流水线调用同一个导入领域服务。

**实现顺序与验收**

1. 定义发布包、稳定摘要、来源证明及兼容性契约；调整 UAT 的冻结和证据绑定。
2. 实现独立导入事务、幂等追加、无 Draft 资源及新版 Runner 分发验证。
3. 解除生产启动、模型检查、Default 基线和详情页面对 Library 的依赖。
4. 实现桌面端导入/多版本导出与只读生产页面；联调 Router 引用与生效。

首期聚焦发布素材晋级。生产编辑包内 Policy、将依赖提升到 Library、自动版本清理、
跨来源合并、自动切换流量不属于首期范围。

关键验收场景：

- 两套隔离部署，生产 Policy Library 目录不存在、custom Policy 表为空；从冷启动到
  导入、只读查看、导出、Router 使用和实际 Endpoint 调用完整成功。
- 包含内置规则和自定义 Colang Policy 的版本均可加载；实现与静态数据都来自包。
  全流程断言无 Catalog/Policy 表读取，不产生编译或草稿测试任务。
- Library 中加入相同 ID 但不同内容的 Policy 后，包内行为和内容摘要保持不变；导入
  不改变已有 Library 行、版本及内容。
- 多版本首次导入、后续增量导入、重复上传、并发导入、同版本不同内容冲突与整批
  回滚均有覆盖；已有生产 Router 不受导入影响。
- UAT 与生产的不可变内容摘要一致；跨环境 generation 不改变内容；拒绝伪造来源、
  缺失依赖和被篡改的报告或文件。
- 无模型版本直接可用；缺模型/动作/兼容 Runner 时明确未就绪，现有流量仍可用。
- 未通过加载检查的导入版本不预加载；导入不切换 Default 基线；批准 Routing 后检查真实 Runner 加载和
  Endpoint 行为。运行时初始化失败不替换上一可用配置。
- 生产不显示虚构 Draft/Test draft；报告标记 UAT 来源；桌面验证导入和版本抽屉。

以上验收场景已由两套隔离部署的端到端回归覆盖，见“实现记录”。

**实现记录**

| 主题 | 实现 | 与上文的差异 |
| --- | --- | --- |
| 内容摘要 | Artifact checksum 不再包含 `artifact_id` 与 `generation`；TS 与 Python 共用规范化 JSON（ASCII key 按码点排序，整数值浮点写成整数，小数只允许两种语言输出相同数字的范围），并有共享测试向量 | 原地改造，没有并行的新旧两套契约；旧 `.artifact.json` 单版本导出已删除。存量 Artifact 在启动时按新契约重新封存 |
| UAT 证据绑定 | 测试运行把实际编译、执行的候选 Artifact 回传并保存摘要；发布直接签名这份内容，不再重新编译 | 采用“测试候选 Artifact”方案；异步 CompileRequest/CompileResult 通道已移除 |
| 发布包 | `manifest.json`、`signatures.json`、每个版本 `artifact / inspection / requirements / uat-evidence`；确定性 ZIP，所有文件为规范化 JSON；Ed25519 签名覆盖 manifest 原始字节 | 当前 Artifact 的静态素材全部内联，没有 `blobs/` 目录；未声明的条目一律拒绝 |
| 环境检查 | 每个 Runner 池选一个已连接 Runner，按真实加载路径校验签名、NeMo 版本、Action、模型与 Evaluator 绑定并构建运行时后丢弃（dry-run 加载） | 没有在 Controller 端静态比对能力清单；`requirements.json` 只作为申报证据，导入时重新推导并要求完全一致 |
| Router 门禁 | 提交与批准变更单前对导入版本重新做加载检查，要求 10 分钟内的 compatible 结果 | 本地发布的版本不受此门禁约束 |
| 分发 | 默认池额外预加载本地发布的版本，以及加载检查为 compatible 的导入版本；其余导入版本只在被 Router 引用时分发。检查结论跨过 compatible 时推进 generation | 与设计一致 |
| 基线 | `controller_state.baseline_version` 显式指针；生产通过 `PUT /system/baseline` 或启动时基线包设置；UAT 未设置时跟随 Default 的 Latest | 产品随附基线包的构建流水线不在本期 |
| 生产只读 | `CONTROLLER_AUTHORING_ENABLED=false`：路由按 core/authoring 分类，未分类路由默认拒绝；不加载 Catalog；模型覆盖改由已发布版本的 Evaluator 契约推导 | 与设计一致 |
| 生产 Policy 库 | 关闭 authoring 时 Policy 库只读，布局与 UAT 相同（卡片、目录与标签筛选、搜索、详情抽屉）。数据按 Policy ID 聚合已发布 Guardrail 版本中冻结的定义，卡片显示承接流量的版本（否则最新）；详情抽屉多一个“发布”页签，按 ID@版本 + 定义摘要列出各版本、使用它的 Guardrail 版本与是否承接流量，同版本号不同内容分开展示并告警。新建、导入、编辑、删除、导出 Policy 均移除且 API 拒绝 | 名称只作展示，不作聚合键；自定义 Policy 的发布只带测试名称和预期结果，不带测试输入 |
| 生产 Playground | 与已发布版本对话（`playground/models`、`interactions` 为 core）；草稿预览与草稿对话仍为 authoring | 与设计一致 |
| 生产再导出 | 导入的版本不能从生产再导出 | 第三环境的信任链未实现 |
| Runner 升级 | 版本与 Runner 不兼容时由加载检查和 Router 门禁阻止投入使用 | 新旧 Runner 池并行切换的升级流程未实现 |

端到端验证：`npm run helm:deploy:promotion` 在 OrbStack 上部署两个 Helm release（`tali-guard-uat`、`tali-guard-prod`，各自的 namespace、数据库、签名密钥、Controller、Runner；生产关闭 authoring，信任源写在 `controller.promotion.trust.sources`），`npm run test:promotion` 运行 `scripts/regress_guardrail_promotion.mjs`，`scripts/regress_guardrail_promotion.mjs` 覆盖：UAT 测试并发布候选、导出、Library 变化后重新导出逐字节一致、生产冷启动、导入与真实 Runner 加载检查、幂等重复上传、跨环境摘要一致而签名不同、通过加载检查的导入版本在路由前进入默认池且 Playground 不再被 authoring 拦截（草稿预览仍被拒绝）、第二位管理员批准变更单后承接真实流量、篡改/不可信签名/同版本不同内容/跨来源接管/保留 ID 均拒绝且不写入、缺失 Action 的版本可导入但不能路由、导入不改变基线以及显式切换基线。
