# Playground 高级路径测试

Playground 顶部提供「普通模式 / 高级模式」，默认进入普通模式。普通模式继续提供 GuardRail 对话测试，模型、GuardRail、Version 与发送按钮仍在输入框底部。高级模式使用 API 请求工作台布局。

## 使用方式

1. 在页面顶部切换高级模式，或从 Router / Endpoint 详情页的测试入口进入。
2. 顶部选择测试目标。Router 同时选择 Revision、来源 Endpoint 和测试范围；Endpoint 自动显示绑定 Router。
3. Method、URL 和发送按钮位于同一请求栏。Router 描述业务请求；Endpoint 自动填入固定 POST 调用路径。
4. Headers 用可增删、启停的键值表编辑。Body 支持文本 / JSON、格式化和 JSON 语法提示。Router 的其他匹配字段放在「路由上下文」，Endpoint API Key 放在「认证」。
5. 「导入 HTTP/cURL」打开抽屉，解析成功后替换同一份请求数据；解析失败保留原请求。
6. 下方只展示当前测试结果：GuardRail、Version、Runner、耗时以及路由分析 / 检测结果 / 原始响应。规则分析使用表格说明命中、跳过与原因。
7. 请求与结果之间的分隔条可拖动，也支持方向键和 Home / End。每个面板独立滚动，避免 JSON 详情嵌套多层滚动区。
8. 历史抽屉保留当前页面会话最近 50 次测试。恢复历史会恢复请求和对应结果，不自动发送，也不恢复凭证。

普通与高级模式切换保留各自输入和记录；刷新页面不保留高级测试记录。不同 Endpoint 的已编辑请求分别保留，避免选择目标时把旧协议 Body 发送到另一条路径。

## 实际调用路径

| 模式 | 路径 | 验证范围 |
| --- | --- | --- |
| 普通 GuardRail 对话 | 沿用现有 Playground 服务 → Runner | 指定 GuardRail Version / Draft preview 的对话保护 |
| 已发布 Router，仅路由 | Controller → Runner 内部测试入口 → 已加载的 Selector 和权重分配器 | 实际 Router Revision 的匹配与目标分配，不执行 GuardRail |
| 已发布 Router，执行 | Controller → Runner 内部测试入口 → Runtime → GuardRail | HTTP Body 作为输入文本执行检测；使用绑定 Endpoint 的路由上下文，不验证其入口认证 |
| Router 草稿 | Controller 草稿匹配器 | 规则匹配及候选目标；不产生实际权重分配，不执行 GuardRail |
| Endpoint | Controller → Runner Endpoint API → Router → GuardRail | Endpoint API Key、协议解析、路由和 GuardRail 执行 |

已发布 Router 请求携带预期 Revision。Controller 检查当前发布版本与 Endpoint 绑定，Runner 再检查实际加载版本；未同步或版本变化返回错误。执行时还会校验 Runtime 实际解析到的版本。相同 Call ID 沿用 Runtime 的路由固定规则，可在请求上下文中生成新 Call ID 重新测试。

Endpoint 模式遵循请求 Body 中的协议字段与 Call ID。HTTP 编辑器中的 Host 用于请求上下文，网络目的地固定为 Controller 配置的 Runner 服务。当前支持所选 Endpoint 的 POST `guardrails/evaluate` 与 `beta/litellm_basic_guardrail_api` 路径，外部 Ingress、DNS、TLS 与第三方模型完整往返不在该路径测试范围内。

Endpoint 测试使用输入的 API Key（也接受 HTTP 中的 X-Api-Key），不会转发 Controller 内部令牌。历史中的敏感请求头会被遮盖；请求 Body 保留用户输入。cURL 只作为文本解析，不执行 shell 或读取文件。

## 组件划分

- `PlaygroundPage`：顶部模式 Tabs 与两个保持挂载的工作区。
- `AdvancedPlayground`：组合请求工作台的各个区域。
- `usePathWorkbench`：目标选择、请求文档、发送状态、当前结果和会话历史。
- `path-request-model`：GUI 文档与 HTTP 文本的导入、序列化和 Endpoint 模板。
- `PathTargetBar`：目标配置、Method / URL / 发送栏。
- `PathRequestEditor`：Headers、Body、上下文 / 认证与导入抽屉。
- `PathWorkbenchSplit`：可拖动、可键盘操作的分区。
- `PathTestResult`：结果摘要、规则表格、检测信息与原始响应。
- `PathTestHistory`：历史浏览与恢复。

直接替换旧高级模式，无旧交互兼容分支。复用现有 Tabs、Input、Select、Sheet；未引入大型 API 客户端或新编辑器依赖。

## 验证记录（2026-09-13）

- 本次 Controller / UI 回归：11 个测试文件、44 项通过，覆盖 GUI 序列化、禁用 Header、重复 Header、导入校验、Endpoint 文档隔离、认证错误、凭证排除、历史恢复、真实服务传输边界与 Revision 校验。
- `npm run build` 通过，包含 UI、服务端类型检查和 OpenAPI 一致性检查。存在项目已有的较大 bundle 提示。
- 浏览器实际测试：Router 路由与执行成功；Endpoint 无凭证返回 401，补入隔离测试凭证后执行成功；普通聊天草稿经模式切换保留。
- 桌面 1440×1000 与移动端 390×844 已检查。移动端选择器换为两列、发送按钮独占一行，无页面横向溢出；分区可通过键盘调整。
- 使用隔离本地 Runner、仓库签名测试 Artifact 与真实 NeMo Runtime 验证执行；未部署或修改现有集群。
- Runner 逻辑未因本次布局调整而改变；此前该实现的 Runner 回归为 66 项通过、1 项跳过。

UI 评审采用 Product Console / release_gate：目标与发送操作、请求/结果层级、实际执行证据、错误恢复、键盘操作、品牌组件一致性均通过；移动端长字段仍需在输入框内移动光标查看全值，System Craft 的紧凑屏幕可读性记为部分通过。六维分数依次为 10、10、8.75、10、10、10（各维 4 项子检查，每项 2 分，System Craft 一项 1 分），按 22%、22%、14%、18%、16%、8% 加权为 9.83。发布仍需下面的环境同步条件。

上线需要同时包含路径测试的 Controller 和 Runner 更新，并确认 Router Revision 已同步到 Runner。只更新 UI 或 Controller 时，旧 Runner 不提供新增内部 Router 测试接口。
