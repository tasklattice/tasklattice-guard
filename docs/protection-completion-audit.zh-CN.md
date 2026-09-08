# GuardRails 整体交付核对

日期：2026-09-08。目的：把原任务逐项对照当前实现，替代历史日志中未更新的笼统阻断；不替代真实运行报告，不扩大已批准的测试范围。

## 原任务与证据

### U1增量：已提交发布响应丢失后的幂等恢复（19:40）

真实PostgreSQL复现同一Policy草稿8个并发请求产生不同版本。现以`(policy_id, source_draft_revision)`唯一约束和Policy行锁保证一个草稿只发布一次；历史版本保留NULL，不猜测来源。UI发送已验证的draft revision；同一已发布草稿重试返回原快照，即使后来已有新编辑也不会误发新草稿；未发布的过期revision被拒绝。

数据库专项5/5、验证边界10/10、HTTP专项5/5；前端Studio/API/Library31/31。完整服务端518 passed / 18条件skipped，其中新增5个PostgreSQL条件项由真实数据库专项覆盖；不把跳过重复计为通过。类型检查、Controller生产构建、diff检查通过。

主`tali` Controller `ghcr.io/tasklattice/tali-guard-controller:dev` digest `sha256:cef90f0fabcb0c8e3fc8ecf12f1914437efa402800446621458f93aa57ed7112`，前端`index-CFhnnT8p.js`，迁移0005已生效。Controller ready、Runner预热2/2、generation30同步。没有改动Default、活动模型或Runner镜像。

1366×900真实桌面：新建临时本地Policy→真实Runner用例allow/58ms→发布提交成功后代理故意返回502→固定底栏显示“尚未确认发布结果”→Enter重试→打开已发布详情。两次POST均revision1；数据库只有version1和一个发布审计，checksum `33ae0b713517a19154234a1098a34a6b9db60bf0ad2aaac6e1006c03876ea285`。没有重新保存/验证或模型调用。提示y740–828，重试按钮44px、底部884，无横向溢出、浏览器error日志为空。代理仅允许这个命名的测试Policy，禁止模型API。

局部Vibe Designing沿用product-console/release_gate、权重20/20/15/25/15/5、8分无关键阻断门槛。Intent（状态/明确重试）、IA（固定反馈/步骤上下文）、Craft（既有组件/44px）、Trust（真实提交/同一快照）、Visual（现有风格/无裁切）子项均2，各10分；Interaction（真实键盘重试2、并发编辑仅服务与组件证据1）7.5；加权9.625，局部`pass`并停止修订，不签署完整U1。

临时Policy `policy-a3e82fcd-2d1c-45af-9a26-965409a8a1dc`已精确永久删除，发布/删除审计保留；临时数据库schema及端口转发、故障代理已清理。幂等性仅覆盖Policy发布，不宣称任意创建/保存exactly-once。模型轮次仍为NVIDIA73/100、DeepSeek13/100，Topic/Jailbreak排除，不继续消耗余额；未提交Git。

| 要求 | 当前实现、直接证据 | 判定 |
| --- | --- | --- |
| 银行、证券、互联网代表性预配置，含常用基础保护 | `controller/shared/protection-presets.ts`：通用16、银行17、证券18、互联网20、新加坡金融参考20项；共享16项基线，引用固定版本Policy，不复制匿名Rule。`test_protection_presets.py`检查真实组合，`test_frozen_protection_presets.py`经真实适配器回放599例及272例整段/分片Output对照 | 已实现并验证；新加坡金融文本参考不是MAS合规认证 |
| 完整可选保护地图，业务分类而非模型协议 | 八目录：内容安全、隐私、话题、指定内容、攻击滥用、代码应用注入、行业行为、回答可靠性。向导名称+八目录+交付+检查；预览与Apply状态已在主tali桌面核对 | 核心路径完成；完整桌面专项见未关闭项U1 |
| Policy/Rule顺序和局部调整 | `test_ordered_execution.py`、`test_catalog_rule_overrides.py`；已保存银行草稿实际排序、保存、刷新、数据库配置比较；前序reject停止，redact继续传递，来源Policy不被修改 | 核心顺序与覆盖链路已验证；不宣称任意高级编写组合都已浏览器验收 |
| Default无需外部模型 | `controller/server/domain/defaults.ts`保留32个普通Policy绑定，拒绝非local、模型依赖及未验证自定义Flow；正式签名产物483/483、模型调用0、123项精确输出 | 已实现并在主tali验证 |
| 控制面配置到编译产物再到数据面 | 验证快照、签名、分发、ACK、实际Integration/Deployment路由；扩展回归中DeepSeek辅助本地Policy生命周期18例，Safety正式链路6次真实调用 | 已验证，不依赖Mock冒充正式路由 |
| 控制面和数据面测试分开 | Makefile独立入口；数据面固定签名产物测试不调用Compiler/Validator；合同测试检查边界 | 已实现；当前完整门禁结果记录在交付状态页 |
| Input、Output、Streaming及1:1最终内容 | 扩展真实回归Input/Output48/48、三模式11/11；客户端文本与批准释放文本比较，正常文本与完整上游相等；取消、跨窗口风险、显式故障分别计数 | 当前配置与所列场景通过，不是所有模型/攻击效果保证 |
| Relay改动仅Guard Provider集成 | 当前兄弟工作区diff仅TaskLattice Guard hook、streaming模块及相关测试、说明、Docker安装行；没有通用Router修改 | 范围符合授权 |
| 平台健康反映基本可用性 | 当前Runner `/health/ready`显示预热2/2、Controller连接、desired state同步；默认保护的零模型证据与可选模型状态分开 | 正式部署就绪；health不证明被排除检测器的效果 |
| 本地tali、dev镜像、有限真实API调用 | 扩展轮NVIDIA73/100、DeepSeek13/100；Topic/Jailbreak未调用；项目镜像dev，临时测试工作负载缩容0 | 本轮执行并收尾；不继续消费剩余额度 |

详细运行证据：[扩展真实回归](tali-expanded-acceptance-20260908.zh-CN.md)、[主tali验收](tali-acceptance-20260908.zh-CN.md)、[交付状态及逐项历史](protection-release-status.zh-CN.md)。不同日期/候选上的测试结果不合并冒充一次执行。

### C1增量：动态Flow生命周期目标

同一个Policy-local helper，静态字符串目标可以执行，变量、字典取值和字符串插值三种目标在Input/Output下原先均失败关闭（修复前6失败、2静态通过）。Compiler v21在所属事件语句前求值并映射到当前Policy的Flow命名空间；接受本Policy已有的编译后ID，未知或其他Policy的字符串目标失败关闭。

不能把所有监听参数都当成字符串：NeMo允许正则对象。最终实现保留非字符串监听匹配器，覆盖`match`和`when`的真实正则监听；`list.pop()`目标也验证只求值一次。没有修改NeMo私有求值器，也没有把临时变量写回作者的业务变量。字符串仍不做全文替换。

本轮证据：符号相关86项通过；最终完整Python **1268 passed / 22环境条件skipped**，日志`/tmp/guard-dynamic-full-final.log`。19套固定签名产物新鲜度通过，新增`custom-dynamic-flow-events-v1`：两个Policy同名helper，按顺序redact→reject，独立数据面直接消费产物验证Input/Output及完整缓存HTTP分片，不调用编译器。六类事件的两种参数写法有解析/求值断言；不冒充每一种生命周期组合均已端到端验收。

Runner `dev`镜像在`--network none`环境中通过6项动态Input/Output检查；检查脚本`scripts/verify_dynamic_flow_runtime.py`使用独立进程内Preview，不修改线上产物或模型绑定。全部本地检查新增真实API调用0。

主`tali`两台Runner已更新为`ghcr.io/tasklattice/tali-guard-runner:dev`，实际digest `sha256:2e83d2053a0de942ae356df1e7c8678d8bf2c0b30074cf8d4d7328feca2bae4a`；两台容器内各6/6通过，预热2/2、generation30同步。正式Default再回放483/483、123项精确输出、模型调用0；draft revision6、版本`20260908-024342.826Z`、artifact `ac1c751e-31b2-4d92-8b95-7edf06946919`及两项checksum均不变。活动模型配置仍为revision3 (`494e5fe1-132a-4b10-bc46-2295b0a881fa`)。Controller未重建，Topic Mock未改动，未提交Git。

**C1仍未整体关闭**：任意事件对象分发、动态Action/模型依赖及高级监听时序不是这组测试的覆盖承诺。正则监听保留NeMo语义，并非跨Policy事件可见性的安全沙箱。U1合并桌面门禁、Q1独立审核质量集与阈值也不由这次编译修复替代。

### U1增量：已发布但详情加载失败

本轮从实际代码确认：Policy Studio把发布写请求与`onSaved`中的详情读取放在同一个mutation成功回调；读取失败会进入发布错误处理，发布按钮重新可用。后端`publishPolicy`每次分配新版本，不能把这类错误当作发布失败后盲目重试。新增组件回归先1失败/14通过，修复后相关4文件28/28，类型检查和最终Controller生产镜像构建通过。

现在明确保存服务端确认的已发布ID/版本；后续加载是独立操作。读取失败时只提供“打开已发布版本”，不会调用发布、创建或更新API。编辑器保持只读，关闭后旧读取不能导航新的会话；Policy Library只有成功读取且会话仍有效时才切换详情。首次浏览器检查发现提示位于已滚走的正文上方，因此第二次修订把成功与恢复说明移到固定底栏，并移除“现在可以发布”的过期提示。

真实路径经过限定代理访问主`tali`：仅允许具名本地测试Policy、两项本地Action、真实校验，以及一次发布；所有模型和其他写接口被拒绝。代理只在**真实发布201已返回后**令详情GET失败，不伪造发布或validation通过结果。两次桌面检查各发布1个未绑定临时Policy；每轮详情失败2次、恢复GET1次，发布POST始终1次，没有被拒绝的第二次写请求。最终通过后端`published_versions`与`implementation_detail.versions`确认仅版本1。

最终1366×900截图/DOM：底栏状态位于y738–828完整可见；关闭和打开按钮均44px高；document scrollWidth为1366，无横向溢出，console error为空。Enter触发“打开已发布版本”后进入真实详情，焦点在关闭按钮且focus-visible=true。资产`index-Dyfqjo53.js`。最终构建digest为`sha256:ba38b0261c8170b70a93047c2863c9a5e9b75161035d12b07adcc8f009be308e`；结束时其他工作更新了移动`dev`标签，当前运行digest为`sha256:932b199e37badb18afcb2412fafb8930996f5c5a1fe7ca909a27d7e43a0544f1`，主服务仍提供相同`index-Dyfqjo53.js`，未用旧镜像覆盖并行工作。Runner仍为v21的`2e83d2…`、预热2/2、generation30同步。

Vibe Designing局部product-console/release_gate沿用20/20/15/25/15/5权重、门槛8且不允许关键路径阻断。Intent（正确状态/只读恢复）、IA（步骤上下文/底栏可见）、Craft（现成组件/44px）、Trust（后端版本证据/不重发写入）、Visual（现有风格/无裁切）各两个子项均2，得分各10；Interaction的真实恢复2、关闭后晚到读取仅组件证据1，得分7.5。加权9.625，局部`pass`，停止修订。首轮截图实际1280×720，最终1366×900，不计算跨视口的分数增量，也不冒充完整桌面门禁已通过。

临时Policy `policy-7a3a1b7a-ac84-4fdf-ba5d-77383bbfee5f`、`policy-84287719-34f0-4073-a335-9dead3373a20`均经UI确认永久删除，前者另有API404、后者有最终目录/对话框清空证据；其草稿、版本和验证历史不可从UI恢复，删除审计保留。两轮代理和测试页均关闭、viewport恢复。新增真实模型调用0、未提交Git；没有重跑或重发布Default。

| 桌面证据项 | 当前范围 | 仍未覆盖 |
| --- | --- | --- |
| 向导、保护地图、预配置、Policy/Rule排序与覆盖 | 前述逐项页面及组件记录 | 全页统一桌面状态矩阵仍未签署 |
| Policy Studio目录故障、验证竞态、关闭焦点 | 前述局部部署和浏览器证据 | 各高级组合不能只由局部组件通过推断 |
| 发布明确成功，详情读失败后恢复 | 本轮真实写入/读取/键盘恢复和28项相关回归 | 超长错误、其他桌面尺寸本轮未重验 |
| **发布写响应本身丢失，提交结果不确定** | 后端每次调用创建版本；本轮没有注入该故障 | 需独立验证和恢复设计，不能用“明确成功后读失败”代替 |

因此U1、C1、Q1仍开放；本轮关闭的是一个具体状态误报与重复发布入口，不是所有发布网络故障。

## Streaming的实际区别

- **检查后逐段放行（window buffered）**：一个窗口通过才释放，后续发现问题立即停止；已经释放的前缀不能撤回，也不能保证与整篇判断完全等价。
- **完整缓存（full buffered）**：等待完整回答，检查和脱敏后才交付，首字延迟更长，但阻断时不会先泄露前缀。
- Default和这些行业预配置包含完整值PII脱敏，因此实际选择完整缓存。不能为了表现为流式而移除PII保护。独立支持增量检查的配置才逐段交付。

## 尚未关闭的整体合同项

桌面项现有逐页状态矩阵：[桌面验收合并矩阵](protection-desktop-acceptance-matrix.zh-CN.md)。2026-09-08 19:44当前前端全量280通过/1失败，失败是另一个任务正在重设计的Policy筛选与旧集合断言冲突；不得继续引用之前的全绿为当前工作区结论。发布响应丢失路径已由本文最新增量验证，下面历史表中的“尚未验证”不再代表当前状态。

以下是明确的证据缺口，不等同于已经复现的产品缺陷，也不因局部测试通过而自动关闭。

| ID | 未关闭项 | 已经证明什么 | 还缺什么才可关闭 |
| --- | --- | --- | --- |
| C1 | 任意自定义Flow的依赖完整性 | 静态源引用、符号链接、选中Policy独占依赖、按方向的已声明模型依赖、Action失败关闭均有Compiler/Validator/固定产物测试；Health对任意Flow仍保留unknown，不伪称model-free | 动态表达式/事件分发的完整依赖保证没有证据。必须继续核对支持边界和执行行为；不能把“未知”标签当作完整依赖验证，也不能偷偷禁止已有高级能力来缩小目标 |
| U1 | 完整桌面发布门禁 | 主创建/保存/排序/刷新、预览与Apply、目录延迟、权限丢失、离线、保存结果不确定都有分别注明范围的测试或浏览器证据 | 按设计合同逐项合并默认/加载/空/错误/恢复/键盘/溢出及高级编写路径，标明哪些只有组件测试；现有局部10分不是全产品release_gate签署。移动端不纳入 |
| Q1 | 独立模型效果验收 | 真实Safety开发集48/48，调用/版本/方向/故障分类证据齐全；独立holdout执行器及报告测试已实现 | 没有独立审核集及其审核人、版本、每类每方向的已审核标签/阈值。`protection-acceptance-review.zh-CN.md`中的B只是建议，批准A和100次调用不等于批准B；不得伪造审核或把调试集改名为独立集 |

Topic服务故障与JailbreakDetect已知漏检为用户明确排除项，独立列示，不以本地规则替代后记通过。Retrieval、Dialog、真实工具授权和移动端不在本期承诺中。旧匿名草稿迁移不是恢复兼容的授权：用户明确允许破坏性更新、不要求兼容。

当前阶段是**主体实施和限定真实回归已完成，整体合同核对仍开放**。本表保留C1/U1/Q1，不把总体目标标记完成；下一步应针对这些具体证据缺口工作，而不是重复模型额度确认、重新做已通过模板或反复报告同一个健康状态。

### C1增量：Action启动事件依赖检查

后续源码核查复现 `send Start…Action` 绕过Policy的Action声明检查（包括未执行分支、and/or事件组合）。现使用NeMo解析后的语法树，把发送Action启动事件纳入同一Policy的版本化依赖门禁；单纯match监听不算调用。合法声明不被禁用，依赖保留在签名manifest中；Input/Output的Validator均在缺少Provider时拒绝，即使测试分支不会执行该事件。

编译器更新为`tasklattice-nemo-config-v19-action-event-dependencies`，17套固定签名测试产物重新生成并通过新鲜度检查。完整Python回归1205 passed / 22环境条件skipped；没有把上一轮Controller/UI测试重算为本轮执行。

Runner dev已部署到主tali两副本，digest `sha256:e76b333621cc8d5b1bae26c88bde9ad9a9c8c6a466e84ed6af01e57f28b67e8f`。部署内编译检查确认拒绝未声明事件、保留合法版本依赖；首次检查脚本误用了非规范Guardrail版本字符串，在进入源检查前被拒绝，改为规范时间戳后完成，未涉及发布或模型调用。

新镜像执行原Default签名产物483/483，模型调用0、精确输出123项；草稿revision6、发布版本`20260908-024342.826Z`、artifact `ac1c751e-31b2-4d92-8b95-7edf06946919`及活动模型revision3均未变，Runner预热2/2、generation30同步。此修复关闭静态命名Action启动事件的声明绕过，不宣称完成任意动态表达式/Flow事件分发的依赖分析；C1仍开放。

### U1增量：Rule继承动作显示

1366×900主tali桌面复现：Singapore financial reference中Passport Policy覆盖为reject后，无局部覆盖的Rule仍显示redact；下拉框的默认redact与显式redact无法区分。执行计划本身优先级正确，问题在编辑器的显示。

修复后默认选项显示`默认 · redact`，Policy覆盖后显示`继承 · reject`，显式Rule覆盖显示其独立动作；恢复继承只清除Rule覆盖，不改Policy覆盖。词语逐项动作同样服从Policy覆盖。没有修改执行优先级或可选动作集合。

5个相关测试文件66/66通过，类型检查及生产构建通过（保留既有bundle体积警告）。新增Radix选项交互测试首次因jsdom缺少scrollIntoView失败，补充可恢复的布局API桩后通过；这属于测试环境，不冒充产品缺陷。此前未带jsdom的测试调用未收集UI用例，也不计入成功证据。

Controller `dev`已更新到主tali，Pod imageID为`sha256:2775d9b0b8ede0dcbbe04d36612697fc87aed839ac8ebc1791b9da5025342c83`，页面加载`index-CbwDsXU_.js`。新鲜浏览器证据覆盖默认→Policy覆盖→显式Rule覆盖→恢复继承→清除Policy覆盖、Escape关闭并返回触发器焦点；文档宽度/滚动宽度均1366、无console error，标签未裁切。检查页仍显示20项Policy、50条Rule、完整缓冲，明确只创建草稿而非发布。未保存测试表单，测试tab已关闭、viewport恢复；Runner预热2/2、generation30保持同步。

本次没有模型调用、没有Git提交，也未重复完整Default或全工程回归。此局部修复通过不关闭完整桌面U1；独立模型质量Q1和动态依赖C1仍保留原边界。

### C1增量：Flow生命周期事件的静态目标

源码与NeMo实际语法树核查发现，普通Flow调用已做Policy局部名称映射，但`StartFlow(flow_id="helper")`等事件里的字符串目标没有映射，也没有检查是否由当前Policy声明。新增六种生命周期事件的未声明目标用例，修复前全部未抛预期编译错误。

现在StartFlow、StopFlow、FinishFlow、FlowStarted、FlowFinished和FlowFailed中的静态flow_id与普通Flow引用使用同一声明边界和独立名称空间；同时支持括号参数与简式命名参数。业务字符串不改写，其他Policy的同名/独有helper不能成为当前Policy的依赖。动态表达式和插值不被误当作静态常量，也未以禁用动态能力来冒充完整支持。

编译器为`tasklattice-nemo-config-v20-flow-event-symbols`。18套固定产物已生成并通过新鲜度检查，其中新增`custom-flow-events-v1`：两个Policy具有同名helper，前一个redact、后一个reject。控制面真实NeMo编译执行和数据面独立签名产物的Input/Output、完整缓冲HTTP流均通过。相关110项通过，完整Python1234 passed / 22环境条件skipped（190.36秒）；Controller/UI未修改，不把上一轮UI测试计为本轮执行。

部署内验证使用本地Action，不调用外部模型：实际Runner容器中Input/Output事件helper均执行并记录正确Policy归属。最初运行用例缺少NeMo要求的flow_instance_uid，在目标映射修复后暴露该测试构造错误；补充uid()后通过，不能把这个参数错误记为产品缺陷。不存在静态目标的编译负例与参数错误无关。

主tali两台Runner均使用`ghcr.io/tasklattice/tali-guard-runner:dev`，imageID为`sha256:2d45841ab87112022860a06ebb02dbb86c03b80f8ed2ad06fcf3a29e3810d6f4`；预热2/2、generation30同步。该补充只关闭明确静态Flow事件引用遗漏，**C1对任意动态表达式和事件对象分发的完整保证仍未关闭**。未新增真实API调用，未提交Git。

更新后原Default正式产物再次回放483/483（321继承、140固定旧行为、22补充），123项精确输出、模型调用0。draft revision6、版本`20260908-024342.826Z`、artifact `ac1c751e-31b2-4d92-8b95-7edf06946919`、产物和运行配置checksum均保持不变；本轮未重发布Default，也未调整活动模型绑定。

### U1增量：Policy Studio验证快照与会话隔离

组件测试先复现两项真实问题：验证期间修改表单后，旧通过结果仍能显示发布；保存过程中关闭重开，旧Policy ID与后续验证可能污染新编辑器。修复通过编辑revision和会话token区分异步结果；关闭/重开后的旧成功与失败均忽略。同一会话保留已经保存的ID，重验更新原草稿而非重复创建。发布请求期间冻结表单，晚到的发布结果不导航新编辑器。

新增6项回归（包含成功/失败参数化），Policy Studio共10/10；Controller/UI完整787 passed / 13环境条件skipped，类型检查与生产构建通过。测试中补充act以明确等待异步回调，不把测试刷新时序当作产品缺陷。保留现有Node与bundle体积警告。没有重跑Python或把前轮1234项计入本轮。

主tali Controller `dev`镜像已更新并就绪，digest `sha256:52188f7849d04a51d8a79c79b4f78450a24e2a42f63bdbefc9ee91d881daf8ee`，实际页面加载`index-CfLQzCUn.js`。1366×900桌面通过本地故障代理访问实际部署；代理只允许具名测试Policy的本地Action保存/验证，拒绝模型和发布写请求，只延迟真实验证响应，不伪造passed。

真实路径：提交`Hello before editing`→结果返回前改成`Hello after editing`→释放旧结果→显示“配置在验证期间发生了变化”，修改保留、没有发布按钮→显式重验→实际Runner执行revision2通过并显示发布按钮。API确认run `policy-validation-33c536b6-f160-475b-9fa9-357f97246907`的draft_revision为2、status passed；发布版本数为0。没有点击发布。文档宽度/滚动宽度均1366，无console error，正文与固定底栏无横向裁切。

测试Policy `policy-13d7a96b-bbbf-4cf6-b57b-dd3f761498fb`核对名称和未发布后已硬删除（不可从UI恢复，删除审计保留）；代理进程和测试页已关闭，viewport恢复。正式Default、模型绑定和Runner镜像没有改变；零真实API调用、未提交Git。

| 桌面状态/路径 | 本次证据 | 判定/剩余边界 |
| --- | --- | --- |
| 初始表单、加载、编辑、底部操作与溢出 | 1366×900实际页面截图、DOM宽度、控制台 | 该窗口通过；不代表所有编辑路径 |
| 保存失败、字段/目录呈现 | Policy Studio已有4项组件回归 | 自动化证据，不冒充本次真实网络失败 |
| 验证中编辑、旧成功/失败、显式恢复 | 参数化组件测试；真实旧成功延迟与revision2重验 | 该竞态关闭；真实旧失败本轮未注入 |
| 关闭重开后的保存/验证成功与失败 | 组件测试；真实UI仅验证普通关闭 | 会话隔离有自动化证据，不冒充全部浏览器竞态覆盖 |
| 发布期间冻结、晚返回不导航新编辑器 | 组件测试 | 本轮禁止实际发布，未做真实发布网络故障 |
| Escape关闭后焦点返回 | 新鲜真实DOM检查：activeElement为BODY | **未通过**；缺少Policy Studio实际触发器的焦点恢复，不能用EntitySheet独立测试替代 |
| 其他创建/保存不确定/权限/离线/排序 | 前述各轮注明范围的浏览器与组件记录 | 尚需完整合并逐页矩阵，U1仍开放 |

Vibe Designing采用既有product console/release_gate合同，本轮只修验证证据状态，未重画界面。领域正确性恢复已验证，但键盘关闭路径未通过，因此不签署整体release_gate，也不以局部测试数量计算全产品高分。下一步是补齐实际Policy Studio触发器的焦点恢复并复核，而不是重复消费模型额度。

C1动态边界核查：当前Registry已按签名产物固定的Provider refs筛选，并非全量注册；NeMo支持运行时Event/Flow对象及变量式事件目标，这些不能由静态字符串扫描完整推出。未偷偷禁用动态能力、未修改NeMo私有求值器，C1继续保留。Q1仍需要独立审核数据/标签/阈值；此次UI工作不改变其状态。

### U1增量：Policy Studio实际入口焦点恢复

前一轮为进展而非停滞：验证快照修复已部署，真实桌面发现关闭后activeElement为BODY。本轮重新核对代码和旧部署`index-CfLQzCUn.js`，该问题仍存在；新的页面级测试在修复前3/3失败，失败点均为关闭后焦点不是原入口。

原因是受控Policy Studio没有Radix Trigger，也没有传入EntitySheet已有的returnFocusRef；macOS鼠标点击不保证按钮先获得焦点。现在由Policy Library在新建、导入和编辑事件中记录event.currentTarget，Policy Studio转交该ref给EntitySheet。导入返回可见按钮而非隐藏file input；嵌套编辑返回仍存在的Policy详情“编辑”按钮。保留EntitySheet对已移除/禁用入口的检查，不引入全局自动聚焦或改变发布流程。

新增页面级4项：三种关闭方式逐一验证新建/导入入口；另验证嵌套编辑关闭后焦点回到下层详情。4个相关文件23/23通过（包含前轮10项验证会话/草稿测试和EntitySheet移除入口负例）；类型检查及生产构建通过，保留既有Node与bundle警告。日志`/tmp/guard-policy-focus-before.log`、`/tmp/guard-policy-focus-after.log`、`/tmp/guard-policy-focus-build.log`。未重跑完整Python/Controller测试，不将历史数量冒充本次执行。

主tali Controller `dev`已rollout完成，imageID `sha256:1fcc080ee4c9c9f3a569b2f6b2e15860f1405459dbd9978af582a32dfe326e9a`，实际加载`index-DZLEaHGZ.js`。1366×900真实浏览器：新建→填写临时名称和用途→下一步运行配置→Escape→焦点回到新建；Enter重新打开空白新表单；右上角关闭、取消也分别返回入口。关闭/取消目标分别44×44、62×44，focus-visible为true；抽屉scrollWidth1366、视口1366，无横向溢出及console error。导入文件和嵌套编辑仅有组件测试，本轮不增加真实上传或存储操作。测试页关闭、视口恢复，未调用模型、未改变Default/模型绑定/Runner、未提交Git。

局部Vibe Designing评估冻结为product console/release_gate，目标是作者可靠地打开/退出Studio并继续键盘操作；仅调整入口焦点，预算一轮，门槛8且不能有该关键路径阻断。沿用维度权重20/20/15/25/15/5。以下0–2子项来自源码、组件测试及新鲜截图/DOM，不用于给整个U1评分。

| 维度 | 子项与证据（各0–2） | 得分 |
| --- | --- | --- |
| Intent | 明确新建入口2；退出回到原任务2（实际页面） | 10 |
| IA | 三步层次保留2；详情/编辑上下文保留2（组件） | 10 |
| Craft | 复用现有Sheet机制2；44px关闭控件与可见焦点2（DOM/截图） | 10 |
| Trust | 未改变保存/发布语义2（diff+竞态测试）；不聚焦已移除入口2（组件） | 10 |
| Interaction | 实际新建关闭/取消/Escape/Enter恢复2；导入与嵌套编辑1（组件通过、无本轮真实浏览器证据） | 7.5 |
| Visual | 既有样式/密度保持2；1366桌面无裁切2（截图） | 10 |

加权9.625；基线关闭恢复子项0、导入/编辑子项0，对应8.5但有关键路径阻断。修复增量+1.125，局部决策`pass`，停止本轮修订。**这不是完整桌面U1签署**：需继续合并高级编写/发布网络故障与各页矩阵；C1/Q1边界不变。

### U1增量：Action目录失败与空状态分离

上一轮焦点修复已完成，属于有进展。本轮继续检查高级创建的异步依赖状态，发现`actionsQuery.data?.items ?? []`只配合loading渲染：请求失败后成为空白列表，没有失败提示或重试入口。修复前新增失败/空状态两项测试均失败；实际旧部署经只读代理返回503时也仅有空白列表和“已选择2个”，不是推测。

修复在折叠区外显示失败提示及显式重试，说明已选依赖/编辑保留、服务端发布验证仍必要。初始加载以status播报；离线暂停显示等待连接，不冒充空目录；只有成功空响应显示未注册说明。失败后有缓存时保留原列表和选中版本，刷新不重置表单，也不替换已固定版本。重试按钮最小44px高，复用现有Alert/Button；后端、编译器和执行语义未改。

新增4项覆盖初始失败→等待重试→成功且保存payload仍包含原引用、成功空目录、缓存刷新失败、初始离线→联网恢复。4个相关文件27/27通过，类型检查通过；最终Docker构建包含UI类型检查和UI/服务端生产构建，通过。首次准备镜像后补齐44px按钮及离线暂停状态，最终以以下digest和新鲜浏览器证据为准，中间镜像不算最终验收。日志`/tmp/guard-action-catalog-before.log`、`/tmp/guard-action-catalog-after.log`、`/tmp/guard-action-catalog-image-final.log`。保留既有Node/bundle警告，未重跑全工程或Python测试。

主tali Controller `dev`已rollout完成，imageID `sha256:1997fc7c59774af198aff939dea1583d61a40505ca40597a0fa14bc8c3f35a62`，页面`index-8P9Ghbkx.js`。只读代理`serve_action_catalog_ui_proxy.mjs`对Action查询注入503，SIGUSR1恢复真实tali读取；所有非GET/HEAD请求拒绝，已用POST负例验证403。最终计数失败读取3次（含旧页面基线）、恢复读取1次、被拒写入1次；没有转发写请求，也没有模型调用。

实际1366×900路径：新建→填写临时名称/用途→运行配置→折叠依赖区外可见失败提示→重试读取真实目录→12项Action呈现，其中原有GuardCustomerIdentifierAction/GuardRecordPolicyAction@1.0.0仍选中→上一页的名称和用途未变→Escape焦点回新建入口。重试按钮可用且44px高，页面/抽屉无横向溢出，console error列表为空。未保存、验证或发布测试Policy；测试tab、代理均关闭，viewport已恢复。Default、活动模型配置与Runner未改变，无Git提交。

| 该异步路径状态 | 当前证据 |
| --- | --- |
| 正常目录、失败、显式恢复、选中版本/表单保留 | 新鲜主部署页面截图与实际GET链路 |
| 加载中避免重复重试 | 延迟Promise组件测试 |
| 初始离线/联网恢复 | onlineManager组件测试，未模拟真实操作系统断网 |
| 成功空目录、缓存后台刷新失败 | 组件测试，未修改正式Action注册表 |
| 验证/发布仍校验实际依赖 | 本轮不修改后端；既有验证回归继续通过，不冒充新模型效果证据 |

局部Vibe Designing合同沿用product console/release_gate及20/20/15/25/15/5权重、8分无阻断门槛；目标仅为作者正确识别目录状态并恢复，最多两次修订，禁止改写依赖或执行规则。子项按0–2：Intent（错误可理解2、恢复动作2），IA（错误不藏在折叠区2、原分组2），Craft（既有组件2、44px及布局2），Trust（失败不等于空2、引用/编辑保留2），Interaction（真实503恢复2、离线/缓存仅组件1），Visual（既有样式2、无裁切2）。得分10/10/10/10/7.5/10，加权9.625；基线Trust与Interaction的对应错误/恢复子项为0并有阻断。局部决策`pass`，不签署完整桌面U1，且不改变C1动态依赖和Q1独立审核数据的缺口。
