# Router 工作区审查与修正（2026-09-11）

本次重点检查创建表单、共享 Selector/Target 编辑器、创建与绑定接口，以及 Controller 到 Runner 的路由配置。不是对整个仓库的完整审计。

## 发现与修正

1. **P1：创建流程必然在绑定处失败。** 原表单先创建未发布草稿，再调用要求 activeSnapshot 的绑定接口。结果是用户看到创建失败，数据库却留下草稿，重试还会重复创建。现在 POST /routers 接受 endpointIds；校验来源存在性、独占归属、能力与创建草稿在同一事务内完成。竞争同一个 Endpoint 的创建请求由事务锁串行化。草稿也允许修改、释放来源绑定。
2. **P1：Controller 下发结构与 Runner 的 Fallback 校验矛盾。** 下发 allEndpoints=false，而 Runner 要求 Fallback 的 all_endpoints=true，导致配置被拒绝。现在先由 Endpoint 的 routerId 选择 Router，内部 Route 对该 Router 的全部来源输入生效，统一下发 allEndpoints=true。
3. **P2：创建按钮校验不足。** 原按钮仅检查名称、Endpoint 和非空目标数组，没有校验 Selector、固定版本及百分比总和。现在复用共享 routingIssues 做创建前校验；后端仍独立验证，不依赖 UI 保证数据正确。
4. **P2：重复实现现有交互组件。** Endpoint 使用平铺复选框，Selector 手写递归原生表单，和项目已有搜索多选、QueryBuilderShadcn 不一致。现在来源与 Guardrail 选择复用 MultiSelectCombobox，表达式复用 QueryBuilderShadcn 和 react-querybuilder，通过显式转换保留 HTTP 来源、Header key、嵌套 AND/OR、集合值及大小写设置。
5. **P2：单目标比例不符合产品语义。** 单目标原本仍可配置不足 100%。现在单目标固定 100%；多个目标展示百分比，增删目标时初始化为等分（整数基点精确合计 100%），随后可手动调整。

## 表单结构

- Router 名称；不再提供 Description。
- 来源 Endpoint 搜索下拉，多选标签可移除；被其他 Router 占用的来源禁用并显示归属。
- 多条 Route，每条先表达式，再一个或多个 Guardrail；按显示顺序首次命中。
- 其余流量的默认 Guardrail。

创建表单拆为独立组件，Selector 与 Target 编辑器同时服务于创建和详情编辑。Guardrail 的 Duplicate 保持在 Guardrail 管理交互中。

## 验证边界

已补充表达式往返转换、精确百分比、创建 Endpoint 参数传递、真实 PostgreSQL 的多来源原子创建与竞争绑定测试。Runner 的组合路由测试也纳入本次验证。

浏览器预览通过独立 Vite 端口连接现有服务时，登录被后端以 Invalid origin 拒绝。因此本次没有完成登录后的真实浏览器视觉验收，也没有替换 38081 上正在运行的镜像。工作区代码和部署中的版本必须区分。
