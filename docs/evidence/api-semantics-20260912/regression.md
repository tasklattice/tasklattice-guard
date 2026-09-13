# API 语义修复回归

日期：2026-09-12。隔离预览：http://localhost:38186；独立 PostgreSQL 端口 55451。未部署到 38081。

## 自动化结果

- Controller 全套：132 个文件通过，1,067 项通过，70 项因集成环境条件跳过。
- HTTP、Router/Model PostgreSQL 和模型服务定向回归：19 个文件，432 项通过（含真实数据库测试）。
- 最后修改涉及的 OpenAPI、模型服务/数据库、Guardrail 前端调用与详情页面：5 个文件，102 项通过。
- 最后补充文档语义后：OpenAPI 契约 24 项通过。
- 完整前后端 build 通过；最后 server build 再次通过，生成文件同步检查覆盖 97 个操作、261 个 Schema。
- git diff --check 通过。

以上测试集合有重叠，不将数量相加。Vite 仍提示已有的大体积 chunk 警告，不影响构建。

## 关键行为

- 重复 caseId 分布于两个 Guardrail 时，重复删除只能作用于指定父资源，另一个保留。
- Router 幂等键拒绝不同审阅内容；旧 key 重放返回原 publication 身份和当前 Router，不创建版本、不重新下发。
- Endpoint 集合顺序变化或重复 ID 不引发新 generation。
- GET 模型配置不创建 draft 或完成 activation。
- 模型候选校验可跨服务实例使用，错误账户、过期、配置变化会拒绝；相同绑定无额外 revision。
- Guardrail 前端发布发送当前已审阅的 draft revision，409 后不会先获取最新 revision 再覆盖。
- 旧 API 路径明确返回 JSON 404。

## 实例与页面

实际 HTTP 的 16 项检查全部通过，覆盖身份、Token 列表、Guardrail、嵌套 Test Case、Policy、Router、Endpoint、模型配置、运行观测、路由字段目录、OpenAPI 及三个已移除路径，见 regression-http.json。只保存方法/路径/状态码，不保存会话凭证或响应账户数据。

浏览器检查了新构建：

- Account Access Tokens 示例使用 `/api/v1/account/identity`；切换 Security 后 URL 为 `/account/security`。
- Router 列表正确显示空状态。
- Settings Health、Models、Guardrail Catalog 加载正常，未配置模型时显示对应禁用状态。
- API 文档显示 97 个操作、产品领域分组、新路径、操作含义和重试规则。

隔离预览未连接 Runner/外部模型，因此没有执行真实推理和真实 Runner 下发的端到端验证。对应状态机、下发触发条件与重复请求行为通过服务和数据库测试覆盖。
