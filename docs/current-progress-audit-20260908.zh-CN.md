# 当前交付进度核对（2026-09-08 13:15 CST）

**此标题时间为历史审计起点，不是实时状态。** 最新主环境结论见
[当前交付摘要](protection-release-status.zh-CN.md#当前结论2026-09-08-主-tali-验收之后) 和
[tali 限定验收](tali-acceptance-20260908.zh-CN.md)。主 Controller 已升级；真实提前释放、
取消及保存成功但响应丢失的恢复已有后续证据。移动端已由用户明确排除，不再保留为阻断项。

后续更新：用户授权的第二轮真实 SSE 已通过 7/7，使用正确 baked 镜像，NVIDIA 29 次、DeepSeek 3 次。
见 [实测证据](live-stream-proxy-round2-20260908.zh-CN.md)。下文是 13:15 的审计快照，
其中“正确镜像真实 SSE 尚未通过”已被该限定回归取代，其余验收边界仍保留。

本次以当前工作区、OrbStack 状态和重新执行的检查为依据，不把历史报告当作实时证明。
HEAD 为 `e399861`，Guard 与兄弟 Relay 均有未提交修改。本轮不提交、不覆盖其他工具的修改，
没有新增真实模型 API 调用；读取主状态并执行已发布 Default 的无模型测试会产生正常运行日志。

## 整体阶段

**产品主体和本地保护已落地，真实模型端到端验收尚未完成。**
不能把“UI 有配置项”“模型能调用”“工程 Mock 通过”视为真实保护质量已验收。

| 目标 | 当前证据 | 判定与边界 |
| --- | --- | --- |
| 银行、证券、互联网等代表性预配置 | 当前 protection-presets.ts 包含通用、银行、证券、互联网、新加坡金融参考五套；本轮控制面与冻结数据面测试通过 | 已实现并有无模型执行证据；不是监管合规认证 |
| 行业预配置包含基础保护 | 共同 baseline 引用凭据、PII、有害词语、提示操纵等完整 Policy；保留顺序与用户覆盖 | 已实现；不是把匿名 Rule 拼进 Guardrail |
| Default 不依赖外部模型 | 主健康接口 modelIndependent=true，requiredModelBindings=[]；483 次实际执行模型调用全部 0 | 本轮再次通过 |
| 控制面管配置、验证、产物；数据面执行已编译产物 | 预配置测试分别从 Controller 编译验证及冻结签名产物执行；模型生命周期历史双 Runner 实测 | 核心分层已实现；不能替代所有故障与并发场景验收 |
| 完整保护地图，步骤可选 | 当前 protection-map.ts 有八个业务目录；wizard 使用这些目录并显示 optional/selected/needsSetup | 源码存在；本轮没有重新浏览器验收全部向导状态 |
| Input / Output / Stream | 当前执行合同测试通过；Default 需要完整缓存；正确 Relay baked 镜像前轮三模式工程测试通过 | 工程链路具备；真实业务模型完整 SSE 仍未通过 |
| Relay 修改限制在 Guard Provider 集成 | 当前兄弟仓库变更为 Guard Provider、streaming 模块、配套测试/文档/镜像构建测试入口 | 未修改通用 Router 行为；本轮没有改动兄弟仓库 |
| 持续告知进度与需要交互的节点 | 本报告明确失败、暂缓与未知边界 | 真实 API 限额已耗尽，未自动扩额；重新开展真实回合时应先明确新预算 |

## 本轮重新执行

1. Python 控制面预配置编译/验证、冻结预配置执行、Output stream 合同：**59 passed**，49.58s。
   覆盖五套预配置与九个独立扩展 Policy；测试只提供本地 action providers。
2. Controller 预配置与系统健康接口：**14 passed**，1.17s。
3. 主集群 Default 实际发布产物：**483/483**，含 321 继承、140 旧冻结样本及 22 明确断言；
   123 条完整输出核对，模型调用 0，无 fail-closed 冒充拦截，未排除用例。
4. 主系统状态：healthy / basicProtection ready，32 个 Policy，Input/Output 各 32 检查，
   modelIndependent=true；两个 Runner Pod 均 Ready、无重启。

Default 发布版本仍为 `20260908-024342.826Z`，来源 draft 6，应用代次 18。
Artifact `ac1c751e-31b2-4d92-8b95-7edf06946919`，SHA-256
`08414cabe9a5320d67aa4a9144f5127677df00ba8e887b425e1855f42772cdc8`。
本次没有修改它的策略、发布版本或模型绑定。测试数字属于独立执行，不拼成一次全量测试。

## Streaming 的实际区别

- **检查后逐段放行**：检查当前可用上下文，通过后放行允许的片段，首内容延迟较低。
  后续发现风险只能停止后面的输出，无法收回已经释放的内容。窗口边界和缺失上下文仍需质量验证。
- **完整缓存**：收完整个回答，再检查/脱敏，然后交付。首内容延迟较高，但避免密码、证件号
  或跨段敏感值在完整检查前泄露。即使客户端使用 SSE，也不意味着必须提前输出内容。
- 当前 Default 包含完整值脱敏，因此实际使用 full_buffered，不能为了低延迟静默降级。

## 当前未完成的真实验收

1. **正确 Relay 镜像的真实业务 SSE 全链路**：上一轮误选旧 dev 镜像，完整缓存提前输出；
   已补离线镜像门禁和首错即停。正确 baked 镜像的工程测试与真实回答离线重放通过，
   但尚不能替代真实 NVIDIA 多窗口检查。详见 [SSE 失败与修复记录](live-stream-proxy-20260908.zh-CN.md)。
2. **JailbreakDetect 的检测质量**：专用 endpoint 路径已确认，但已知攻击样例漏检，仍未通过。
3. **NVIDIA Topic Control**：按用户要求暂缓真实服务；Mock 工程通过，不代表真实模型效果通过。
4. **审核后的质量门槛**：当前烟测/回归集合不等于独立的每类、每方向误报/漏报验收。
5. **最终工作区交付**：仍有未提交修改；后续收尾时需对最终代码与最终部署工件再次执行匹配的验收，
   不沿用旧 dev 镜像或覆盖失败记录。本轮用户未要求提交。

这份核对不宣布总目标完成。后续应优先关闭正确镜像的真实 SSE 验收缺口，
Topic 保持暂缓，JailbreakDetect 保持独立失败项，而不是重新实现已经通过的 Default 和预配置。

## 后续增量：创建向导真实浏览器核对

以上为此前快照。正确 Relay 镜像的限定真实 SSE 第二轮已完成 7/7，
NVIDIA 29 次、DeepSeek 3 次；详见 [第二轮报告](live-stream-proxy-round2-20260908.zh-CN.md)。
它关闭上文第 1 项的限定场景缺口，不替代独立模型质量验收。

随后在 `tali-model-e2e` 的 `localhost:38381` 使用实际浏览器验证创建流程，外部模型调用 0：

- 空名称时 Next 禁用且有原因；完整八类保护地图可见，未选项可跳过。
- 银行预配置应用后为 17 Policy / 38 Rule，Review 明确只创建草稿、并不部署。
  通过 UI 保存 `UI audit banking 20260908`，ID `c694251b-d225-411c-88b0-c19966227274`。
  保存后显示 Needs Testing、Current draft is not published、流量 0，未执行发布或部署。
- 证券预配置为 18 Policy，互联网预配置为 20 Policy；先应用证券再应用互联网得到 22 Policy，
  共用基线未重复插入。该合并草稿未保存。
- 选中的完整回答策略使 Review 显示 Full buffered · Check before release；
  此处不将 SSE 等同于允许提前放行。

发现并修复：切换预览模板后，旧的 Preset applied 提示仍留在新模板下方。
仅修改向导选择回调来清除这条提示，不清除 bindings、不自动应用新模板。
新增测试使用真实 Select 组件，检查旧提示消失及再次应用时既有 Policy 保留。
向导与 preset 测试 **19/19**；`npm run build` 前后端通过（已有 bundle 大小警告）；
`git diff --check` 通过。

修复后的源码 UI 在 `localhost:38391` 代理同一隔离后端完成浏览器复测：
银行应用 17 → 切到互联网只预览时旧提示消失、stepper 仍保留银行选择 →
点击应用后 Review 显示 21 Policy / 55 Rule。修复前后均检查了 1280×720 审核页截图；
固定底部操作未遮挡主按钮，完整 stepper 可见。未改主环境 Default，未将本次源码修复部署至集群。

这是桌面创建主路径与反馈的局部验证，不是整体 UI release gate 通过：
窄屏、全键盘与屏幕阅读器、所有失败恢复状态仍需独立验收；
模板预览中的 “selected” 用词也仍可更明确地区分模板包含与实际选择。

### 窄屏与键盘增量验证

使用同一隔离后端和源码 UI，检查 390×844、320×568、1280×720；外部模型调用 0，未保存新草稿。
真实键盘 ArrowDown / End / Enter 可打开模板选择器、选择新加坡金融参考模板、应用并导航至 Review。
该模板显示 20 Policy / 50 Rule。空名称跳到 Review 后仍禁用 Create draft，并给出返回首步补名称的原因。
320×568 的主按钮高度为 44px；对话框 clientWidth 与 scrollWidth 均为 319，无整体水平溢出。

浏览器发现：在最后一步将窗口由 390 缩到 320 时，活动步骤右边界仍为 378，超出视口。
修复 CreationFlow 的窄屏可自由导航模式，观察容器尺寸变化并重新定位当前步骤；
线性向导和桌面竖排保持原行为，卸载时断开 observer。新增尺寸变化与清理测试。
重新加载源码 UI 后复测，320px 下活动步骤范围为 x=196..308，截图确认完整可见；
桌面竖排、必填错误和按钮布局正常。相关 **23/23 tests**，前后端生产构建通过。

剩余可访问性问题：Escape 确实关闭对话框，但稳定后的焦点落回 document body，
没有恢复到创建按钮；后续需要修复关闭后的焦点返回并补测试。
因此本轮只关闭活动步骤 resize 裁剪缺口，不宣布整个键盘/屏幕阅读器 release gate 通过。
真实设备软键盘、读屏体验及其他表单错误恢复仍未验收。已恢复浏览器默认尺寸并关闭临时页面。

### 关闭向导后的焦点恢复

已修复上节确认的焦点返回问题。GuardrailsPage 在两个创建入口记录实际触发按钮，
通过可选 returnFocusRef 传给向导和 EntitySheet；关闭时仅对仍连接且未禁用的按钮恢复焦点。
不传该属性的其他 Sheet 保持 Radix 默认关闭行为，保存导航后不强制聚焦已经移除的按钮。

首次尝试在 Sheet 打开时记录 activeElement，单测通过但浏览器失败：名称输入框的 autoFocus
已经先改变了焦点。因此未保留该方案，改为上述显式触发按钮引用，并将 autoFocus 加入测试。
新增测试覆盖 Escape / Close / Cancel、两个不同创建入口、保存后入口移除。
EntitySheet、CreationFlow、创建向导三个测试文件共 **19/19 passed**；前后端构建通过。
真实浏览器重新加载修复后的源码：桌面 Escape 和 320px 窄屏 Cancel 后均观察到
dialogs=0、activeElement.tagName=BUTTON、text=Create Guardrail，不再落回 BODY。
没有创建新资源、调用真实模型、修改主集群或提交工作区。此前读屏和真实设备软键盘验收缺口仍保留。

## 13:52 当前工作区完整工程回归

本轮按验收 runbook 运行一次 `make test`，退出 0：

| 分层 | 通过 | 条件跳过 |
| --- | ---: | ---: |
| Python contracts | 55 | 1 |
| Python control_plane | 672 | 0 |
| Controller API/UI | 769 | 9 |
| Python data_plane | 437 | 18 |
| Python e2e | 5 | 3 |
| 合计 | 1938 | 31 |

协议生成、冻结签名产物 `--check`、Helm lint/render、Controller 类型检查和生产构建通过。
构建仍提示 bundle 大小；NeMo nim_url 弃用与既有测试警告保留，未作为失败忽略开关处理。

默认跳过项分别补验，全部为本地测试，不增加真实 API 调用：

- Kubernetes：`GUARD_HELM_TEST_CONTEXT=orbstack`，安装/升级/保留 Secret 重装/保留历史重装，1 passed。
  仅创建随机测试 namespace 的 Secret/ConfigMap，测试完成清理该 namespace，不改应用工作负载。
- PostgreSQL：使用现有隔离数据库55439，服务端53个文件526 passed，包含原先跳过的9项。
  只复制表结构到随机 schema，模拟验证结果，测试结束清理 schema，不改 public 业务行。
- Redis：隔离 `tali-model-e2e` Redis 经临时 loopback56389转发，18 passed；
  包含双实例真实租约/原子提交与实际TCP流转，仅清理测试随机keys，不执行 FLUSHDB。
- Relay：已有 baked 镜像 `sha256:50b12c8bbaee16c0677b145bcbebd5198758e42ca8fe18ab6a6669ab562f0e60`，
  3模式参数化测试通过（16个受控子场景），包含正常、阻断、检测故障、取消、首帧超时；
  不挂载替换源码、不拉取新镜像。检测结果为合成值，故证明工程行为而非检测质量。

运行时源码基线 Guard HEAD=`e399861ab0562000ecfe2aa3f9b1caa471309033`、
Relay HEAD=`3e6ade3590cbc1561ee15fa378bd996d774af4be`，双方均有未提交修改。
运行前 Guard 已跟踪差异 SHA256=`5361d23e1ba8604d50b28b2651ae1cfc08de915ca99def392acc824bed46f3cf`；
这个差异指纹不包含未跟踪文件，不能独立当作完整候选身份。实际测试包含当时工作区的新增测试/脚本。
本轮只有文档更新，未修改运行时代码、部署主集群或提交。

重新核对计划后：A阶段过去列出的证券/互联网代理、PII分片、Topic Mock发布对照、当前Default发布
都有后续证据，不应继续把旧快照中的“待补”当作当前缺口。
仍缺少最终候选部署身份和完整交付核对、独立审核质量集/阈值、指定模型质量通过证据。
Topic维持明确暂缓，JailbreakDetect已知漏检维持未通过；不以1938项工程测试取代这些门槛。

## 最新 Controller 候选部署到隔离集群

完整工程回归后，使用当前工作区执行 `make helm-package` 和 Dockerfile.controller 生产构建。
未覆盖 dev 标签，新镜像为
`ghcr.io/tasklattice/tali-guard-controller:acceptance-20260908-ui-final`，
镜像及实际 Pod imageID 均为
`sha256:c49f23bae323938581e7939b9d6f8eec910392c81789edb3b754ff8e78fcea93`。

构建时 Git 跟踪及未跟踪、非忽略文件的逐文件 SHA256 清单汇总为
`1c24f08c571213f0f7ce9469662202e1ae6291fcd2cf40613189e5720e6d0964`。
该值用 `git ls-files -co --exclude-standard -z | sort -zu | xargs -0 shasum -a 256 | shasum -a 256`
生成，包含未提交源码/测试；不涵盖被忽略的依赖、构建目录或本次随后追加的报告内容，
不能据此声称整个构建环境可复现。

仅使用 `kubectl set image` 更新 `orbstack / tali-model-e2e` Controller Deployment；
这是隔离验收覆盖，不更新 Helm release values，后续 Helm upgrade 可能恢复其原镜像设置。
没有修改主命名空间 `tali`、Runner 镜像、Secret、模型配置或 Guardrail 草稿。
旧 Controller 镜像为 `sha256:c3d2207178fffb3fbdfe3cfeeddb9cfa2707bcc836a6390f6b6bce9e40b8d2c2`。

部署后证据：

- rollout 成功，新 Controller Ready；两个 Runner 均 ready、controller_connected、
  desired_state_synchronized，applied_generation=27，5/5 活跃版本已预热。
- 部署前后8个 Guardrail 的 ID/草稿修订/活跃版本/产物身份摘要一致：
  `f1c895e24a7b5ec3212e398190590a1a57a767608bb0b478b5074f00e3db61ca`。
- 模型配置 API 响应摘要前后一致：
  `34b48a5b1bb81ae17d3b1aa3e5ff9c3c9ea1a3021ef1d5e866758c9387e19ec3`。
  凭据只在内存读取用于隔离登录，未打印或写入报告。
- `/guardrails` 和 `/settings/health` 返回200并引用新资源 `index-Cpjj7TW8.js`；
  实际 HTTP 获取的 JS SHA256 与 Pod 内文件一致：
  `4c33c6460d986ed333b0a09bfd35aea4dd969453b16c3185678faea640940bde`。
- 对隔离 Default `20260908-044135.655Z` 先确认执行计划全部为 builtin_content_filter，
  再执行 Input/Output 各正常放行及凭据阻断，共4/4，model_invocations=0、fail_closed=false。
  该版本不是主环境 Default 版本，不将四次烟测冒充483项完整重跑。
- 三个真实模型网关均保持0副本，无新真实 API 调用。

本轮关闭最新 UI 未打包部署的缺口。HTTP资源检查不替代浏览器交互验收；
Runner继续使用原已验证镜像 `sha256:ad91e568b73cde590c0750b4f1c4bb5f6e92f188df38c49f2bff2099c2797eef`。
完整候选交付核对、独立模型质量门槛仍未全部完成，未提交或宣布目标完成。

### 已部署向导：参数错误与恢复路径

本轮没有运行时代码修改。按 vibe-designing evaluator 对上述 acceptance 镜像执行真实浏览器局部验收，
不是开发服务器或仅 DOM 单测。原38381旧Pod转发已经不可达，改用临时38481转发访问同一隔离Controller；
复用已有会话，不改变 trusted origins，不执行保存或真实模型操作。

从 Create Guardrail 新建未保存配置，填入名称，直接进入 Business topics：

1. 完整11步导航中8个保护分类均标记可选；AI分析未配置时生成入口禁用，明确允许手动选Policy。
2. 选择 Model Topic Control 后，步骤变成 Needs configuration；allowed_topics为空时 Next禁用，
   固定操作区状态说明必须添加至少一个允许话题。依赖区明确 Topic control · Requests / Not assigned。
3. 填入人工测试话题后可进入Review；Create draft可用，但仍保留未分配模型提示，
   明确 Selected is not validated 和 No live traffic changes。只配置Input时明确提示没有Response保护。
4. 实际390×844截图确认审核主按钮可达，44px高；document宽度390，dialog clientWidth/scrollWidth均389。
   桌面截图用于检查Topic参数区域与侧边步骤，不声称截图覆盖所有滚动内容。
5. Close后dialog数量0，activeElement为Create Guardrail按钮；浏览器warn/error日志为空。

局部评分依据（每项0–2，权重沿用产品spec）：Intent的任务说明/保存语义=2/2；
IA的可选地图/错误定位=2/2；Craft的组件一致性/全状态覆盖=2/1；
Domain的依赖事实/方向边界=2/2；Interaction的补填恢复/持久化失败恢复=2/1；
Visual的布局克制/全部断点截图=2/1。六维为10/10/7.5/10/7.5/7.5，加权9.125。
扣分项是本轮未覆盖的证据，不是发现了对应产品缺陷。
本局部错误恢复路径未发现阻断；但不以该分数宣布完整release_gate通过：
本轮没有提交草稿、触发网络保存失败或使用真实设备读屏。没有新增修复要求或为了分数做装饰性改动。
本轮截图和DOM见当前任务工具记录。未创建/发布Guardrail，外部API调用0。

### 数据面部署源码一致性与剩余验收分界

再次只读核对两个运行中的 `tali-model-e2e-runner-0/1`：
将容器 `/opt/tasklattice/guard-runner/runner` 与当前工作区 `runner` 全部普通文件逐个SHA256比较，
排除 `__pycache__`、`.pyc`、`.DS_Store`。每端102个文件，缺失、额外或内容差异均为0。
排序后的路径/哈希数组摘要为
`2cb9db28868b29dea3a56e35168677213f133ccb365bb2c775a12a9b83a25fae`。
因此旧dev标签没有掩盖本次Runner源码漂移；该检查不覆盖Python依赖目录或容器系统软件。
未重启Pod、替换模型或发送检测请求。

验收范围复核：现有数据面测试明确修改已签名配置后拒绝损坏代次、保留代次1和路由ready；
重建ArtifactStore/NeMoRuntimeRegistry后检查本地恢复、ready与Integration认证。
这是进程内持久化恢复测试，不声称做过集群级节点故障演练。
控制面测试明确拒绝编译器改变Rule动作、拒绝与通过验证的快照不一致的发布，
并确保晚到编译结果不覆盖新版本或显式回滚。以上均包含于此前完整工程回归，未重复执行。

仍需按具体缺口推进，而不是重复“更广泛测试”：

| 剩余项 | 当前证据边界 | 下一项所需证据/输入 |
| --- | --- | --- |
| UI网络保存失败与恢复 | 已有保存成功、缺参数、补填、取消焦点；本轮未触发保存网络失败 | 隔离环境可控失败后表单保留、错误可见、恢复后正确保存；不得触发真实模型 |
| 整体交付验收矩阵 | Controller镜像/资源和Runner源码一致已核对，历史分阶段证据已保留 | 按产品契约逐项明确已验/未验，不把局部UI分数当全局通过 |
| 独立模型质量 | 已有限定真实工程调用与已知Jailbreak漏检；不是独立集 | 用户审核B阈值、独立样本及标签/审核来源，再另行授权真实请求上限 |

Topic仍按用户决定暂缓。已有真实调用授权已用完并结束，不能因为本轮继续目标而重开网关。
工程与质量两类剩余项相互独立；不称目标已完成，也不称现在所有工作都被API额度阻断。

### 保存连接失败与手动恢复：已部署 UI 实测通过

继续使用 acceptance Controller 镜像和隔离 `tali-model-e2e`，按 vibe-designing 的实际操作/截图要求，
打开创建向导，填写 `UI save recovery banking 20260908` 并应用银行模板。
失败前Review为17个Policy、38条Rule、Full buffered。仅关闭本轮自己创建的38381端口转发，
在连接完全不可达后点击Create draft，未停止集群组件或影响主环境。

实际结果：

- 对话框保持打开，名称、17个Policy、38条Rule和输出模式保留。
- 桌面截图显示固定操作区有Request failed / Failed to fetch及恢复说明：选择保留，
  重试前先检查列表，重连不会自动提交。不是只有控制台报错或短暂toast。
- 重开同一端口转发后，在独立浏览器页查看列表仍为8条，没有同名草稿，证明此次失败未产生写入，
  且恢复连接没有自动排队提交。此后仅手动点击一次Create draft。
- 成功跳转详情，显示Needs testing / Current draft is not published，Protected traffic=0。
- API只读复核列表变为9条，同名草稿恰好1条，ID=`ec27f0a4-e058-47a7-9ccd-0d27b0d80986`。
  保存的17条绑定逐项对照当前banking-assistant模板的Policy ID、版本、执行顺序、enabledRails和参数，
  完全一致；outputDelivery=full_buffered，activeVersion和activeArtifactId均为null。

该场景已有自动测试 `reports offline creation without queuing a later write and preserves selections for explicit retry`，
包含于此前完整工程回归；本轮增加的是部署后真实网络失败/恢复证据，无需改代码或重复整套测试。
本轮桌面错误截图有效；窄屏第二次截图工具返回异常小图，不把该图算作窄屏错误布局证据。
之前已完成的窄屏审核/按钮/溢出证据不受影响，但不能替代所有错误组合的窄屏截图。
局部门禁decision=pass：错误可见、数据保留、显式恢复、持久化一致四项均2/2，未发现本路径阻断。
此前局部六维中Interaction的持久化恢复子项由1补为2，其余维度不重新评分或放大为全产品验收。

隔离草稿保留供审核，没有验证、发布、流量分配或外部模型调用；浏览器临时页已关闭。
这只证明请求发出前连接中断的恢复，不声称证明了“服务器已提交但响应丢失”时的幂等重试。
当前UI对此不自动重试，并明确要求先查列表，不伪称该场景具备自动恰好一次语义。
