# Controller OpenAPI 设计 Review

## 结论与原有问题

Review 前，Controller 有零散的手写说明和前端 API 类型，但没有统一的 OpenAPI 文件、生成命令或文档同步检查。Hono 路由、Zod 请求校验和 TypeScript 返回类型已经存在，可以作为标准文档的生成来源。旧说明中的 `/api/v1/router-bindings` 已经与实际路由不一致，说明手写接口清单存在漂移风险。

Runner 是独立的 FastAPI 服务：`runner/main.py` 关闭了 Swagger UI 与 ReDoc，但没有关闭 FastAPI 默认的 OpenAPI JSON 配置。它的运行时 Endpoint API 与 Controller 管理 API 是不同的契约、使用不同凭证。本次生成范围是 Controller `/api/v1/*` 的 97 个操作，不把 Runner、内部控制接口、metrics、Better Auth 登录接口混进个人 Token 的文档。

## 已实现的标准入口

| 入口 | 用途 |
| --- | --- |
| `/api/openapi.json` | 完整 OpenAPI 3.1 JSON，可供工具导入 |
| `/api/docs` | 无外部 CDN 依赖的 HTML 接口参考，支持按模块查看 |
| `/api/llms.txt` | 模型使用的紧凑接口索引、鉴权和异步调用说明 |
| `/api/openapi.json?module=routers` | Router 模块的完整子文档 |
| `/api/openapi.json?operationId=postRoutersByIdPublish` | 单个操作及其所有间接引用的 Schema |

文档入口不要求登录，不包含账户数据或密钥；业务接口继续执行原有鉴权。过滤结果仍是完整 OpenAPI 文档，保留所需的递归 Schema 和 security schemes。未知模块或操作返回 404。`/api/llms.txt` 是便于检索的辅助索引，标准契约以 OpenAPI JSON 为准。

生成文件：[controller.openapi.json](../controller/openapi/controller.openapi.json)。生成器：[generate-openapi.mjs](../controller/scripts/generate-openapi.mjs)。文档服务：[openapi.ts](../controller/server/http/openapi.ts)。

## 从代码生成的内容

| 文档信息 | 唯一来源 |
| --- | --- |
| 方法、路径、参数名、operationId | `server/http/app.ts` 中实际 Hono 路由 |
| 请求字段、必填项、枚举、长度、数值范围、默认值 | 路由实际执行的 Zod Schema，使用 Zod 的输入侧 JSON Schema 转换 |
| 响应字段、联合类型、可空值、日期、状态码 | TypeScript 编译器检查 `context.json(...)` 的参数类型及状态码 |
| 产品 Tag、操作含义、幂等与重试边界 | `shared/api-contract.ts` 业务元数据，与权限模块分别维护 |
| Token 模块与 read/write | 实际鉴权使用的 `tokenRoutePermissions` allowlist |
| Session 限制、管理员要求 | 路由中间件与 Token 权限规则 |
| 文件上传数量和大小限制 | 实际文件摄取模块的常量 |

不通过前端 DTO 推测返回字段。日期对象按 JSON 序列化后的 date-time 字符串描述。请求默认值不会被错误地标为调用方必填。使用 `operationId` 标识操作，并提供 `x-source` 追溯到处理器。

生成器在构建阶段读取 TypeScript AST、执行 Schema 声明并生成文件，不启动 HTTP 服务、不调用业务处理器、不连接数据库。少数委托服务校验的接口显式引用同一个业务 Schema；文件上传由对应实现的限制常量补充。新增无法识别的请求体、未分类的 Token 接口、未知的顶层返回类型或动态状态码会让生成失败，需要补齐生成规则。

当前生成器使用仓库已有 TypeScript 7 的 `unstable/sync` 和 `unstable/ast` API；升级编译器时需要一起验证生成器，依赖版本由 package-lock 固定。若将来路由拆分到其他文件，必须同步扩展扫描入口，实际挂载路由覆盖测试用于发现遗漏。

## 模型调用约定

1. 先读取索引，再读取相关模块或 operationId 的完整文档；不必每次将全部接口放入模型上下文。
2. 通过 `Authorization: Bearer <token>` 调用；用 `GET /api/v1/account/identity` 查看身份与有效权限。Token 权限覆盖选中模块的全部资源，目前没有单个 Guardrail 或 Router 的资源 ID 范围。
3. 写操作要求模块 write 权限和当前管理员身份。`x-account-role` 是 Session 路由角色要求；`x-token-account-role` 同时表达 Token 的角色限制。read/write 由操作本身决定，例如只做计算的 simulations 虽是 POST，仍属于 read。
4. Token 创建、列表和撤销接口只接受所属用户的浏览器 Session，不能用已有 Token 签发新 Token。
5. Router 编辑遵循读取 → 保存 draft → publication-preview → publish。保存、预览、发布需要当前 `expectedDraftRevision`；发布还需要 `idempotencyKey`，并可提交已审阅快照和 Endpoint ID。冲突时重新读取和审阅，不自动覆盖别人的更新。Router 不提供重命名接口。
6. 发布 Guardrail 或 Router 的 `202` 表示已接受处理；继续读取资源、验证结果或对应的 validation run，确认目标版本及运行状态。网络超时后先读取状态，再决定重试；没有幂等约定的写操作不能盲目重放。
7. Guardrail Version 是 API 返回的 `YYYYMMDD-HHmmss.SSSZ` UTC 标识；不要把数字 draft revision 或 ISO 日期字符串当成版本 ID。删除前读取对应的影响接口并处理引用冲突。

## 自动化与维护

在仓库根目录运行：

```sh
npm run openapi:generate --prefix controller
npm run openapi:check --prefix controller
npm test --prefix controller -- server/http/openapi.test.ts
```

提交 API 改动时同步提交生成文件。`openapi:check` 重新生成并逐字节比较，CI 和 server build 都执行此检查；文件过期会失败，不会悄悄发布旧文档。生成和检查都验证 OpenAPI 规范有效性。生成文件随 server 编译产物一起交付，生产运行不需要 TypeScript 编译器或文档生成依赖。

测试覆盖实际挂载路由与文档一一对应、权限 allowlist、全部 JSON Schema 编译、必填与枚举约束、默认值、异步响应、模块裁剪后引用闭合，以及实际 HTTP 文档和身份响应。

## 仍需明确的边界

JSON Schema 不能完整表达数据库状态、跨资源引用、自定义 Zod refine、运行时可用性和业务状态机。自定义 refine 用 `x-runtime-validation` 标注，版本 ID 另附格式说明。Response Schema 来自静态类型，不能替代运行时返回值校验；动态 JSON 字段保留开放类型，不伪造其内部结构。通用错误响应列出可能的错误类别，并不表示每个接口一定触发所有类别。

因此采用“结构与权限由代码生成，调用顺序与业务含义由简短说明补充”的方式。以后新增复杂生命周期操作时，同步补充业务说明与契约测试，比维护第二套手写字段定义更可靠。

参考：[OpenAPI 3.1 标准](https://spec.openapis.org/oas/v3.1.1.html)、[Zod JSON Schema 转换](https://zod.dev/json-schema)、[Hono 与 Zod OpenAPI 集成](https://hono.dev/examples/zod-openapi)。本次复用现有普通 Hono 处理器，没有迁移整套路由框架。

接口语义修复后的调用规则与路径见 [API 契约约定](api-contract.zh-CN.md)。
