# GuardRails 当前交付状态

记录日期：2026-09-08。本文是验收交接摘要，不是实时健康探针，也不表示全部发布门槛已通过。

最新发布恢复增量（19:40）：Policy发布绑定已验证草稿revision，数据库唯一约束+行锁确保重试返回同一版本。真实`tali`桌面注入“提交成功后响应丢失”，Enter重试后打开版本1；两次POST只有一个版本和一个发布审计。PostgreSQL/验证边界15项、HTTP5项、相关前端31项通过；完整服务端518 passed / 18条件skipped，类型检查和生产构建通过。Controller `:dev` digest `sha256:cef90f0fabcb0c8e3fc8ecf12f1914437efa402800446621458f93aa57ed7112`，迁移0005已生效。临时Policy已永久清理，审计保留；模型调用不增加、Default与活动模型未修改。此条取代下一段“发布响应丢失尚未关闭”的局部结论，不代表所有创建/保存请求exactly-once或完整U1验收。详见[发布幂等恢复](protection-completion-audit.zh-CN.md#u1增量已提交发布响应丢失后的幂等恢复1940)。

最新桌面增量：发布已成功但详情加载失败时，Policy Studio保留版本成功状态，固定底栏提供只读重载，不再次发布；关闭后的旧读取不能导航新会话。相关28项、类型检查和生产构建通过，主`tali`真实临时Policy验证→发布一次→详情503→Enter重载→版本1详情通过，后端确认无重复版本。两个未绑定测试Policy已永久清理，代理/测试页关闭；新增模型调用0、未提交Git。当前Controller `dev` digest `sha256:932b199e37badb18afcb2412fafb8930996f5c5a1fe7ca909a27d7e43a0544f1`（包含并行工作的更新），提供本轮验收资产`index-Dyfqjo53.js`。详见[发布后读取恢复](protection-completion-audit.zh-CN.md#u1增量已发布但详情加载失败)。**发布响应本身丢失的结果不确定场景仍未由此关闭**，完整U1/C1/Q1仍开放。

最新编译增量：Compiler v21修复动态Flow生命周期目标的Policy局部名称解析，保留NeMo正则监听，并验证目标表达式单次求值。最终Python **1268 passed / 22环境条件skipped**，19套固定签名产物新鲜度通过。主`tali`两台Runner `dev`当前digest为`sha256:2e83d2053a0de942ae356df1e7c8678d8bf2c0b30074cf8d4d7328feca2bae4a`；实际容器各6/6动态Input/Output检查通过，预热2/2、generation30同步。正式Default483/483、123项精确输出、模型调用0，原发布身份与模型revision3不变。Controller仍为下述`1997fc…`镜像，未提交Git、未新增真实API调用。详见[动态Flow增量](protection-completion-audit.zh-CN.md#c1增量动态flow生命周期目标)；C1任意动态事件对象/依赖保证、U1合并桌面门禁、Q1独立质量验收仍开放。下文v20为历史记录。

最新目录恢复修复：Policy Studio不再把Action目录加载失败或离线等待当作空目录；明确错误、重试、加载/等待连接和成功空目录状态，保留缓存与已选版本。相关4文件27项、类型检查及最终镜像构建通过。主tali Controller `dev`当前digest为`sha256:1997fc7c59774af198aff939dea1583d61a40505ca40597a0fa14bc8c3f35a62`，页面`index-8P9Ghbkx.js`。1366×900桌面经只读代理完成503→显式重试→真实目录恢复，两个默认依赖和名称/用途均保留；没有存储写入或模型调用。测试代理和页面已关闭。下文各镜像为历史证据，完整U1/C1/Q1边界仍未关闭。

最新焦点修复：Policy Library明确记录新建/导入/编辑的实际按钮，并传给现有EntitySheet焦点恢复机制。4个文件23项相关测试、类型检查和构建通过；主tali 1366×900实际页面Escape/关闭/取消均返回“新建 Policy”，Enter可重新打开、focus-visible为true、无横向溢出或console error。Controller `dev`当前digest `sha256:1fcc080ee4c9c9f3a569b2f6b2e15860f1405459dbd9978af582a32dfe326e9a`（页面`index-DZLEaHGZ.js`）。未保存/发布测试数据、未调用外部模型、未提交Git；没有重跑全工程测试。下段“焦点待修”是已由本条修复的上一轮发现，U1完整矩阵仍未关闭。

最新桌面增量：Policy Studio 的验证结果现在绑定编辑版本和编辑器会话，修复验证期间编辑后旧结果放行发布、关闭重开后旧保存/验证污染新窗口的问题。新增6例、该文件10/10，Controller/UI完整回归787 passed / 13条件skipped，类型检查与构建通过。主tali Controller `dev` digest为`sha256:52188f7849d04a51d8a79c79b4f78450a24e2a42f63bdbefc9ee91d881daf8ee`。1366×900真实桌面完成“延迟旧结果→保留修改并要求重验→revision2真实NeMo通过→允许发布”；没有实际发布。测试草稿已精确硬删除，删除审计保留，代理和测试页已关闭。本轮零模型调用。另实测关闭Policy Studio后焦点落到body，列入U1待修，不宣称完整桌面验收通过。详见[Policy Studio增量及状态矩阵](protection-completion-audit.zh-CN.md#u1增量policy-studio验证快照与会话隔离)。下方Controller镜像均为各轮历史快照。

最新编译增量：Flow生命周期事件的静态flow_id现在进行Policy局部声明检查和名称映射，合法事件式helper可正确执行，同名Policy helper不串用。编译器v20、18套固定产物新鲜度通过；相关110项、完整Python1234 passed / 22条件skipped。主tali两台Runner `dev`当前digest为`sha256:2d45841ab87112022860a06ebb02dbb86c03b80f8ed2ad06fcf3a29e3810d6f4`，容器内Input/Output零模型检查通过、预热2/2、generation30同步。Controller未更改；下方v19为前一轮历史证据。详见[静态Flow事件增量](protection-completion-audit.zh-CN.md#c1增量flow生命周期事件的静态目标)；动态表达式C1仍开放。

v20更新后原Default正式签名产物回放483/483，精确输出123项、模型调用0，draft revision6/发布版本/产物身份保持不变。未修改Policy、发布配置或活动模型绑定。

最新桌面增量：Rule动作选项现在明确区分默认、继承Policy、显式局部覆盖，修复Policy reject而Rule误显示redact的问题。相关66项测试、类型检查、构建及主tali 1366×900桌面恢复路径通过。Controller `dev`当前digest为`sha256:2775d9b0b8ede0dcbbe04d36612697fc87aed839ac8ebc1791b9da5025342c83`；Runner/活动配置不变、预热2/2、generation30同步。未新增API调用或保存草稿，未提交Git。详见[U1增量](protection-completion-audit.zh-CN.md#u1增量rule继承动作显示)；下方Controller摘要是此前各轮证据。

最新运行时增量：修复自定义Colang `send Start…Action` 绕过Policy依赖声明的问题，包含隐藏分支与组合事件；保留合法声明调用和不发起调用的监听。编译器v19，17套固定产物已刷新；完整Python1205 passed / 22 skipped，部署内编译检查通过。主tali两台Runner均为`ghcr.io/tasklattice/tali-guard-runner:dev`，digest `sha256:e76b333621cc8d5b1bae26c88bde9ad9a9c8c6a466e84ed6af01e57f28b67e8f`。原Default重新执行483/483、零模型调用，发布身份和模型revision未变，generation30同步。详见[整体核对的C1增量](protection-completion-audit.zh-CN.md#c1增量action启动事件依赖检查)。没有新增真实API调用或Git提交；Controller未重建。下方1973项完整门禁在此Python增量之前执行，不能混作同一次运行。

## 最新整体核对：完整当前工程门禁通过，剩余项已定位

[逐项交付核对](protection-completion-audit.zh-CN.md)对照了当前源码、兄弟Relay工作区、测试断言和真实回归证据。原阶段表已更新，后续不再将已完成的流式取消、正式模型路由、保存恢复或激活竞态反复作为待实现项。整体合同仍开放：C1任意动态自定义Flow依赖完整性、U1合并后的完整桌面发布证据、Q1独立审核模型质量集/阈值；这三项是不同的证据缺口，不是三个已复现模型故障。

最新一次完整 `make test` **退出0，1973 passed / 35 skipped**：合同55、Python控制面681、Controller/UI779、数据面453、通信E2E5。协议/固定签名产物新鲜度、Helm lint/render、类型检查、生产构建通过。日志：`/tmp/guard-final-engineering-audit.log`。35项为PostgreSQL13、Redis18、Relay3、Helm1；本次没有启用其环境开关，沿用下方已明确日期和范围的独立执行证据，不把跳过算成新通过。保留现有NeMo弃用、Node环境及bundle体积警告。

本轮仅更新验收文档并运行本地工程测试，没有新增模型调用、集群写入、镜像构建或Git提交。主部署身份仍为下一段的Controller dev摘要；构建本地静态资产不是部署。

最新 UI 增量：预配置预览改为“包含/未包含”，不再冒充“已选择”。34 项相关前端测试、类型检查、构建及 62 项预配置/顺序/Override/依赖测试通过，主 `tali` 桌面复核通过；没有新增模型调用或保存测试草稿。Controller `dev` 当前 digest 为 `sha256:25dad29873ba7eb341e4a01f6d3b82be95ea67d88e74cbb2e3e0938bc37f53bc`。此变更不改变上一轮模型、Default 或流式执行语义。

## 最新：各 100 次授权的扩展回归已完成

用户本轮排除 Topic Control/Jailbreak Detector，其余限定回归已完成：NVIDIA 73 次、DeepSeek 13 次；内容安全 48/48、三模式 Streaming 11/11、正式 Default 483/483、真实控制面及正式模型路由生命周期、Playground 均通过；相关自动化分组共 122 passed。临时资源已收尾，正式 `tali` healthy、两台 Runner 收敛到 generation 30，Default 和活动模型配置未改。

详见 [本轮完整证据及边界](tali-expanded-acceptance-20260908.zh-CN.md)。本条取代下文旧快照中“需要追加调用授权”“真实取消/三模式尚未完成”等结论；独立生产效果认证以及两个明确排除模型的遗留问题仍不能据此记为通过。

## 历史快照：首轮主 tali 验收之后

**产品主体、本地预配置和限定真实数据面验收已有证据；独立生产质量验收仍未签署。**
下文“主环境未更新”“尚未观察到真实提前释放/上游取消”等内容属于早期快照，
由本节和 [tali 验收报告](tali-acceptance-20260908.zh-CN.md) 取代，不再作为当前阻断。

| 交付层次 | 当前证据与状态 |
| --- | --- |
| 产品主体 | 五套代表性模板、完整可选保护地图、版本化 Policy、Input/Output/Streaming 主链路已落地；没有重新实现已通过的功能 |
| 主部署与 Default | `tali` 已通过 Helm 更新 Controller；主健康 healthy，两台 Runner 收敛到 generation 19。Default revision 6、32 个本地 Policy，未修改且无模型依赖 |
| 限定真实验收 | Safety v3 开发样例 16/16；真实 DeepSeek Streaming 3/3，含提前释放、取消、检测服务故障。NVIDIA 32/40、DeepSeek 3/3；后续没有新增调用 |
| 桌面保存恢复 | 服务端提交后响应丢失，UI 保留配置、提示人工核对，并从列表打开唯一草稿。不是自动 exactly-once 保证 |
| 主模型配置激活 | 纯内容安全配置因已有发布产物依赖 Jailbreak 被拒绝；原活动绑定未变。后续数据面测试在同 `tali`、同镜像临时 Runner 完成，不能冒充主配置激活成功 |
| 生产模型质量 | 独立审核集/标签/每类每方向阈值仍缺验收输入。开发集全过不能补足这一门槛；Topic 暂缓，JailbreakDetect 既有漏检仍单列 |

用户已明确放弃移动端，不再把移动端、软键盘或移动设备验收列为后续任务。
桌面局部交互证据不等同于覆盖所有辅助技术/浏览器/故障组合；只对明确执行过的路径签署结论。
原始录制、测试资源、未覆盖内容及清理状态见 tali 报告；Git 仍未提交。

后续安全修正：验收脚本不再把激活被拒绝后的原活动 revision 误判为“恢复失败”；
按公开 API 的 `{active, activating, failed}` 配置视图识别回滚结果，并拒绝覆盖其他并发激活。
新增 9 项离线测试通过；这是验收工具修正，未更改主产品依赖门禁或模型绑定。

### 后续控制面修正：同一模型配置并发激活（15:03）

真实 PostgreSQL 测试发现：两个请求同时通过事务外验证后，原实现会让二者
都成功，重复增加 generation、发布 outbox 事件。现已在事务内以
`state = validated` 条件原子转换；失败请求整体回滚，不能再次激活同一快照。
不同的已验证 revision 仍可替换尚未完成的旧激活，不改变依赖验证门禁。

- 新测试修复前复现两个成功请求；修复后只有一个成功、一个冲突，且 generation、
  分发事件、激活审计均只有一份。
- `tali` PostgreSQL 的随机临时 schema：11/11 通过，结束后删除临时 schema，
  不复制业务行、不修改 public 数据。端口转发只用于这轮测试。
- 模型配置模块：86 passed；另 11 个 PostgreSQL 条件项由上述真实数据库运行覆盖。
  Controller/UI 类型检查通过；外部模型调用 0。
- 当时尚未部署；后续部署结果见下一节。工作区未提交。
  该检查不等同于所有并发 ACK、模型删除或故障转移组合均已验收。

### ACK 竞态修正与主 tali 更新（15:09）

后续真实 PostgreSQL 锁交错测试又复现：旧 ACK 在更新前被锁延迟，新激活已将旧
revision 标为 failed，原 finalizer 仍会把它重新标为 active。现在 ACK finalizer
与 beginActivation 使用相同的 Controller → revision 行锁顺序，重新读取状态，
避免旧 ACK 复活已替换的配置；revision 锁也保护与 NACK 的状态转换。

- 修复前锁交错用例失败（预期 failed，实际 active）；修复后 PostgreSQL 13/13
  通过，另包含 NACK 后迟到 ACK 保留最后有效配置的用例。
- 模型配置、控制通道、模型 HTTP 专项：102 passed；13 个 PostgreSQL 条件项
  由上述 tali 数据库随机临时 schema 单独验证。类型检查、生产构建、Helm lint 通过。
- 主 Controller 已更新为 `acceptance-20260908-activation-lock`，Helm revision 36；
  实际 Pod imageID 与构建结果一致：
  `sha256:d44a244c86a66fc84350425f27ec8f108288dda930fc6fec4f9e88cde9a47ad2`。
- 更新前后数据库只读快照完全一致：原活动模型 revision、全部四个 Guardrail 的
  draft revision、发布版本、artifact ID 均未改变。没有发起真实全局模型切换。
- `07:09:48Z` 主健康 healthy；Default modelIndependent，32 个 Policy；两个正式
  Runner 健康并收敛到 generation 19。外部模型调用未增加，旧真实轮次仍已关闭。
- 部署后 Default 实际 Runner 回归 **483/483**：321 条继承用例、140 条固定旧行为
  用例、22 条额外双向检查；123 条精确输出核对。所有调用的模型计数为 0、
  `fail_closed=false`，使用同一 runtime checksum
  `a1f889a3534586002779b9fe18bcd28be77183232371294883f3dbaccac727d6`。
  Default draft revision 6、artifact `ac1c751e-31b2-4d92-8b95-7edf06946919`
  和发布版本均未改变。这不是新增业务代理或 Streaming 全矩阵验收。

并发用例检查的是实际服务方法和真实事务的状态线性一致性，不冒充真实多节点
网络 ACK 故障演练；其余未验证的生产质量和故障组合仍保留原验收边界。

### 桌面权限恢复与 dev 镜像约束（15:27）

用户明确要求项目镜像一律使用 `dev`，不得再创建验收/日期 tag。主 `tali`
已更新至 Helm revision 37，Controller 为 `ghcr.io/tasklattice/tali-guard-controller:dev`，
实际摘要 `sha256:aa9f9a9af3c337d743b3837b34e47b9bd3e2dde802cc32c62d4842f1bc667dce`。
Runner、Topic Mock 和已缩容的临时验收工作负载也均使用 Runner `dev`。
第三方 PostgreSQL/Redis 保持原明确版本。旧报告的 tag 仅保留为历史证据。

本次 dev 同时包含桌面向导权限恢复修正：打开向导后身份变为普通成员时，
明确提示需要管理员权限，禁用创建、计划重试及 AI 辅助生成；已选配置保留。
意图和文档分析不再离线排队/自动重试。服务端权限策略未修改。

- 修复前新增角色变更用例失败，修复后相关 UI/Auth/真实 Better Auth + memory
  adapter 权限门禁专项合计 **192 passed**；类型检查、生产构建通过。
- `scripts/serve_permission_ui_proxy.mjs` 以真实构建 UI + 主 tali 的只读 API
  验证状态反馈；仅会话返回被降为 user，所有保存/模型请求均在代理处拒绝。
  没有修改真实账号或调用模型。浏览器观察到 403 后：名称、17 个 Policy、38 条
  Rule 保留，权限说明可见且换行完整，创建及两个 AI 入口禁用，Escape 可退出，
  普通成员列表没有创建入口。代理只转发 1 次无模型计划预览，拒绝 1 次保存。
- 恢复权限后不自动提交由组件测试覆盖，未把浏览器刷新后的空表单冒充原配置恢复。
- 实际浏览器还观察到会话刷新清空缓存期间，短暂把未加载的 Policy 误报为不可用，
  随查询完成自行消失；配置未丢失。下一轮应把 metadata loading 与 missing 分开。

Vibe Designing 本轮是桌面向导的有限权限状态审查，沿用原计划六维权重
20/20/15/25/15/5 和 >=8 无正确性阻断门槛。每维一个子检查：明确显式创建目的2、
保护地图在刷新中的层级反馈1、现有组件与中文换行2、权限及缺失状态语义1、
禁用/保留/Escape反馈2、既有视觉系统2。加权 **7.75/10，decision: revise**；
扣分均来自上述缓存刷新误报，不将稳定状态截图或192项测试换算为全产品UI通过。
下一步只修正这一受影响状态并重跑权限路径；实际账号撤权端到端、读屏和更广
高级编写矩阵不在这次浏览器证据中。临时页面/代理收尾关闭，不留监听服务。

主健康在 `07:26:57Z` 为 healthy，两个 Runner 收敛到 generation 19；Default
revision 6 / 32 本地 Policy / 无模型依赖均保持不变。Git 未提交。

### Policy 目录重新加载与真正缺失分离（15:37）

继续上轮 `revise`，只修正创建向导的目录状态语义，不改变业务分类、权限或绑定。
身份缓存清空后，未获得目录时不再执行“版本不存在”、未知模型依赖、分类未选择或
完整缓冲依赖的判断。名称、绑定总数、Rule 总数继续来自用户本地选择；分类及实际
交付方式显示“等待 Policy 详情”。加载失败提供策略库专属重试，恢复后不自动创建；
只有成功取得目录且确实没有该固定版本时，才显示 Policy 不可用。AI 辅助入口、
计划预览和创建在目录不就绪时不可执行；不复用上一个身份的 Policy 缓存。

- 新增三条组件回归：延迟目录恢复、目录失败后手动重试、成功加载但绑定 Policy
  确实缺失。检查绑定/名称保留、不误报、阻止创建、不多发预览以及显式创建的原始
  payload（包含完整缓冲）。向导共 **15 passed**，与文档导入/Auth/服务端授权专项
  合计 **195 passed**。类型检查、生产构建、Docker 构建通过；原大 bundle 提示仍在。
- 新鲜浏览器证据：实际构建 `index-BtmmRLFg.js`，读取主 tali 数据的只读故障代理，
  银行预配置17项/38条；一次403刷新会话并延迟目录30秒。截图确认期间显示等待说明、
  总数和名称不丢、无 Policy 已删除/自定义依赖误报，恢复后分类10/4/2/1与完整缓冲
  正确，普通成员创建仍禁用，Escape退出。代理计数为1次计划预览、1次被拒绝保存，
  未转发真实保存、未改变账号、未调用模型。错误目录/恢复权限场景由组件测试覆盖，
  不冒充实际账号撤权/恢复的端到端验收。
- Controller 仍使用 `ghcr.io/tasklattice/tali-guard-controller:dev`，新 digest
  `sha256:38d3df3e93a017366d1b38246d90ef685d1cb9b1d4fa45b03a40c1861f9a90f5`。
  仅滚动 tali Controller，Helm revision 保持37；Pod digest与构建一致，38081返回
  相同UI资产。`07:36:35Z` 全局 healthy，两个Runner收敛generation19，Default仍为
  revision6 / 32本地Policies / modelIndependent=true / 原发布版本不变。

Vibe Designing 沿用上一轮限定权限/目录状态六个子检查及权重20/20/15/25/15/5。
本轮六项均2分：原显式创建/组件/禁用退出/视觉检查仍通过；分类等待反馈及未知语义
由新的延迟截图与恢复测试证实修复。该**限定路径10/10（+2.25），decision: pass**，
达到>=8且无该路径正确性阻断；不是全产品10分或最终发布验收。桌面之外不纳入；
真实账号角色变更、读屏、完整高级编写矩阵和生产模型独立效果集仍未由本轮证明。
临时代理/页面收尾关闭；本轮零真实API调用，未提交Git。

### 当前工作区完整工程门禁与 tali 条件项补验（15:45）

重新执行 `make test`，退出0：contract55、Python控制面681、Controller/UI774、
数据面443、通信E2E5，合计 **1958 passed / 35 条件 skipped**；类型检查、生产构建、
冻结产物、协议生成、Helm lint/render均通过。保留现有NeMo弃用提示和bundle体积提示。

同轮35项条件测试另行完成，不将skip直接计作pass：

| 条件项 | 当轮证据 | 隔离/副作用边界 |
| --- | --- | --- |
| PostgreSQL 13 | `model-configuration.postgres.test.ts` 13/13 | tali PG，随机空schema，无public业务行写入，结束删除 |
| Redis 18 | `test_output_streaming_redis.py` + `test_stream_replica_network.py` 18/18 | tali Redis，只清理随机测试key；包含真实TCP副本停止/接续 |
| Relay 3 | `test_relay_stream_delivery.py` baked模式3/3 | 已录制DeepSeek回答、合成检测服务、真实Relay/Runner/客户端；零外部API |
| Helm 1 | `test_helm_upgrade.py` 整文件13/13，其中真实集群1项 | 显式orbstack/tali、随机测试release；其余12项为已计入contract的重复本地合同 |

发现旧Helm条件测试会创建/删除随机namespace，不符合用户目前“仅tali”约束。
已改成要求`GUARD_HELM_TEST_CONTEXT`和`GUARD_HELM_TEST_NAMESPACE`，先检查namespace存在，
资源名全部带随机release前缀；只卸载该release及删除它保留的合成Secret，不删除namespace。
实测安装、升级、保留Secret重装、保留历史重装均通过；收尾确认无`guard-regression-*`
Secret/ConfigMap或测试release，主release仍revision37。临时端口转发已关闭。

本地Relay还缺`dev`别名，运行手册仍有旧日期tag指令，现均修正。先离线逐文件确认镜像
Guard集成与兄弟项目源码一致，再将该已验证构建标记`tali-litellm:dev`，摘要
`sha256:50b12c8bbaee16c0677b145bcbebd5198758e42ca8fe18ab6a6669ab562f0e60`；没有发明新tag，
没有拉取镜像、重建其他Provider或删除历史镜像。三种streaming模式的通过结果对应此digest。

本轮还从真实PolicyCatalog核对：69项中54项当前分类、15项legacy；五套预配置引用的
固定版本全部可解析，Policy数为16/17/18/20/20。主健康`07:40:56Z` healthy，Default
revision6、32项本地Policy、无模型依赖、两个Runner收敛generation19，均未改变。

这是当前候选的**完整本地工程门禁通过**，并不补足独立效果质量签署或每一个桌面验收路径。
Topic仍暂缓，JailbreakDetect既有漏检未通过；真实API调用0，Git未提交。

## 2026-09-08 15:54 已保存草稿的 Policy 排序补齐

发现创建向导支持 Policy 排序，但编辑已保存草稿缺少入口。现复用已有
ProtectionOrderEditor，放入折叠的“Policy 执行顺序”区，不改变顺序执行语义。
Vibe Designing 的渐进展示和组件复用约束用于本次布局调整。

新增测试先复现缺少入口，修复后相关28项测试、typecheck和build通过。
组件测试确认上下移动仅改变绑定顺序，固定版本、Rule顺序、参数及动作覆盖原样保存。
只读浏览器代理验证17项Policy移动和恢复原顺序；未点击保存，未调用预览或模型。
尚未验收浏览器保存持久化和边界按钮禁用后的键盘焦点保留，不代表全部桌面专项通过。

Controller 使用 `ghcr.io/tasklattice/tali-guard-controller:dev`，摘要
`sha256:28492e15023f184b2d7a8720782264457763dfd9b8f68d700ca9b5ef31012c53`。
仅重启orbstack/tali Controller部署，rollout成功；07:53:55Z主健康healthy，Default
仍revision6/32项本地Policy/无模型依赖，两个Runner收敛generation19。
临时浏览器页与只读代理已关闭；真实API调用0，Git未提交。本次28项是增量验证，
不是对上一轮完整工程门禁的重复全量执行。项目镜像继续只用dev，构建身份用digest记录。

## 2026-09-08 16:00 桌面排序真实保存与刷新补验

本轮针对上一节缺少的浏览器持久化证据，没有修改产品代码或再次构建镜像。
在实际 `localhost:38081` 创建临时银行预配置草稿
`687f945d-d9ad-42eb-97df-c395448b82c3`（17项Policy、38条Rule、完整缓冲），
不进行验证、发布或Deployment。使用已部署Controller dev摘要 `28492e15…12c53`。

1. 通过真实创建向导应用银行预配置，直接进入检查页并显式创建草稿。
2. 编辑草稿，将第二项Insults & Personal Attacks移到第一项，显式点击保存。
3. 真实PostgreSQL只读快照核对：draft revision从1变成2；完整draftConfig
   与预期仅交换前两项的对象严格相同，其余15项、固定版本、规则选择与交付方式不变。
4. 浏览器完整刷新，重新打开编辑并展开排序区，顺序仍为Insults第一、Credentials第二，
   不是仅依赖组件内存显示。截图确认边界禁用、顺序说明及固定保存栏可见。
5. 退出后通过产品受保护删除流程停用该临时草稿，删除原因明确记录回归用途。
   数据库确认status=disabled、deletedAt存在、activeArtifact=null；没有硬删审计记录。

创建后的基准与收尾快照相比：其他四个Guardrail的配置、revision、发布身份及活动
模型配置严格未变。删除操作使全局desiredGeneration按产品流程由19增至20，
不是模型切换；07:59:34Z主健康healthy、两个Runner收敛，Default仍revision6、
32项本地Policy、无模型依赖。临时浏览器页和PostgreSQL端口转发已关闭。
真实模型调用0、Git未提交。非空Rule局部覆盖的保留仍由上一轮组件测试证明；
本次银行模板的ruleActions/ruleOrder原本为空，不据此宣称非空覆盖的浏览器专项通过。

Vibe Designing限定审查沿用六维权重20/20/15/25/15/5与>=8门槛。
每维一个子检查：显式草稿任务2、顺序/版本层级2、既有组件布局2、真实保存及
不发布语义2、交互完整性1、视觉一致性2；维度分10/10/10/10/5/10，加权9.25。
交互扣分的实际证据：移动到第一项后原上移按钮变为disabled，浏览器焦点回到页面根，
不能将鼠标保存成功等同完整键盘验收。**decision: revise**，下一项限定修正是
ProtectionOrderEditor的边界移动焦点保留（implementation/components；依据主技能的
逻辑Tab顺序/键盘要求），以键盘将第二项移到第一项、末项边界及保存/取消回归验证。
本轮不以分数达到阈值掩盖此缺口，也不重开已完成的真实模型轮次。

## 2026-09-08 16:05 Policy 排序边界焦点修复

继续上一轮限定的 `revise`，只修改ProtectionOrderEditor及相关测试。首尾控件使用
aria-disabled并在事件处理器拒绝越界，使用户仍能聚焦并得知不可继续移动；React移动
列表节点后恢复原排序按钮的焦点。三种行操作显式type=button，不隐式提交外围form。
没有改变Policy/Rule执行语义、绑定对象或保存API。

- 新增4条测试修复前均失败：包括末位DOM移动失焦、边界状态及外围form误提交。
  修复后排序、已保存草稿、创建向导、绑定编辑、组合专项共47/47；类型检查、生产
  构建、git diff --check通过。现有大bundle警告仍保留；不是再次全量工程门禁。
- 真实构建 `index-DeVRE_Eg.js` 的只读浏览器代理：Tab定位第二项上移，Enter到第一项，
  再Enter保持不动且焦点仍在相同按钮；Tab反向恢复。末尾同样以键盘将第16项移至17，
  再Enter无越界，截图显示可见焦点框仍在末位下移按钮。取消正常关闭；代理
  rejectedWrites=0、forwardedPreviews=0，无保存或模型调用。
- Controller只使用 `ghcr.io/tasklattice/tali-guard-controller:dev`，已滚动主tali部署，
  Pod摘要为 `sha256:192216c50612f06e9549b0b6015372d7c00181f41abd7246f61d5abdb6a13e7e`。
  滚动完成后的首次健康读取503，随后同一部署08:05:16Z恢复healthy，没有重启重试。
  两个Runner收敛generation20，Default仍revision6/32项本地Policy/无模型依赖。
  临时代理与浏览器页均关闭，Git未提交。

Vibe Designing沿用上一轮已冻结的桌面排序限定门槛、六项子检查与20/20/15/25/15/5权重。
排序/版本、布局、显式草稿语义均保持；原交互1分由新鲜首尾键盘与取消证据提升为2。
六维10/10/10/10/10/10，限定路径10/10（+0.75），**decision: pass**，本轮单次修正结束。
这不是全产品UI分数；非空局部覆盖的浏览器保存、屏幕阅读器宣读及其他浏览器组合
未由此次证明。它也不补足未审核的独立真实模型效果集，不应继续用桌面微调替代该门槛。

## 2026-09-08 16:12 五套预配置的精确脱敏回归补齐

整体收尾审计发现：既有599条冻结预配置回放中的transform分支仅检查文本有变化，
272条Output分片检查则与同一实现的整段结果比较。这不能独立排除错误替换/误删内容。
现按固定Policy表达式和替换字符串编写10组静态完整文本期望，覆盖所有76条双向脱敏
用例；新增断言保证每条transform均有期望、每组同时包含Input/Output，未来新增用例
不能静默落回“文本变了”。分片结果也直接比对固定期望，而非只与当前整段执行互证。

| 预配置 | Policy数 | 回放用例 | 固定文本脱敏用例 | Output分片用例 |
| --- | ---: | ---: | ---: | ---: |
| Common baseline |16|91|14|40|
| Banking |17|103|14|46|
| Securities |18|115|14|52|
| Internet support |20|151|14|70|
| Singapore finance |20|139|20|64|

固定期望由已固定Policy的契约确定，未从测试返回值自动生成。保留原来的上下文型
护照整段替换及US电话前导加号语义，没有改库中Policy或调整模板来配合测试。
最初新增的整段allow断言误要求返回替换文本，5项失败；源码确认allow使用空texts
表示无需替换，修正测试契约后通过。不是修复了5个产品运行错误。

Default与五套预配置全部纳入护照/邮箱/支付卡的逐字符分片和UTF-8 TCP边界专项，
合计18组；此前遗漏的Common/Singapore两套已补入。实际执行：
`test_frozen_protection_presets.py`、`test_stage_a_pii_stream_boundaries.py`和
`test_test_suite_boundaries.py` 共 **31 passed**（67.38秒），保留NeMo弃用提示。
数据面仍只消费冻结签名产物，不调用Controller编译器/Validator；未重新生成产物。

离线核对`tali-litellm:dev`内全部5个Guard集成Python文件与兄弟Relay工作区一致，
镜像摘要仍`sha256:50b12c8bbaee16c0677b145bcbebd5198758e42ca8fe18ab6a6669ab562f0e60`。
08:11:10Z主tali健康，Default revision6、32项本地Policy、无模型依赖、两个Runner
收敛generation20。本轮只修改测试，不重部署、不新增真实API、不提交Git。

收尾阶段结论：代表性预配置、无模型Default、Input/Output及两类安全流式交付有工程
证据；独立模型质量验收仍不能签署。Topic真实服务与JailbreakDetect既有问题仍保留。
行业保护是边界明确的文本检测，不是完整银行合规、工具授权或所有攻击语义的保证。
完整缓冲会等整个回答检查后才释放；分段检查可提前释放已通过片段，但不能撤回先前
片段，也不承诺与整段语义检测等价。Default的完整值PII脱敏使用完整缓冲。

## 历史进展（以下保留各轮当时的结论）

**交付核对结论：主功能和已列工程主链路已有证据；全产品最终验收尚未通过。**
最新补验包括隔离Controller镜像部署、两个Runner各102个源码/资源文件逐项一致、
已部署向导参数恢复、保存网络中断后保留配置且只由手动重试创建一条草稿。
详情及保留测试资源见 [进度审计末尾](current-progress-audit-20260908.zh-CN.md)。

| 原定要求 | 已核对的交付证据 | 尚不能据此声称 |
| --- | --- | --- |
| 完整可选保护地图 | 8个业务分类、11步向导；实际浏览器选择/取消、依赖与审核提示 | 所有浏览器/读屏/故障组合均已验收 |
| 银行、证券、互联网预配置 | 5套真实版本化Policy模板；599条已部署继承测试；三行业各自最终代理回归 | 文本筛查等同于业务安全或监管认证 |
| 新加坡金融参考 | 独立模板及focused Policy、可见限制说明 | 覆盖全部MAS法规或金融决策 |
| Default无需外部模型 | 主Default修订6、32个完整Policy、483条执行及26个代理场景；无模型调用 | 本地模式能识别所有语义攻击 |
| Policy/Rule顺序和局部调整 | 控制面顺序/覆盖快照门禁、冻结产物的先脱敏后续检查、来源版本固定 | 全局按拒绝/脱敏强弱重新排序 |
| 控制面发布生命周期 | 编译前验证、签名、分发/ACK；晚到产物不覆盖新发布/回滚 | 验证标签能代表未测模型质量 |
| 数据面按编译产物执行 | 独立数据面测试、损坏代次拒绝与本地恢复；实际Runner源码匹配 | 已完成节点故障/所有生产拓扑演练 |
| Input/Output及Stream | 冻结产物、PII分片、Relay HTTP/SSE最终字节、取消/故障；限定真实SSE7/7 | 分段已放行前缀能撤回；真实低延迟收益已测得 |
| Relay修改边界 | TaskLattice Guard hook、streaming模块及其测试/说明；Dockerfile只增加overlay单测门禁 | 本任务改造了Relay其他Provider或业务模块 |
| 可观察的基础健康 | 按已发布plan检查方向/依赖，未知依赖不判定model-independent；Default健康已实测 | Provider Connected等于模型Callable或检测准确 |
| UI错误恢复 | 缺Topic参数可解释、补填恢复；实际断网保存失败后表单保留，恢复后无自动提交/重复草稿 | 已提交但响应丢失时具备自动exactly-once语义 |
| 真实模型独立质量 | 限额网关、固定身份、录制回放和holdout执行器具备；实际失败单列 | 未审核的集/阈值已通过；Topic或JailbreakDetect已通过 |

剩余交付边界：完整UI release-gate仍须保留未测的读屏/真实设备及错误组合，不把局部评分汇总成全局通过。
独立模型质量是需要用户输入的门槛：审核 [B阶段候选阈值](protection-acceptance-review.zh-CN.md)、
指定独立测试集及标签审核来源，再单独授权真实请求预算。已有开发样本和调试录制不能改名当盲测集。
Topic明确暂缓；JailbreakDetect正确调用路径下的漏检仍不合格，不通过降低门槛或让本地规则代答掩盖。
当前真实网关均0副本，既有预算轮次已结束。工程清单更新不意味着获得新的API授权。

**13:52 当前工作区完整工程回归通过**：`make test` 退出 0，1938 passed / 31 条件 skipped；
31 个条件项已另行在真实本地环境通过：Kubernetes 1、PostgreSQL 9、Redis 18、baked Relay 3。
PostgreSQL 本次随服务端 53 个文件共 526 项一起执行；不能将重复的服务端用例再次加到完整回归计数。
协议、冻结产物、Helm、类型检查与生产构建均通过，外部模型调用 0。
创建向导的模板反馈、窄屏当前步骤定位和关闭焦点返回已修复并完成局部真实浏览器验证，
这些最新 UI 源码修复已打包为独立 acceptance 镜像，并部署至 `tali-model-e2e` 隔离集群。
部署后页面资源哈希与镜像一致，Controller 与两个 Runner ready，配置和发布身份未改变，
无模型 Input/Output 正常与阻断烟测 4/4 通过。主环境未更新；本次不是完整浏览器交互重验。
详情见进度审计末尾的部署记录。

当前阶段：产品主体和本地工程回归完成，仍待最终部署工件核对、剩余 UI 验收及独立模型质量门槛。
后面的早期失败记录用于追溯，不覆盖此处的新结论；也不把限定真实烟测当成完整质量验收。

**后续限定真实 SSE 第二轮已通过 7/7**：正确 baked Relay 镜像、真实 DeepSeek 正常生成、
真实 NVIDIA 检测；NVIDIA 29/30、DeepSeek 3/3，未重试，临时网关已清理。
详见 [第二轮证据与边界](live-stream-proxy-round2-20260908.zh-CN.md)。它关闭限定场景的真实 SSE 缺口，
不代替模型质量基准、真实上游取消或全部 UI 验收；下述旧镜像失败记录保留为历史。

最新当前态核对见 [2026-09-08 13:15 进度审计](current-progress-audit-20260908.zh-CN.md)：
主集群 Default 483 项重新通过，模型调用 0；预配置与执行合同 59 项、预配置与健康接口 14 项通过。
目前处于产品主体已落地、真实模型端到端验收未完成阶段，不应将剩余项简化为只有 JailbreakDetect。

真实业务 SSE 回归发现旧 `tali-litellm:dev` 仍走逐片旧接口，完整缓存提前释放文本，
本轮失败。已补镜像一致性门禁和首个失败即停机制；正确 baked 镜像三模式及真实回答离线重放
各 3 项通过，但不能替代真实模型全链路验收。见 [SSE 实测记录](live-stream-proxy-20260908.zh-CN.md)。

用户后续已授权使用 DeepSeek 控制面、NVIDIA 数据面继续真实验证，并明确暂缓 NVIDIA Topic。
见 [非 Topic 实测](non-topic-live-progress-20260908.zh-CN.md) 和
[模型配置生命周期实测](model-configuration-lifecycle-20260908.zh-CN.md)。后者在独立 OrbStack 环境
完成 Save / Validate / Activate / Rollback、双 Runner 分发及 16 次实际执行核对；
本轮 36 次外部调用，Topic 0 次，结束后已关闭临时真实网关。
仍待完成外部代理与真实业务生成的多窗口 SSE 验收；JailbreakDetect 漏检仍未通过。
下文保留早期轮次记录及当时授权范围，不应作为当前任务授权或最新测试计数。

## 早期阶段记录

早期授权：复用隔离环境、Topic用Mock、暂不新增真实API调用。已整理
[待审核测试集与阈值建议](protection-acceptance-review.zh-CN.md)：24条候选样本，
展开128次本地执行，4个Topic场景、8组流式检查；只做了格式/数量/Mock对应检查，
未执行这份新候选集。真实模型质量门槛仍是建议，尚未获批或实测。

更新：用户已批准A并开始执行，旧的“未执行”状态由
[A阶段实测记录](protection-stage-a-results.zh-CN.md)取代。发布分发问题已修复；
候选128条、五套预配置599条、Default483次检查通过，银行最终客户端22场景通过。
A仍有全分片边界、Topic范围变更端到端等覆盖待补，不能宣布最终验收完成。

## 已具备的产品能力

| 要求 | 当前实现及边界 |
| --- | --- |
| 代表性预配置 | 通用基线、银行客服、证券经纪、互联网平台客服、新加坡金融参考，共5套；定义位于 `controller/shared/protection-presets.ts` |
| 通用保护自动带入 | 行业模板包含共同的凭据、个人信息、有害词语、提示攻击等本地 Policy 基线；用户仍可取消、排序、调整绑定 |
| Policy 是可观察的配置单元 | 模板引用固定版本的真实 Policy，不是把匿名 Rule 偷偷拼进 Guardrail；按 Policy/Rule 顺序执行 |
| Default 无外部模型依赖 | 已签名 Default 及5套模板在无模型配置下执行；真实模型漏检的同一条指令覆盖样本被本地规则拦住，正常对照放行 |
| Input / Output | 使用已编译执行产物及 NeMo 运行时；需要模型的检测只有显式配置和验证后才启用 |
| Stream | 已验证完整缓存、分段检查和可中断模式的执行路径；模式能力不能被解释为检测效果保证 |
| 模型响应回归 | 真实调用响应可离线回放。请求不匹配时明确失败，不偷偷调用真实模型 |

行业模板里的 suggestedTopics 是建议，不等同于已启用语义话题限制。
本地金融规则是基础文本防护，不等同于监管合规认证、投资适当性判断或交易授权。

## 两种 Streaming 行为的差别

- **检查后逐段放行**：每段检查通过才交付，首段延迟较低；后面发现问题时只能阻止后续输出，不能收回已经发出的前缀。需要专门验证跨段边界和上下文不足的情况。
- **完整缓存后放行**：先收齐整个答案，再检查或脱敏后交付；首字延迟更高，但能执行需要完整值或全文上下文的保护。

Default 及当前行业基线含完整值敏感信息处理，所以使用完整缓存。不能为了流式体验把这些保护无声降级成分段近似检测。

## 最近的实测证据

- 9月8日合并本轮新增内容后，完整 `make test` 退出0：1,881通过、31跳过；协议、签名产物、Helm、类型检查和生产构建通过。跳过项为Kubernetes 1、PostgreSQL 9、Redis 18、Relay镜像3；PostgreSQL 9项已在同日独立通过，其余隔离环境结果仍按原日期单独记录。
- 真实调用轮：23次外部请求，含目录读取、模型请求和调用方 SDK 重试；14次HTTP200、9次HTTP500，不等于23个独立质量测试样本。
- DeepSeek 基础调用通过；NVIDIA Content Safety 的 Input/Output 正常与攻击样本验证通过。
- Topic Control 返回服务端 TensorRT/CUDA HTTP500；JailbreakDetect 可调用但漏过当前指令覆盖攻击。两者均未冒充通过。
- 关闭真实调用后，Controller → Runner → NeMo 离线复现上述5项验证结果，外部计数未增加。
- 数据面回归369通过、18项Redis条件测试跳过；后续新增本地基线样本回归12通过；相关回放及分层检查合计28通过。数字属于各自记录的运行，不拼成一次全量结果。
- 新草稿 Save 的错误409已修复：使用数据库行版本替代有精度损失的时间戳比较。真实PostgreSQL回归6通过，相关服务/API测试49通过。
- 授权的 Topic Control Mock 已在隔离环境接通 Controller → Runner → NeMo，6次请求全部精确匹配，外部调用0；只修改该项绑定，未全局激活。新增10项 Mock/签名产物执行测试后，数据面整轮391通过、18项Redis条件测试跳过。
- 9月8日增加配置激活门禁后，真实PostgreSQL回归9通过，前后端类型检查通过。覆盖未通过项阻止全局激活、成功激活写入单条分发事件、顺序重复激活被拒绝，以及编辑验证快照后的新草稿必须重新验证；不代表并发激活竞态已验收。

## 尚不能签署最终验收的原因

1. 当前指定 Topic Control 服务不可用，不能测量其真实检测效果。已按用户授权接入独立 Mock，工程配置与执行链路回归不再等待该服务恢复。
2. 已观察到专用越狱模型漏检；本地规则拦截不代表该模型已经达标。
3. 尚未提供独立审核的正常/攻击测试集及每个类别、方向的误报/漏报通过阈值。现有烟测和开发集不能替代它。
4. 限定真实业务 SSE 第二轮已通过，但不覆盖所有真实生成/取消场景；最新 UI 修复的目标部署及最终运维交接仍需核对，不能由旧镜像或离线回放代替。

继续真实质量验收需要：可用的指定 Topic Control endpoint；审核人确认的测试集与阈值；若要替换模型或进行新一轮真实调用，明确对应端点和调用范围。密钥只放入既有安全配置，不放进文档或聊天记录。

在这些输入提供前，可继续用明确标记的 Mock 做工程回归；不重复消耗真实API、不放宽阈值、不删失败样本，也不宣布真实模型效果验收完成。

详细证据见 [实施记录](protection-productization.md)，重现命令见 [测试说明](testing.md)，完整验收流程见 [验收清单](protection-acceptance-runbook.md)。
