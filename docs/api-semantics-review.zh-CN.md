# Controller API 语义、资源与幂等性 Review

> 以下保留修复前的 Review 与证据。问题已按不保留兼容路径的方案修复；当前约定见 [API 契约约定](api-contract.zh-CN.md)。

日期：2026-09-12。范围：当前 Controller `/api/v1` 的 94 个操作、产品导航、实际权限表，以及核心资源服务实现。Runner Runtime 与 Better Auth 独立接口不属于本次范围。

结论：资源导向的基础已经具备，但还不能说语义和重试契约完整。需要优先修复资源定位错误和 GET 推进业务状态，其次明确幂等、异步状态查询，再调整 Tag 和路径。OpenAPI 自动生成解决了字段同步，并不会自动证明业务语义正确。

本次只新增 Review 和隔离复现证据，未改动业务实现、接口地址、权限或部署。

## 1. 优先发现

### [P1] Test Case 删除缺少 Guardrail 层级，会删除另一份资源

现有接口 `DELETE /api/v1/test-cases/{caseId}` 只提供 caseId，但数据库主键是 `(guardrailId, id)`，复制 Guardrail 会保留 Test Case ID。删除服务只按 caseId 查询第一条记录，因此调用方无法指定源 Guardrail 或副本。对复制后的两份自定义用例发送两个完全相同的删除请求，会把两份都删除，直接破坏 DELETE 的目标资源与幂等语义。

证据：[复合主键](../controller/server/db/schema.ts#L292)、[复制保留 ID](../controller/server/services/control-plane.ts#L547)、[删除查询](../controller/server/services/control-plane.ts#L1018)、[HTTP 路由](../controller/server/http/app.ts#L720)。隔离数据库复现：记录数 `2 → 1 → 0`。

建议改为 `DELETE /api/v1/guardrails/{guardrailId}/test-cases/{caseId}`，服务查询、删除都包含两个键。列表与创建也采用同一父子路径。不能仅调整文档，或只给旧路径换名字。

### [P1] 查询模型配置会创建草稿、完成激活

`GET /api/v1/model-configuration` 的 `view()` 在没有 editable draft 时调用 `ensureDraft()`，插入新 revision。HTTP 处理器在 Runner 就绪时还会执行 `finalizeActivation()`，把 activating 改为 active，旧 active 改为 superseded。普通用户的浏览器 Session 也能触发这一分支；限制只读 Token 的部分分支并没有让整个 GET 变成纯查询。

这不是访问日志、lastUsedAt 等附带记录，而是产品可见的草稿和生命周期变化。应由初始化、显式写操作、Runner ACK 或后台协调过程完成；查询仅返回已有状态。代码中已有 Runner ACK 完成激活的通路，可以统一状态推进职责。

证据：[GET 处理器](../controller/server/http/app.ts#L344)、[读取创建草稿](../controller/server/model-config/service.ts#L121)、[创建 revision](../controller/server/model-config/service.ts#L1180)、[完成激活](../controller/server/model-config/service.ts#L688)、[ACK 通路](../controller/server/control-channel/control-server.ts#L315)。隔离复现：GET 使 revision 数 `0 → 1`；普通 Session 的 GET 使配置 `activating → active`。这不表示普通用户可以任意选择并激活模型，触发前仍需已有 activating 状态和就绪条件。

### [P2] Router 发布 Key 的实际契约弱于调用者可能理解的含义

`publish` 和 `rollback` 共用 `(routerId, idempotencyKey)` 去重空间，数据库锁和唯一索引能阻止重复插入。重放时只比较 expectedDraftRevision 和 rollbackRevision，不比较 reviewedSnapshot / reviewedEndpointIds，也不区分调用者。相同 Key、相同 revision、不同审阅内容会直接视为之前的请求。

此外，返回的是当前 Router，而非首次请求的发布记录：Key A 生成 revision 1、Key B 生成 revision 2，再重放 Key A，会返回 revision 2。HTTP 层仍然请求分发当前 desired state。这可以被设计为“重复执行受抑制，返回当前状态”，但必须明确说明，不能让模型把当前 revision 当成 Key A 的结果。

建议持久化请求内容摘要及对应 publication/revision 标识；明确 Key 是否按主体隔离、publish 与 rollback 是否共用空间、保留期、删除后的行为、冲突与重放响应。若继续返回当前资源，应同时提供 `originalRevision` 或稳定的操作资源链接。

证据：[去重比较与 tombstone](../controller/server/services/traffic-routing.ts#L131)、[返回当前 Router](../controller/server/services/traffic-routing.ts#L169)、[HTTP 分发](../controller/server/http/app.ts#L831)。已复现不同 reviewed 内容被接受，以及旧 Key 返回较新的 revision。

### [P2] 部分 PUT 重试会再次触发控制面工作

`PUT /routers/{id}/endpoints` 表达“替换绑定集合”是合适的，但完全相同的集合也会推进 desiredGeneration，HTTP 层再次分发。隔离复现 generation `0 → 1 → 2`，绑定内容保持相同。建议比较标准化后的集合；无变化时直接返回，不重置 rollout 状态或发起新的部署工作。

`PUT /model-configuration/draft/assignments/{target}` 还会依赖预验证证据；`ensureEditableDraft()` 在 validated 状态下创建新 draft，重复保存可能产生新 revision。应明确资源状态与验证证据的边界，尽可能让相同赋值成为无变化操作。

这不等于“每次日志、时间戳、历史 revision 不同就违反 HTTP”：HTTP 幂等性判断的是请求的预期效果。这里要解决的是调用者不能把 PUT 的重试误认为不会再次触发部署或验证状态变化。

证据：[绑定更新](../controller/server/services/traffic-routing.ts#L191)、[保存 assignment](../controller/server/model-config/service.ts#L518)、[ensureEditableDraft](../controller/server/model-config/service.ts#L1174)。

### [P2] 同一个 validate 路径隐藏了两种不同操作

`POST /model-configuration/draft/assignments/{target}/validate`：无 body 验证已保存的 assignment；有 `{modelId}` 则预验证候选模型并缓存证据。两者的目标、保存效果及后续调用步骤不同，但文档 description 主要是通用权限文字，没有说明这一分支。

候选证据还缓存在当前进程内，按 actor/target/model 绑定、10 分钟过期。多 Controller 实例间切换会影响随后保存请求能否找到这份证据。这是模型调用流程需要知道的实际前置条件，不能靠“可选 body”让调用者猜测。

建议明确拆分“候选模型验证”和“已保存配置验证”，或增加显式模式并描述两条工作流。若验证是保存的必需前置步骤，应返回可查询、可验证、跨实例可用的 validationId。

证据：[HTTP 分支](../controller/server/http/app.ts#L416)、[进程内预验证证据](../controller/server/model-config/service.ts#L493)、[保存检查](../controller/server/model-config/service.ts#L529)。

### [P2] 异步操作缺少稳定的结果定位，distribution 一词有歧义

Policy validation 创建接口返回 run ID，但仅暴露 `validation-runs/latest`，没有对应按 runId 的读取接口。并发创建新验证后，latest 就不能可靠定位原来的任务。建议补 `GET /policies/{policyId}/validation-runs/{runId}`。

Router `/distribution` 返回的是历史流量分布、错误数和趋势，不是 Runner 配置下发状态；Controller 其他代码又用 distributionStatus 表达下发结果。模型看到同一个词容易轮询错接口。该服务还在查询统计前执行全局超时记录清理，应将这种数据维护职责从统计读取路径中移出，或计算派生状态而不持久化写入。

建议用 `/routers/{id}/traffic-distribution` 命名流量统计；发布完成应查看 Router 的 rolloutStatus/desiredGeneration 等现有状态，或提供专用 `/rollout` / operation 资源。202 响应可返回明确的 `statusUrl`，并在 OpenAPI response links 中描述状态查询与完成条件。

证据：[Policy validation 路由](../controller/server/http/app.ts#L479)、[统计实现](../controller/server/services/traffic-routing.ts#L217)、[全局超时更新](../controller/server/services/traffic-routing.ts#L247)。

## 2. Tag 与产品模块

现有 Tag 共 11 个：`Account(4)、System(1)、guardrails(23)、policies(11)、playground(4)、routers(16)、endpoints(8)、models(19)、runners(3)、runtime(4)、audit(1)`。

主要资源分组方向是合理的；问题是生成器直接把 Token 权限模块当作 Tag，混合了三个维度：产品导航、接口资源类型、授权边界。Account/System 大小写也与其他 Tag 不一致，未提供顶层 Tag 说明。`guardrails` 混入创作辅助、Test Cases、验证任务；`models` 同时包含 Provider、Model 和配置发布；`runtime` 容易被理解为 Runner 的调用 API，实际是 Controller 观测数据。

建议采用“产品领域 → 文档 Tag”，授权继续用 `x-token-permission` 独立表达：

| 产品领域 | 建议 Tag | 现有权限如何对应 |
| --- | --- | --- |
| Guardrail Design | guardrails、policies、playground、authoring、validation | authoring 仍可归 guardrails 权限；validation 按所属 Guardrail/Policy 分别授权 |
| Integration | routers、endpoints | 保持 routers / endpoints 权限 |
| Observability | telemetry、audit | telemetry 映射现有 runtime 权限；audit 保持只读 |
| Platform Settings | model-providers、models、model-configurations、runners、system | 前三者继续共用 models 权限；runners 独立；system health 保持当前公开范围 |
| Account | account、access-tokens | 身份查询与凭证管理分开描述；Token 管理保留 Session 限制 |

不必因为 Tag 拆细就增加 Token scope。跨模块验证操作可以同属 validation Tag，但仍使用各自真实的权限。产品领域可以通过自定义 `x-product-area` 展示；它不是 OpenAPI 内置层级字段。

证据：[Tag 从权限模块生成](../controller/scripts/generate-openapi.mjs#L138)、[产品导航位置](../controller/src/routes/layout.tsx#L28)。OpenAPI 的 Tag 是文档逻辑分组，不是权限或 URI 层级规则。[OpenAPI Operation Object](https://spec.openapis.org/oas/v3.1.1.html#operation-object)

## 3. URL 与资源层级建议

以下是建议目标，不是已提供的新接口。统一前缀仍为 `/api/v1`，表中省略。

| 当前路径/形式 | 问题 | 建议 |
| --- | --- | --- |
| `/routers/{id}/draft`、`/routers/{id}/revisions/{revision}` | 父子层级清楚 | 保留 |
| `/endpoints/{id}/credentials/{credentialId}` | 独立 Endpoint 的凭证子资源，清楚 | 保留 |
| `/account/access-tokens/{id}` | 当前用户范围清楚 | 保留；whoami 可统一为 `/account/identity`，非必须改名 |
| `/test-cases/{caseId}` | ID 实际需要父资源才能唯一定位 | `/guardrails/{guardrailId}/test-cases/{caseId}`，优先修复 |
| `/validation-runs?guardrailId=...` 与 `/policies/{id}/validation-runs` | 同类能力的父子表达不一致 | 创建/父资源列表用嵌套路径；全局任务查询可保留顶层集合，因为 runId 全局唯一 |
| `/playground/interactions/{guardrailId}` | ID 所处位置看起来是 interactionId，实际为 Guardrail ID | `POST /playground/guardrails/{guardrailId}/interactions` |
| `/playground/draft-previews/{guardrailId}` | 同样混淆目标资源 ID | `POST /playground/guardrails/{guardrailId}/draft-previews`；draft interactions 同理 |
| `/model-configuration/{id}/activate` | configuration 单例下的 id 实际是 revision ID | `/model-configuration/revisions/{revisionId}/activate` |
| `/model-configuration/validate` | 实际验证当前 draft | `/model-configuration/draft/validate`，或持久化 validation-runs |
| `/model-configuration/rollback` | 隐含“上一个”版本；重试时目标可能已改变 | 显式指定 targetRevisionId，并提供幂等 Key/操作 ID |
| `/guardrails/{id}/rollback/{version}` 与 `/routers/{id}/rollback` | 同类动作一个版本放 path、一个放 body | 统一 POST `/{resource}/{id}/rollback`，body 明确版本及并发条件 |
| `/routers/{id}/distribution` | 流量分配与配置下发混用同一词 | `/routers/{id}/traffic-distribution`；发布状态独立说明 |
| `/runtime-events`、`/runtime-metrics`、`/runtime-endpoints` | 最后一个其实是活跃 Endpoint 统计，容易看成另一套 Endpoint CRUD | 可归 `/telemetry/events`、`/telemetry/metrics`、`/telemetry/endpoint-activity` |
| `/intent-analysis-status` | 实际是服务可用性，不是某次 analysis 状态 | `/authoring/capabilities` 或 `/authoring/status` |
| `/actions` | 没有说明是什么领域的动作 | `/policy-catalog/actions` 或清晰的 policy-actions 资源名 |

路径层级应表达归属、地址唯一性或关联集合，而不是照搬数据库外键。Endpoint 是可在 Router 间重新绑定的独立资源，不必把全部 Endpoint CRUD 嵌套到 Router；`/routers/{id}/endpoints` 可以表示它的关联集合。Router 路由规则以完整 draft 原子保存，能维护排序和权重约束，也不需要仅为“RESTful 外观”再增加一套逐 Route CRUD。

复数名词、kebab-case、明确的 ID 是一致性建议；HTTP 规范没有要求所有合法 URL 必须是某一种命名风格。publish、rollback、preview 用 POST 自定义动作可以接受，尤其涉及编译、审阅、部署等无法自然表示为单字段更新的操作。不要为了消除动词，把发布伪装成 PATCH status。[Google 资源导向 API 的自定义方法指导](https://google.aip.dev/136)

## 4. 看起来重复的功能如何处理

| 接口组 | 实际区别 | 判断 |
| --- | --- | --- |
| Policy `/validate` 与 `/validation-runs` | 前者检查元数据并读取已有验证结果；后者创建 Runner 编译/执行任务 | 不应当作完全重复直接删。前者可改为 validation-status / draft checks，避免误以为运行了验证 |
| Model `/test-connection` 与 `/validate` | 连通性/基础调用证据，与模型协议和能力证据不同 | 保留，补明确 summary、状态字段和副作用 |
| Provider 创建 + Model 创建，与 `/model-providers/register` | 后者是发现/探测后的组合注册事务 | 可以保留批量注册，但命名为明确 registration/batch 操作并描述原子性；不是另一个同义 create |
| Provider `/discover` 与 `/{id}/discover` | 未保存凭证探测，与已保存 Provider 的探测 | 有独立场景，标明 draft/existing，避免看起来两个 discover 无差别 |
| Router `/preview` 与 `/selector-preview` | 前者解析待发布快照/latest 版本和 Endpoint 能力；后者模拟请求如何命中规则 | 都有价值，命名为 publication-preview / route-simulation 更清楚 |
| `/traffic-scope-fields` 与 `/traffic-selector-fields` | 老 Traffic Scope 字段目录与按 Endpoint 能力生成的新 Selector 目录 | 历史重叠候选。当前 UI 使用新的 getSelectorFields；老接口缺少 deprecation 标记。确认外部使用后移除旧契约或明确不同模型，不建议两套平级长期暴露 |
| draft 全量 PUT 与单 assignment PUT | 前者整体保存并清空验证，后者要求已有验证证据并重建验证状态 | 不是简单别名；如果两者都开放，必须描述全量覆盖、预验证与状态差异；否则收敛到一种产品写入流程 |

实现证据：[Policy 两种验证](../controller/server/services/control-plane.ts#L229)、[Model 两种测试](../controller/server/model-config/service.ts#L377)、[Provider 注册](../controller/server/model-config/service.ts#L294)、[新旧字段目录](../controller/server/http/app.ts#L869)。旧接口是否仍有外部调用不在本次代码审查可确认范围内。

## 5. 幂等与非幂等：现状并未完整描述

安全、幂等、响应重放、并发控制是四个不同问题。GET 应以读取为语义；PUT/DELETE 的重复请求应保持相同预期效果；响应码或响应体不必每次一致，正常 DELETE 首次 204、再次 404 不因此破坏幂等。记录审计也不等于业务非幂等。[RFC 9110 §9.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2)

PATCH 不自动保证幂等，要看修改规则；POST 也可以通过业务规则和 Key 做去重。`expectedDraftRevision` 是防覆盖的前置条件，不能代替请求去重；第二次因旧 revision 返回冲突，也不能简单判定为“重复产生了业务效果”。[RFC 5789](https://www.rfc-editor.org/rfc/rfc5789.html#section-2)

| 操作 | 当前实际边界 | 调用方重试结论 |
| --- | --- | --- |
| 普通 GET | 原则上读取；模型配置 GET、流量统计维护是已发现例外 | 修复例外后再给出统一安全读取承诺 |
| Router draft PUT | expectedDraftRevision 做 CAS；第一次成功后第二次通常 409 | 先 GET 比对目标内容；不要自动取新 revision 再覆盖 |
| Router Endpoint PUT | 重复替换同一集合，但每次推进 generation | 会再次触发控制面工作，建议 no-op 检测 |
| Router publish/rollback POST | 每 Router 共用 Key；比较 draft/rollback revision；已删历史 Key 由审计 tombstone 拒绝复用 | 可防重复发布，但不是原始响应重放；同 Key 不保证完整 payload 一致 |
| Guardrail duplicate POST | actorId + Key；请求摘要覆盖来源、名称、版本/草稿选择；保存在资源 duplicateKey | 同 Key 不同请求冲突；重放返回当前副本，不是冻结的首次响应；未声明时间到期策略 |
| Policy publish POST | 固定 policyId + sourceDraftRevision 时复用版本；expectedDraftRevision 可省略 | 显式固定 revision 才有明确目标；省略后重试可能发布后来变更的 draft |
| Guardrail publish POST | 根据当前 draft 的最近 passed validation 复用/生成 Version，并可能激活；没有调用方固定 revision 或 Key | 不能当作任意时间下的安全重放；其内部状态去重不等于请求幂等协议 |
| Model rollback POST | 动态选择最新 superseded 配置，没有显式目标或 Key | 不自动重试；回滚完成后再次调用可能选择另一个“上一个版本” |
| validation-runs、普通资源 create POST | 创建新 ID/任务，没有统一 Key 契约 | 网络结果未知时先查询，不自动重建；验证还会再次消耗 Runner 工作 |
| Token / Endpoint credential 创建 | 创建新密钥；明文一次性返回 | 不应假设可恢复首次 secret，也不应透明重复签发 |
| Token revoke DELETE | 当前用户范围；已撤销直接返回，不重复撤销审计 | 这一边界实现清楚，但应该写入 operation 说明 |
| Test Case DELETE | 缺父 ID，重复请求可能删除另一份 | 当前不能安全重试，优先修复 |
| PATCH 字段赋值 | 具体 handler 可能增 draft revision、清验证或更新 generation | 逐项声明，不能一律写“PATCH 非幂等”或一律允许重试 |

现有 OpenAPI 的三个请求 Schema 包含 idempotencyKey，但只是长度和类型，没有 Key 作用域、有效期、并发重复、payload 冲突、结果重放或失败阶段说明。通用 202/409 文案也不足以告诉模型该查哪个资源、达到哪个状态才算完成。

建议维护代码侧的显式 operation metadata，与结构 Schema 一起生成：

- `summary` / `description`：明确业务结果，不能只是 METHOD + path 和通用权限说明。
- `x-idempotency`（自定义扩展）：mode、key location、scope、retention、request comparison、replay response、concurrent duplicate、resource-deleted behavior。
- `x-retry-policy`（自定义扩展）：哪些网络失败可重试、是否必须携带原 Key/原 body、哪些 409 必须重新读取、是否可能已经产生部分效果。
- 并发条件：明确 expected revision；也可统一 ETag / If-Match + 412，但不是所有修改都必须迁移到 Header。
- 异步响应：固定 operation/run/revision 标识、状态查询链接、目标 generation、成功与失败的终态，必要时轮询间隔提示。
- 请求相同/不同、同 Key 并发、超时后重试、删除后重放、跨主体与跨实例的契约测试。

`Idempotency-Key` Header 是可采用的惯例，但把现有 body 字段搬到 Header 本身并不能修复去重语义。扩展字段必须由业务元数据提供，不能只根据 HTTP 方法或字段名自动猜测。

## 6. 建议执行顺序与验证证据

1. 修复 Test Case 定位与模型配置 GET 状态变更。
2. 明确并实现关键写操作的幂等契约、稳定的异步操作查询、候选验证证据的生命周期。
3. 独立定义 Tag/产品分组与权限 scope，补真实业务 summary 和副作用说明。
4. 对外路径调整一次性形成迁移清单，同时更新前端、Token allowlist、OpenAPI、调用示例与测试；已经发布的客户端需要明确兼容/升级边界。不要只为统一大小写或动词风格制造大面积破坏性改名。

隔离数据库复现的 6 项观察见 [reproduction.json](evidence/api-semantics-20260912/reproduction.json)。复现使用本机独立测试 PostgreSQL 的随机 Schema，结束时已删除；未访问用户生产数据。Test Case 复现直接构造了复制后允许存在的同 ID 两行，实际复制代码保留 ID 已另行核对。GET 复现使用实际数据库与 ModelConfigurationService，仅认证和 Runner ready 状态为测试替身。

[复现脚本快照](evidence/api-semantics-20260912/reproduce.ts.txt) 可复制为 `controller/scripts/.api-review-repro.ts`，在 controller 目录使用 `node --import tsx scripts/.api-review-repro.ts` 执行；需要设置 `GUARD_REVIEW_POSTGRES_URL`，脚本限定本机测试端口 55451。它断言本次观察到的行为，是 Review 证据，不是要求未来继续保留问题的回归测试。

另运行 OpenAPI、Policy 验证边界、Model configuration HTTP 三组现有测试：39 项通过。这些测试通过并未排除上述缺陷；隔离复现覆盖了它们目前未断言的目标资源与重放边界。
