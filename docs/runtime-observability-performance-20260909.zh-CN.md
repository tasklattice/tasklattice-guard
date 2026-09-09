# Runtime Observability 性能修复说明

## 已修复

- Metrics 不再把最近窗口的全部 runtime event 拉到 Node.js 内存中计算；统计、分位数、趋势和 findings summary 在 PostgreSQL 聚合。
- Metrics 结果按查询 scope 做 10 秒缓存，并对不同 scope 最多并行执行 2 个重查询；数据库语句设置 20 秒超时、只读事务和受限 `work_mem`。
- 运行事件列表只返回摘要，默认/最大 500 条，使用基于 `(occurred_at, id)` 的 cursor 分页；过滤在分页前执行，避免同一时间戳漏项或重复。
- Trace、事件内容和 findings 详情改为单条按需读取；前端不再把 10,000 条记录渲染进 DOM，也不再用不断复制数组的方式追加历史数据。
- Dashboard、Logs、Guardrails 和 Deployment 详情页的轮询增加取消、失焦停止和缓存；集成活动改为聚合接口并带缓存。
- 增加了 PostgreSQL 临时表压力测试：10,001 条事件、约 35KB/条的敏感字段，验证统计精确、响应不携带敏感内容、列表分页无重复/遗漏。

## 仍需关注

Metrics 仍需扫描时间窗口内的事件和每条 event 的 trace/findings JSON；索引能降低候选行范围，但不能消除 JSON 数组展开成本。当前通过缓存、超时和并发上限避免把数据库压力传导成页面卡死。数据规模继续增长后，应把日/小时聚合表或物化汇总引入，而不是继续提高 API limit。

生产构建仍有约 2.4MB 的单 JS chunk，属于独立的首屏下载/解析成本；本分支先完成数据路径止血，后续可按路由做动态拆包。

## 存储和保留边界

- Runner Prometheus metrics 在进程内存中，Runner 重启即清零；历史曲线由外部 Prometheus 的 scrape/retention 配置决定。
- Runner runtime event 发送失败时写入 `${state_path}/runtime-events.wal`，成功发送后删除已确认行；代码没有按时间自动过期，故失败期间会一直保留直到成功发送或磁盘达到限制。Helm 默认把该目录挂载到 `emptyDir`，Pod 被替换后丢失，不能当作持久队列。
- Controller 接收后的 runtime events 在 PostgreSQL `runtime_event` 表中。界面显示的 30 天是 logging settings 的配置展示值，当前代码没有对应的数据库清理任务，因此不能把它当作已执行的 30 天 TTL。

本分支只包含代码和测试，不自动部署、不删除已有事件，也不改变现有 retention 数据。
