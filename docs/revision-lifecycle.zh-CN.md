# Router 与 GuardRail 版本生命周期

## 配置与状态的边界

`proto/tasklattice/guard/control/v1/routing.proto` 中的 `RouterRevision` 定义 Runner 接收的不可变路由配置，不定义 Controller 的部署健康状态。状态由发布记录、目标 generation、Runner ACK、心跳和拒绝信息推导；不应写回不可变快照。

Router 状态的唯一推导入口为 `controller/shared/router-lifecycle.ts`，附带转换注释和单元测试。它是完整的派生状态判定，而非一个持久化的状态转换表。

| 当前条件 / 事件 | 结果 | 说明 |
| --- | --- | --- |
| 尚未发布 activeRevision | Unpublished | 草稿不会处理流量 |
| 发布或回滚生成新的目标 generation | Distributing | 等待 Runner 应用 |
| 默认池至少一个 Runner，全部 ACK 不低于目标 generation，心跳不足 60 秒 | Active | 收敛优先于早前的拒绝信息 |
| 未收敛且有 rolloutError | Failed | 展示当前下发错误 |
| 未收敛且无 rolloutError | Distributing | 包括无 Runner、心跳过期或新 Runner 未追上 |
| Failed 后重新发布 | Distributing | 发布清除旧错误 |
| Failed 后全部 Runner 收敛 | Active | 不需要修改已发布快照 |
| Active 后心跳过期 / 新 Runner 未追上 | Distributing 或 Failed | 有保留的拒绝信息时为 Failed |

`activeRevision` 表示 Controller 当前期望生效的版本，不等于所有 Runner 都已应用。Revision 列表当前版本显示 Active（绿）、Deploying（黄）、Failed（红）；非当前版本显示 Previous（中性徽标）。Previous 仅表示历史版本，不推断该版本曾部署成功。

GuardRail 版本的构建状态保持现有 `compiling → ready / failed`；版本内容不可修改。Active / Historical 描述该版本是否为当前激活版本，与构建状态不同。

## 回滚

- Router：历史版本菜单 Rollback 恢复路由配置到草稿，经过审阅、发布后生成一个新 Revision。Endpoint 当前绑定关系不随历史快照恢复。服务端回滚发布也生成新 Revision。
- GuardRail：保留已有的历史 ready 版本激活流程，确认后激活该历史版本；不修改版本内容，不伪造新版本。固定到其他版本的 composed Router 不自动改写。
- 不可变指内容不原地修改，不等于永远不能删除。

## 删除

两个资源的版本操作均使用省略号菜单：Rollback（编辑色）和 Delete（红色）。删除打开右侧确认抽屉；当前版本菜单项禁用，所有限制由服务端再次检查。只有管理员可调用删除 API。

- Router：当前 activeRevision 不可删除。历史版本删除前须确认 Runner 已收敛、Router 最近一次更新时间距今超过五分钟，且没有五分钟保留窗口内尚未完成的路由调用。
- GuardRail：当前激活和正在编译的版本不可删除。任何 Router 草稿、当前快照、历史 Revision 或存续的旧路由引用该版本时不可删除。草稿使用 Latest 时也保守阻止删除该 GuardRail 的版本。还须通过五分钟保留窗口、现有默认池 Runner 收敛和未完成调用检查。
- 删除与 Router 发布、草稿保存、绑定及旧路由创建使用一致的事务锁顺序。删除与 GuardRail 激活通过 GuardRail 行锁互斥。
- 删除只移除版本记录；不删除编译 artifact、运行日志、分发记录或审计证据。Router 删除审计保留快照及原发布幂等键，重放已删除版本的发布请求返回冲突，避免意外重新发布。
- 历史 Router Revision 的引用也会阻止 GuardRail 版本删除，确保仍可回滚的版本保持可用。需要先删除这些历史 Revision。
- 删除后不可通过版本列表恢复；版本编号不复用。保留窗口是当前实现的五分钟调用保留假设，并非对无限时长外部请求的保证。

API：`DELETE /api/v1/routers/:id/revisions/:revision`、`DELETE /api/v1/guardrails/:id/versions/:version`。成功返回 204；仍在使用返回 409；不存在返回 404；无权限返回 403。
