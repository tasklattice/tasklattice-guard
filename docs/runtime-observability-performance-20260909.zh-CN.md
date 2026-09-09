# Runtime Observability 性能修复说明

## 已修复

- Metrics 不再把最近窗口的全部 runtime event 拉到 Node.js 内存中计算；统计、分位数、趋势和 findings summary 在 PostgreSQL 聚合。
- Metrics 结果按查询 scope 做 10 秒缓存，并对不同 scope 最多并行执行 2 个重查询。所有串行 SQL 共享 20 秒时间预算，每条语句使用剩余预算设置 PostgreSQL `statement_timeout`；列表与详情也使用有超时的只读事务。连接池等待上限为 5 秒。
- 运行事件列表只返回摘要，默认 100 条、最大 500 条，使用基于 `(occurred_at, id)` 的 cursor 分页；过滤在分页前执行，避免同一时间戳漏项或重复。
- Trace、事件内容和 findings 详情改为单条按需读取；前端不再把 10,000 条记录渲染进 DOM，也不再用不断复制数组的方式追加历史数据。
- Dashboard、Logs、Guardrails 和 Deployment 详情页的轮询增加取消、失焦停止和缓存；集成活动改为聚合接口并带缓存。
- 增加了 PostgreSQL 临时表压力测试：10,001 条事件、约 35KB/条的敏感字段，验证统计精确、响应不携带敏感内容、列表分页无重复/遗漏。

## 复审补充修复

- 集成活动的历史 first/last、方向、异常和流式最终检查时间改成索引定位；只有最近 24 小时的计数扫描时间窗口。迁移 `0007_runtime_activity_probes` 添加方向索引、异常和流式最终检查的部分索引，需随部署执行。索引创建会占用数据库资源，应在合适的发布窗口执行。
- Guardrail 和 Deployment 安全发现将 severity 传给服务端，在分页前选取有匹配发现的事件。切换筛选会重置游标；Deployment 安全页使用与顶部统计一致的 24 小时时间范围。
- 日志详情按 request + guardrail 查询全部已记录 checkpoint 的摘要，支持独立分页；选择一条才读取完整数据，一次仅展开一条，切换或关闭后释放对应查询缓存。
- 新增回归覆盖累计 SQL 超时及连接释放、较旧 Critical 事件的筛选、历史集成时间与近期计数，以及详情按需读取和跨页浏览。

客户端离开页面时可取消自己的 HTTP 读取；共享 Metrics 作业允许在整体预算内完成，以供其他订阅者或缓存复用，并非每次客户端断开都立即取消共享 SQL。

## Drizzle 查询整理

- `control-plane.ts` 和 `runtime-metrics.ts` 的查询主体改为 Drizzle `select / where / join / groupBy / unionAll`，不直接书写完整 SELECT、CTE 或 SQL 模板，也不使用 `sql.raw()`。
- 保留数据库端摘要投影、精确分位数、复用紧凑 CTE、索引定位和有预算的事务；不把完整事件取回 Node.js 后做统计。
- Drizzle 未内置的 JSON、分位数、条件聚合及游标元组表达式集中在 `server/db/postgres-expressions.ts`，全部使用参数化表达式。事务锁和超时设置分别在 `postgres-locks.ts`、`read-budget.ts` 中。这些是明确保留的 PostgreSQL 原语，尚非整个代码库“零 SQL”。
- `runtime-metric-results.ts` 单独负责返回值转换，不访问数据库。
- 对比旧 SQL 时发现 `kind=policy` 的步骤除了正常按 policy ID 分组，还会重复生成按名称、guardrail 的 Policy 条目。现在仅在 Policy 维度统计一次；新增混合 Policy/Action 步骤用例防止回归。
- 真实部署在相同 24 小时窗口内的请求数、延迟和趋势等字段一致；Policy 分布按上述方式纠正，`latest_at` 经 ORM 转为 ISO 时间字符串，表示的时刻不变。单次实测旧 SQL 约 2.50 秒、ORM 查询约 2.13 秒，不能据此保证所有负载都有相同比例的改善。

## 仍需关注

Metrics 仍需扫描时间窗口内的事件和每条 event 的 trace/findings JSON；索引能降低候选行范围，但不能消除 JSON 数组展开成本。当前通过缓存、超时和并发上限避免把数据库压力传导成页面卡死。数据规模继续增长后，应把日/小时聚合表或物化汇总引入，而不是继续提高 API limit。

生产构建仍有约 2.4MB 的单 JS chunk，属于独立的首屏下载/解析成本；本分支先完成数据路径止血，后续可按路由做动态拆包。

## 存储和保留边界

- Runner Prometheus metrics 在进程内存中，Runner 重启即清零；历史曲线由外部 Prometheus 的 scrape/retention 配置决定。
- Runner runtime event 发送失败时写入 `${state_path}/runtime-events.wal`，成功发送后删除已确认行；代码没有按时间自动过期，故失败期间会一直保留直到成功发送或磁盘达到限制。Helm 默认把该目录挂载到 `emptyDir`，Pod 被替换后丢失，不能当作持久队列。
- Controller 接收后的 runtime events 在 PostgreSQL `runtime_event` 表中。界面显示的 30 天是 logging settings 的配置展示值，当前代码没有对应的数据库清理任务，因此不能把它当作已执行的 30 天 TTL。

本分支只包含代码和测试，不自动部署、不删除已有事件，也不改变现有 retention 数据。
