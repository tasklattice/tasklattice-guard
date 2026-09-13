# Controller API 契约约定

本次为不保留旧路径的接口调整。前端、Token 权限表、OpenAPI、调用索引和测试同步更新。仅覆盖 Controller 的公开产品 API；Runner 调用 API、内部控制通道与登录服务使用各自的契约。

## 标准文档与生成来源

- `/api/docs`：按产品领域分组的接口参考，展示操作含义与重试规则。
- `/api/openapi.json`：OpenAPI 3.1 标准文档，当前 97 个操作。
- `/api/openapi.json?module=routers`：按产品 Tag 裁剪的完整文档。
- `/api/openapi.json?operationId=postRoutersByIdPublish`：单个操作及其递归 Schema。
- `/api/llms.txt`：模型调用索引，包含权限与幂等类型。

方法、路径、输入 Schema、返回类型、状态码从 Hono/Zod/TypeScript 代码生成；Token 权限来自实际鉴权表。产品 Tag、业务含义、幂等和重试说明集中在 `controller/shared/api-contract.ts`，随代码评审。业务语义无法仅靠 TypeScript 类型自动推断。

修改 API 后执行 `npm run openapi:generate --prefix controller`。构建和 CI 的 `openapi:check` 阻止过期契约；测试验证实际挂载接口覆盖、权限一致性、Schema 有效性与文档裁剪后的引用闭合。

## 产品分组与权限

| 产品领域 | OpenAPI Tags |
| --- | --- |
| Account | account、access-tokens |
| Guardrail Design | guardrails、policies、validation、authoring、playground |
| Integration | routers、endpoints |
| Observability | telemetry、audit |
| Platform Settings | model-providers、models、model-configurations、runners、system |

Tag 用于理解产品，不用来推断授权。例如 Router 流量统计归 telemetry，权限仍为 routers:read；Guardrail 和 Policy 的验证都归 validation，但分别要求各自模块权限。以每个操作的 `x-token-permission` 为准。

Token 用 `Authorization: Bearer <token>` 传递，`GET /api/v1/account/identity` 返回身份和有效权限。当前授权范围是模块级 read/write，覆盖该模块所有资源。写操作同时要求当前账户具有管理员角色；Token 管理仅接受账户自己的浏览器 Session。

## 资源路径与功能边界

以下路径省略统一前缀 `/api/v1`。旧路径已移除，无别名或自动跳转。

| 资源/职责 | 当前路径与行为 |
| --- | --- |
| Guardrail Test Case | `GET/POST /guardrails/{guardrailId}/test-cases`；`DELETE /guardrails/{guardrailId}/test-cases/{caseId}`。父 ID 是定位用例的必要组成部分。 |
| Guardrail 可执行验证 | `POST /guardrails/{guardrailId}/validation-runs` 创建任务；全局 `/validation-runs` 支持跨 Guardrail 查询。 |
| Policy 静态检查 | `GET /policies/{id}/draft/checks` 只读检查，不创建 Runner 任务。 |
| Policy 可执行验证 | `POST /policies/{id}/validation-runs` 创建任务；返回 202、Location 和 statusUrl。通过 `/policies/{id}/validation-runs/{runId}` 轮询本次任务；latest 仅用于浏览最近记录。 |
| Router 发布预览 | `POST /routers/{id}/publication-preview` 解析已审阅版本、快照和 Endpoint 集合。 |
| Router 规则模拟 | `POST /routers/{id}/simulations` 计算输入匹配，不发布或执行 Guardrail。 |
| Router 历史流量 | `/routers/{id}/traffic-distribution` 以及其 route 对应路径。配置下发状态读取 Router 的 rolloutStatus/desiredGeneration。 |
| Router 历史发布 | `GET /routers/{id}/revisions/{revision}` 读取确切版本。 |
| 路由字段目录 | `GET /routing/selector-fields`；旧 traffic-scope-fields 接口删除。 |
| 运行观测 | `/telemetry/events`、`/telemetry/metrics`、`/telemetry/endpoint-activity`。 |
| 辅助设计 | `/authoring/capabilities`、`intent-analyses`、`document-analyses`、`plan-previews`。capabilities 是服务能力，非某次分析进度。 |
| Playground | `/playground/guardrails/{guardrailId}/interactions`、`draft-interactions`、`draft-previews`。 |
| Policy 目录 | `/policy-catalog/actions`、`/policy-catalog/protection-presets`。 |
| Provider 发现/注册 | `/model-provider-discoveries` 查询临时连接；`/model-providers/{id}/model-discoveries` 查询已有连接；`/model-provider-registrations` 组合注册 Provider 与所选 Model。 |
| 连接/能力测试 | `/model-providers/{id}/connection-tests`、`/models/{id}/connection-tests` 检查连接；`/models/{id}/capability-tests` 检查能力与协议。 |
| 模型配置激活 | `POST /model-configuration/revisions/{id}/activate` 针对指定版本；rollback 请求必须给出明确的 targetRevisionId。 |

生命周期命令保留明确的 `/publish`、`/activate`、`/rollback` POST 动作。资源 URL 体现实际归属；跨资源查询无需强行嵌套。

## 幂等、并发与异步

幂等指重复请求不额外改变目标状态，不要求响应字节或状态码完全相同。文档为全部操作生成 `x-idempotency` 与 `x-retry-policy`，不要只凭 HTTP 方法判断是否可以盲目重试。

| 操作 | 边界与调用方行为 |
| --- | --- |
| GET | 只读。模型配置 GET 不创建草稿、不推进激活；流量查询不负责清理超时记录。 |
| DELETE | 只作用于路径指定资源；重复可能返回 404。Test Case 删除包含父 ID，不能误删其他 Guardrail 的同名用例。 |
| Router Endpoint PUT | 对 Endpoint ID 去重排序；集合相同不递增 generation、不重复下发。 |
| Router draft PUT | expectedDraftRevision 是并发前置条件。成功后用旧 revision 重放可返回 409；重新读取、比较和审阅，不能自动替换为新 revision 强行覆盖。 |
| Router publish/rollback | 必须提供 idempotencyKey 与 expectedDraftRevision。相同 key、相同规范化内容复用原操作；内容不同返回 409。快照与 Endpoint ID 必须成对提交。 |
| Router 幂等键细则 | Router 内 publish/rollback 共享键空间；无时间过期，删除版本后保留审计墓碑，拒绝重新发布。比较 actorId、draft revision、回滚目标、已审阅快照及规范化 Endpoint 集合的 SHA-256。事务锁串行处理并发重复请求。 |
| Router 重放返回 | 顶层 Router 是当前状态；publication.revision/generation 是原操作身份，replayed 标记重放，revisionUrl 可读原版本。后续发布可能已经覆盖它；重放不产生新下发。 |
| Policy 发布 | expectedDraftRevision 必填；同一 Policy 和源草稿 revision 复用已发布不可变版本。 |
| Guardrail 发布 | expectedDraftRevision 必填，并检查当前草稿。页面提交用户正在查看的 revision；冲突要求重新审阅。不承诺通用请求键重放，按返回 version 查询编译结果。 |
| Model assignment PUT | 相同绑定是无操作。更换非空绑定须提供有效 validationId；清空用 modelId:null。整份 draft PUT 仅在配置变化时清除校验。 |
| 普通 POST | 创建、外部探测、可执行验证和交互通常不保证幂等；超时先查询结果，不自动创建新的请求。 |
| 激活/回滚 | 模型版本激活可能已经被消费，再次请求可返回 409。回滚指定目标且会产生新版本，不能盲目重试。 |

Router/Guardrail 的 202 表示请求已接受，非运行态完成。Router 读取当前资源并对比 generation；Guardrail 按返回 version 查看 ready/failed。Policy 验证轮询返回的固定 runId，避免 latest 被其他任务替换。

Guardrail Version 使用 API 返回的 `YYYYMMDD-HHmmss.SSSZ`；Router revision 是数字；Model configuration revision ID 是 UUID。不要将这些标识混用。

## 模型绑定的校验凭据

1. 对候选 Model 调用 `POST /model-configuration/draft/assignments/{target}/candidate-validations`，提供 modelId。
2. 返回 validationId 与 expiresAt；记录持久化到数据库，在 Controller 多实例间可使用，有效期 10 分钟，绑定账户、target、model 和配置指纹。
3. 可用 `GET .../candidate-validations/{validationId}` 读取自己的结果。
4. 更换绑定时 `PUT .../assignments/{target}` 同时提供 modelId 与 validationId。凭据过期、验证失败、归属错误或 Model/Provider 已变化均拒绝保存。
5. 已保存绑定的重新验证使用 `POST .../assignments/{target}/validations`；整份草稿使用 `POST /model-configuration/draft/validations`。这些操作不接收候选 modelId。

## 数据库与验证

新增迁移 `0012_api_semantics.sql` 保存 Router 请求摘要/原 generation 和模型绑定校验记录。按仓库现有迁移流程执行后运行新代码；旧 API 不再保留。隔离 PostgreSQL 环境已迁移并验证，无需操作业务数据来做回归。

回归覆盖路由文档与权限、账户与 Token、Guardrail/Policy、Router、模型设置页面，以及真实 PostgreSQL 的复合资源删除、发布重放与冲突、重复绑定、只读模型视图和跨实例校验凭据。原始问题证据保留在 `docs/evidence/api-semantics-20260912/`，用于解释修复前行为。
