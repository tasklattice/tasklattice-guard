# Traffic Router Detail：实现与验收

更新：2026-09-12。对齐 Router Detail 重构要求及追加的「Revision 使用 GuardRails 时间戳设计」。领域模型见 [Router / Route 分发设计](router-route-weighted-distribution-design.zh-CN.md)。

## 设计契约

这是面向管理员的产品控制台。首屏任务是理解来源 Endpoint、顺序匹配的 Route、目标 GuardRail 及固定版本。沿用原 Shell、字体、颜色、Tabs、Sheet、表单和图标组件。

- Router 接收多个 Endpoint；一个 Endpoint 同时只属于一个 Router。所有来源共用有序规则集。
- 首条匹配规则确定目标集合，再按百分比选中唯一 GuardRail；一个请求不会复制到多个目标。Selector 保持原表达式语义，支持特征条件，不局限于灰度。
- Fallback 固定最后，无条件、不编号、不可排序/删除，只有一个 100% 目标。
- GuardRail Duplicate 属于 GuardRail 创建交互，只复制配置，不复制运行时数据或绑定。Routing 不提供 Duplicate 入口。

## 页面交互

| 区域 | 最终交互 |
| --- | --- |
| Header | 名称、真实分发状态、来源/规则/目标数量，Edit routing 与更多操作 |
| Overview | 默认 Tab；三列 CSS Grid + ResizeObserver 测量的 SVG 连线，百分比与固定版本，Fallback 独立虚线行 |
| Endpoints | 真实状态表格、详情导航、可搜索的绑定侧栏、解绑确认；禁止抢占其他 Router 的 Endpoint |
| Routing | 默认只读；展开条目只展示 Selector → GuardRails 图示；新增/编辑使用右侧 Sheet，复用 Selector/Targets，规则内错误，dnd-kit 指针/键盘排序、行尾省略号操作菜单 |
| Revisions | 历史列表与只读侧栏，时间/发布人、diff、发布时 Endpoint 快照和固定目标版本；Restore 创建草稿 |

Overview 下保留四项轻量配置摘要；真实分发统计移入独立 Monitoring Tab。没有遥测时显示未知/无数据，不制造指标。节点使用真实详情路由；规则节点切换并展开 Routing。窄屏保留三列关系，只在拓扑/表格局部横向滚动。

流程统一为 **Edit routing → Review changes → Publish revision**。Review 时保存本地草稿并获取发布预览；没有 Save rules / Publish configuration 两级主操作。取消、冲突和失败保留当前编辑上下文；后台刷新失败不会卸载工作区丢掉草稿。

## 时间戳与版本契约

详情页 Header、Overview、Revisions、恢复确认、分发版本选择使用 `YYYYMMDD-HHmmss.SSSZ`，例如 `20260912-085454.607Z`。复用 GuardRail 的 `guardrailVersionId` 格式化实现，以不可变 `createdAt` 生成 UTC 标识，同时展示本地发布时间。

数据库/API 的数值 revision 仍作为排序、并发控制、恢复和日志关联键。时间戳是展示标识，不作为唯一数据库键；数据缺失显示「—」，不以当前时间代替历史时间。

1. Draft target 增加可选 `versionStrategy: latest | pinned`。新增目标默认 Latest when published，旧的明确版本按 pinned 解释。
2. `POST /api/v1/routers/:id/preview` 校验 draftRevision，解析可用最新已发布 GuardRail，返回固定快照与 Endpoint 集合。
3. Publish 提交 `reviewedSnapshot` / `reviewedEndpointIds`。事务再次解析对比；版本或绑定漂移时拒绝并要求重审。重试沿用同一 idempotency key。
4. Revision / activeSnapshot 只保存固定版本；草稿保留 latest/pinned 意图。GuardRail 后续发布不改变旧 Router Revision。
5. 迁移 `0010_router_revision_context.sql` 记录发布时 Endpoint ID/名称/适配器及 GuardRail ID/名称/版本。旧空上下文保持为空，明确提示无法提供历史来源。
6. Endpoint 绑定独立生效并记录审计。Restore 仅把旧路由复制为新草稿，保留当前 Endpoint 绑定；Review / Publish 生成新 revision，旧 revision 不变。

发布成功不等于 Runner 已应用；Active 依据真实 rolloutStatus。等待时显示 Distributing/Deploying。

Revision 描述当时**可能的路由决策**。某请求实际命中了哪个 Route、最终进入哪个 GuardRail/version，需要查该请求的 Runtime routing decision 日志。静态配置无法推断随机分配结果；发布时 Endpoint 快照不能替代后续绑定审计。

## 工程边界

`router-detail.tsx` 负责查询、编辑生命周期、发布和 Tab 协调；Overview、Endpoints、Routing、Revisions、Review Sheet 及摘要/diff 拆成同目录组件。复用现有 Selector、TargetsEditor、EntitySheet 和真实 API，不创建第二套条件模型或自由画布。

六阶段均已实现：信息架构、拓扑、Endpoints、Routing 编辑、Review/版本固定、Revision/Restore。以下是实际检查记录，不将最终检查冒充逐阶段独立检查。

## 验证与证据

- 全量 Vitest：122 文件通过、5 文件跳过；947 项通过、53 项跳过。
- 独立真实 PostgreSQL 路由服务测试：24 项通过，覆盖预览、版本固定、发布冲突及不可变历史。
- 最终相关回归：5 文件、260 项通过，覆盖工作区、Endpoint、共享模型、HTTP、权限。
- `npm run typecheck` 和前后端 `npm run build` 通过。项目没有 lint script；未声称执行不存在的 lint。构建保留 bundle 大小提示。
- 浏览器连接真实配置的隔离数据库副本，无 UI mock。已验证条件规则、90/10 双目标、Review/Publish、历史详情、Restore 后产生新版本。
- 已操作 Endpoint 详情、搜索绑定与确认解绑、规则跳转、复制 Route、键盘调整顺序及取消未保存编辑。Fallback 始终固定最后。
- 1440×1000 桌面、390×844 窄屏检查：窄屏文档宽 375px、视口 390px；拓扑局部宽 307px、内容宽 880px，未撑宽整页。

截图：

- [桌面 Overview](evidence/router-detail-20260912/overview-desktop.png)
- [窄屏 Overview](evidence/router-detail-20260912/overview-mobile.png)
- [规则编辑](evidence/router-detail-20260912/routing-edit.png)
- [复制与排序](evidence/router-detail-20260912/routing-reorder.png)
- [Review](evidence/router-detail-20260912/review-publish.png)
- [时间戳历史列表](evidence/router-detail-20260912/revisions-timestamps.png)
- [历史详情](evidence/router-detail-20260912/revision-detail.png)

早期 Review/详情截图保留当时状态；版本标识以最新时间戳列表截图为准。

## Vibe Designing 验收

采用 Product Console 权重、prototype 路径验收；使用真实副本/API。各子检查 0–2 分，证据在前，评分在后。

| 维度 | 子检查证据与扣分 | 原始分 | 维度分 | 权重 |
| --- | --- | --- | --- | --- |
| Product Intent | 流向、主操作、来源与规则语义可见 | 6/6 | 10 | 22% |
| Information Architecture | 四个 Tab、折叠编辑、独立 Fallback | 6/6 | 10 | 22% |
| System Craft | 沿用组件样式、局部滚动通过；窄屏表格仍需横向阅读 | 5/6 | 8.33 | 14% |
| Trust & Domain Fit | 固定版本、真实历史、未知状态；未接 Runner 验证运行态 | 5/6 | 8.33 | 18% |
| Interaction Readiness | 绑定/发布/恢复、键盘排序、失败保留测试通过；浏览器未覆盖全部故障组合 | 7/8 | 8.75 | 16% |
| Visual & Brand | 原字体/色彩、拓扑主视觉与轻量层次 | 4/4 | 10 | 8% |

加权约 9.27/10，已验证主流程无阻断。生产 release gate 仍需部署后确认 Runner 实际请求执行、遥测回流与 Active 收敛，不能用副本中的发布成功代替。

`38184` 是隔离预览，`38081` 尚未部署本次修改；未提交 Git 或修改现网路由。

## Route 编辑交互补充（2026-09-12）

按最新反馈，Route 的表单从列表内移至右侧 Sheet：顶部名称与 Traffic Selector，下面为 GuardRails 目标列表。新增/复制先作为侧栏本地配置，确认 Add rule 后加入 Router 草稿；编辑 Apply changes 更新草稿；取消不留下空条目，也不改动原规则。配置错误在侧栏提示并阻止提交。

列表展开区域只读展示流量表达式 → 各目标及其比例/版本，编辑入口打开同一侧栏。Fallback 保持不可删除、不可排序和一个 100% 目标。Review / Publish 与运行时执行语义不变。

已通过浏览器真实 API 选择双目标并以 70/30 添加本地草稿；新增取消、无效配置阻止、复制确认及发布衔接有回归覆盖。

- [Route 创建侧栏](evidence/router-detail-20260912/route-create-sheet.png)
- [Route 流量图示](evidence/router-detail-20260912/route-flow-summary.png)

### Route 操作位置与颜色（2026-09-12）

Routing 标题右上角只有独立的 Add routing rule。每条 Route 行尾固定显示省略号，点击菜单选择 Edit 或 Delete；展开区域只展示 Selector → GuardRails。Fallback 只允许编辑。新增和编辑均打开右侧 Sheet；无需先进入全局编辑模式或展开条目。

| 操作 | 颜色 | 生效与确认 |
| --- | --- | --- |
| 新增规则、添加目标 | 蓝色 | 本地草稿；侧栏取消不插入空规则 |
| 编辑、Apply changes | 琥珀黄色 | 仅更新草稿，可在发布前检查 |
| 删除规则 | 红色 | 右侧确认框显示规则名及影响；确认后从草稿移除 |
| Review / Publish | 蓝色 | 审阅后发布才影响新流量 |
| Cancel | 中性 | 关闭当前交互 |

颜色由共享 Button 语义 variant 管理，图标同时带可访问名称与提示，不能仅依赖颜色辨识操作。此轮应用范围是 Routing 交互，其他页面不批量改色。

2026-09-12 修正：Route 编辑侧栏移除 Enabled 开关；Endpoint 列表、Router 来源列表与拓扑共用 EndpointProtocolIcon，按协议显示图标。侧栏计数沿导航行垂直居中。

### Monitoring 独立视图

Tab 顺序：Overview → Endpoints → Routing → Monitoring → Revisions。Overview 不再包含折叠指标区域；Monitoring 直接展示时间范围、Revision、Endpoint 筛选、请求汇总、Route 分发、目标详情和运行趋势，保留遥测延迟与无数据状态。指标仅在打开 Monitoring 时挂载和轮询，不在 Overview 后台请求。此轮复用现有统计展示，不引入指标流量图。

### 路由配置 Diff

审阅发布与历史版本共用 react-diff-viewer-continued 的单列 Diff，红色 + 表示新增，绿色 − 表示移除（依照产品明确约定）。对比完整配置快照，保留规则身份、顺序、Selector、目标、权重与版本；附加 Guardrail 名称和百分比便于理解。未变更上下文默认折叠，支持展开。审阅侧栏使用 xl 宽度，Diff 取消库默认 1000px 最小宽度并对长行换行；组件按需加载。版本解析结果与接入列表继续独立展示。
