# Account 与个人 Access Token

目标：让用户为脚本、CI 和系统集成创建具有明确权限边界的个人 Token。沿用现有 Account 页面、Tabs、EntitySheet 和语义化按钮，重点展示模块范围、权限和生命周期状态。

## 权限模型

`Token → 创建者 + 模块权限 + 到期时间 + 撤销状态`

每个模块选择「无权限」「只读」「读写」。读写包含只读，包含模块内的创建、修改、发布、回滚、验证和删除。未授权模块、未列入接口权限表的新接口默认拒绝。

本版授权粒度为**模块内全部资源**，包括未来新增资源，不支持指定某一个 GuardRail 或 Router ID。创建界面和 Token 列表均明确展示该范围。

| 模块 | 只读 | 读写增加的能力 |
| --- | --- | --- |
| GuardRails | 配置、版本、日志配置、测试与验证结果 | 创建、修改、复制、发布、回滚、删除、验证、设计分析 |
| Routers | 路由、修订、分布、Selector 字段与预览 | 草稿、发布、回滚、删除、Endpoint 绑定 |
| Endpoints | 接入配置 | 创建、更新、删除、接入凭据管理 |
| Policy Library | 策略、预设、动作目录、验证结果 | 创建、修改、验证、发布、删除 |
| Playground | 可用模型 | 草稿预览、运行交互（可能调用模型） |
| Model configuration | 配置、模型与提供商 | 提供商凭据、发现、连接验证、配置修改、激活与回滚 |
| Runners | 状态与容量 | 容量调整、移除实例 |
| Runtime logs | 运行事件、流量指标、按账户权限可见的捕获内容 | 不提供写权限 |
| Audit log | 系统审计记录 | 不提供写权限 |

路由的 Endpoint 绑定归属于 Router 生命周期操作，不要求另行授予 Endpoint 配置的写权限。跨模块资源引用不授予被引用模块的独立 API 权限。

实际权限 = Token 授权 ∩ 用户当前账户权限。管理员可授予读写，普通用户可创建只读 Token；每次鉴权重新读取创建者的角色和禁用状态，降权后立即拒绝写操作，禁用/删除账户后拒绝所有 Token 请求。既有接口的管理员限制仍生效（如删除影响查询）。

不支持用个人 Token 管理其他 Token、账户、用户或 Better Auth 管理接口；这些操作继续使用浏览器会话。Runner 内部密钥、Endpoint 数据面凭据和个人控制面 Token 分开管理。

## 生命周期与存储

- 名称必填，最多 100 字符；有效期 7 / 30 / 90 / 365 天，默认 30 天。每位用户最多 50 个未过期且未撤销 Token。
- 以 `tlg_pat_` 开头，使用 32 字节密码学随机数；数据库仅保存 SHA-256 摘要和不可用于鉴权的展示前缀。
- 完整 Token 只在创建响应中返回一次。前端仅在临时组件状态保存，关闭或离开后销毁，不进入 React Query 缓存或浏览器持久化存储。
- 列表返回名称、前缀、权限、创建/到期/最近使用/撤销时间，不返回摘要或明文。
- 撤销由创建者执行，幂等；到期/撤销后的新请求返回 401。已经通过鉴权的在途请求可能完成。
- 创建和撤销写入审计；授权的非 GET/HEAD 请求另记录 Token ID、所有者、接口模板和结果状态，避免在审计中保存请求体、Authorization 或完整 Token。
- 明确提供 Authorization 时，只按该凭据鉴权，不回退到 Cookie 会话。
- Token 管理要求登录会话、可信 Origin，创建要求 JSON；管理响应与 Token 请求响应使用 `Cache-Control: no-store`。

数据库迁移：`controller/server/db/migrations/0011_personal_access_tokens.sql`。Controller 启动时自动执行迁移，已有账户数据无需转换。

## Account URL

| 地址 | 页面 |
| --- | --- |
| `/account` | General（Account 的默认入口） |
| `/account/general` | 重定向到 `/account` |
| `/account/security` | Security |
| `/account/access-tokens` | Access Tokens |

Account 使用持续挂载的父页面，选择由 URL 驱动，刷新、前进、返回可以还原当前页；切换标签时保留 General 中尚未保存的表单状态。面包屑的 Account 链接返回默认页面。

## API

仅登录会话可调用：

- `GET /api/v1/account/access-tokens`：当前用户 Token 列表。
- `POST /api/v1/account/access-tokens`：创建；正文示例：

```json
{
  "name": "CI deployment",
  "expiresInDays": 30,
  "permissions": { "guardrails": "write", "routers": "read" }
}
```

- `DELETE /api/v1/account/access-tokens/:id`：撤销；成功返回 204。

Token 调用示例（环境变量中设置创建时获得的值）：

```sh
curl "$GUARD_URL/api/v1/account/identity" \
  -H "Authorization: Bearer $GUARD_ACCESS_TOKEN"

curl "$GUARD_URL/api/v1/routers" \
  -H "Authorization: Bearer $GUARD_ACCESS_TOKEN"
```

`account/identity` 返回 `userId`、当前 `role`、认证方式、`tokenId`、原始授权 `permissions` 和角色约束后的 `effectivePermissions`。无效、过期、撤销 Token 返回 401；权限不足返回 403。公开健康和系统状态接口沿用现有公开访问规则。

## 验证

- PostgreSQL 集成测试从空 schema 执行全部迁移，覆盖摘要存储、密钥唯一性、过期、撤销、所有者隔离、禁用/删除/降权、只读用户、非法授权输入。
- HTTP 测试覆盖权限清单、Cookie 不回退、跨模块拒绝、只读拒绝写入、Token 操作归属、仅会话管理、可信 Origin 和 no-store。
- UI 测试覆盖权限选择、一次性明文销毁、创建失败重试、列表加载失败恢复、撤销失败恢复和账户导航。
- 独立真实 Controller + PostgreSQL（`localhost:38186`）完成登录、创建、Bearer 身份识别、只读读取、越权拒绝和撤销后 401 的完整验证。
- 浏览器检查 Account 标签选择与 URL、Security 刷新/返回、创建表单与撤销状态。未修改用户 `38081` 上的运行实例。

相关 306 项测试、前后端生产构建及类型检查通过；390px 窄屏布局与标签焦点、General 输入保留已完成浏览器验证。详细证据见 [验证记录](evidence/account-access-tokens-20260912/review.md)。
