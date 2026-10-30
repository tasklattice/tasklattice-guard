# 统一报告存储、内存预算与本地验收

Guardrail、可编程 Policy 和声明式 Policy 测试统一使用分块上传、摘要分页和逐用例证据。完整证据保存在数据库；页面和 Trace 分页不截断持久化内容。

## 已删除的兼容路径

- 删除整包 `ValidationReport` 和 `RunnerMessage.validation_result`、旧 gzip 能力协商、128MiB 整包解码准入及内存重传缓存。旧字段号保留为 Protobuf reserved，避免以后误用。
- 所有测试共用分块通道，只有取消或执行失败使用小型终态通知。Runner 重连保留磁盘 spool 并逐块重放；新 boot 可以重新开始尚未完成的上传，旧 boot 和终态报告不能覆盖已有证据。最终保存与 Policy 断言写入核对 boot／upload 身份，旧进程不能提交新上传的结果。
- 删除查询时迁移、后台 legacy 扫描、`results_storage` 分支和双写。三个报告所属表均不再保存 `results` JSONB。
- 普通报告 GET 固定返回元数据，删除全量结果数组和兼容流式导出。UI、CLI 共用分页用例和单用例详情接口，不再包含 inline 渲染回退。
- Guardrail 冻结编译内容、Policy、检查结果和测试集只保存在去重快照中，删除原表大字段及 `COALESCE` 回退；发布使用冻结快照。
- Policy 原始证据只写一次，断言补充字段单独保存。父报告用例索引引用子报告的原始证据，不复制整份结果。

## 存储、事务与一次性迁移

`validation_report` 连接三个领域报告表；领域表仍负责状态。`validation_report_case` 保存排序、筛选和摘要索引，`validation_report_detail` 保存原始证据，`validation_report_upload/chunk` 记录上传与幂等清单。删除领域报告通过外键回收所属数据。

Runner 每块最多 50 个用例／约 1MiB Protobuf，逐块等待持久化 ACK。Controller 校验身份、大小、SHA256、顺序、manifest 和总数，在短事务内保存一块；最后提交终态与 outbox。Policy 断言逐用例执行，位于最终父报告锁事务之外；父报告完成时只连接索引。

`0056` 扩展统一 schema；启动迁移器在 PostgreSQL 内逐报告转换旧数据，每份报告独立事务、独立检查点，Node 不读取旧报告正文。先迁移 Policy 子报告，再让父报告复用相同证据；旧字段名一次性规范化，原始字段保留。旧 Guardrail 快照同时去重。`0057` 仅在所有检查点完成后收缩 schema，删除旧列。中断后重启继续未完成的报告。

迁移在服务开放前完成，Controller Deployment 使用 `Recreate` 避免旧程序继续写旧 schema。升级有停机窗口，需为迁移预留时间和磁盘。该 schema 不支持直接回退旧镜像；如需回滚，应同时恢复升级前数据库备份。异常大的历史用例完整保留，但超过详情读取预算时明确拒绝，避免读取导致 OOM。

## 资源保护和大小限制

每个进程读／写准入分别为 4／2，连报告状态查询也在准入内，队列有上限；PostgreSQL advisory transaction locks 在同一 schema 的 Controller 副本间共享 4 个读、2 个写槽。Policy 最终断言使用写槽，避免并发查询阻塞保存。报告查询 SQL 30s、锁等待 5s、空闲事务 30s、work_mem 4MiB。维护任务只做保留策略与未引用快照回收。停机排空已经接受的任务，Runner 关闭磁盘 spool。

| 对象 | 上限／行为 |
|---|---|
| 摘要页 | 50 条、约 512KiB；预览可缩短，完整字段保存在详情 |
| 单用例 JSON | 4MiB；新报告超限明确失败，不静默截断 |
| 单个解码块／最后元数据块 | 8MiB |
| 完整报告 Protobuf | 128MiB、10,000 个用例 |
| Runner 重传缓存 | 临时磁盘文件，最多 64 份／512MiB |
| 排队超时 | 5s；HTTP 429、Retry-After: 2，可重试 |

暂时的数据库故障不给块 ACK，重连后重放保留的数据。永久大小／manifest 拒绝先持久化失败，再通知 Runner 停止重传。临时文件支持进程内重连，不是跨 Pod 重启的持久队列。

连接池指标独立于 SQL 查询成功与否。日志仅记录阶段耗时、大小、计数、标识、连接池状态和错误分类／SQLSTATE，不记录报告正文或凭据。

## Chart 建议值

PostgreSQL 默认 request **2Gi**、limit **4Gi**，CPU request 500m、limit 2；Controller 默认 request **512Mi**、limit **2Gi**。新装 PostgreSQL PVC 默认 **20Gi**。这是大报告和并发访问的起始配置，不能仅根据报告条数估算内存，证据长度与查询方式也会影响消耗。

现有 OrbStack `tali` PVC 为 2Gi，`local-path` 不支持在线扩容，本地升级保留 `postgresql.persistence.size=2Gi`。2000 份大报告使用隔离命名空间的临时数据库。

## 可重复执行的验收

```sh
HELM_CONTEXT=orbstack HELM_NAMESPACE=tali HELM_RELEASE=tali-guard \
  DOCKER_CONTEXT=orbstack npm run helm:deploy:dev -- \
  --set postgresql.persistence.size=2Gi

HELM_CONTEXT=orbstack HELM_NAMESPACE=tali-report-bench \
  HELM_RELEASE=tali-guard-report-bench DOCKER_CONTEXT=orbstack \
  npm run helm:deploy:dev -- \
  --set fullnameOverride=tali-guard-report-bench \
  --set postgresql.persistence.enabled=false --set redis.enabled=false \
  --set controller.service.public.enabled=false --set runner.service.public.enabled=false

.venv/bin/python scripts/benchmark_report_memory.py \
  --reports 2000 --cases 800 --seconds 45 --upload-delay-ms 0 \
  --output output/report-memory-burst.json

.venv/bin/python scripts/benchmark_report_memory.py \
  --reports 2000 --cases 800 --seconds 90 --upload-delay-ms 1000 \
  --output output/report-memory-benchmark.json
```

脚本仅接受本地 `orbstack`、`*-report-bench` namespace/release，只处理自己的合成夹具。已完成的同尺寸数据可续用，未完成数据及上次上传结果会重建。凭据仅从 Pod 配置读入内存，不输出，不绕过认证。

负载为 2000 份报告、每份 800 条、共 160 万条用例。20 个读者混合读取 50 条摘要页和单用例详情，同时两个 gRPC 客户端分别保存 Guardrail 和 Policy 报告，各 800 条用例。Policy 上传还执行真实断言与父报告聚合。第一块重复发送，验证幂等。块间隔 1s 的持续轮用于增加读写重叠时间，保存墙钟时间包含人为延迟。

验证每页数量、完整报告计数、保存终态、证据数量及内容一致性。输出只有响应状态、P50／P95、响应大小、数据库大小、池压力和内存。每 0.5s 采集 Controller／PostgreSQL 的 cgroup：`memory.current` 包含页缓存，`working_set = current - inactive_file`，另外记录匿名内存和 OOM kill 计数。采样不保证捕获更短的峰值，不能将页缓存增长当成连接泄漏。

测量结束后删除隔离 release／namespace，保留普通 `tali` 部署。聚合结果保存在 `report-memory-benchmark-steady.json` 和 `report-memory-benchmark-burst.json`；完整采样在 `output/`。

## 本轮实测

2026-10-30，最终本地开发与压测 Controller 的镜像摘要相同：`sha256:bdef62489cdeeb75e8acba5e6078ff17d27daef58362685d073c0519c55dbe40`。

两轮都保有 2000 × 800 条历史用例，20 路查询、Guardrail 和 Policy 各一路保存。单份合成报告展开约 30.6MiB，压缩存储约 3MiB；数据库物理大小约 7.4GiB，含索引、TOAST 和已分配页。

| 场景 | 查询结果 | 查询 P95 | Guardrail / Policy 保存 | Controller 工作集峰值 | PostgreSQL 工作集峰值 | 池等待峰值 |
|---|---|---|---|---|---|---|
| 45s 突发上传 | 25,789 次 200 | 40ms | 3.71s / 13.63s | 282.7MiB | 198.6MiB | 7 |
| 90s 持续负载，块间隔 1s | 59,045 次 200 | 23ms | 43.44s / 50.88s | 281.0MiB | 203.2MiB | 3 |

共 84,834 次查询全部返回 200，无 429、查询失败、采样错误或 OOM kill。两轮 PostgreSQL `memory.current` 峰值分别为 910.6MiB 和 908.7MiB，包含文件缓存。持续轮保存时间包含人为块间隔。

共享连接池忙连接峰值为 20，短暂等待峰值为 7／3，没有发生超时。它还承载鉴权、指标与后台 SQL，不能等同于报告读取并发。20 路报告读取的回归单独确认：连状态查询也最多占用 4 个连接。负载全部结束后再次采集：总连接 7、空闲 7、忙 0、等待 0，没有连接泄漏的迹象。

两轮最终均有 2001 份 Guardrail 报告和 1 份 Policy 父报告；1,601,600 份物理用例证据、1,602,400 条用例索引。Policy 父报告新增的 800 个索引复用子报告证据。每份新报告保存了全部 800 条用例，并校验了首块重放和完整内容。

本轮用 Chart 默认限额测量，未将 PostgreSQL 限额降至 512MiB；填充种子、一次性迁移和长周期维护不在 45s／90s 采样窗口内。因此仍建议 PostgreSQL request 2Gi、limit 4Gi，不据此确认 512MiB 可安全运行。历史整包读取与本次分页负载不同，不作精确百分比比较。

## 回归与真实桌面验收

- Controller 完整套件：2673 通过，0 失败，3 项独立 bootstrap 数据库测试因未配置专用 URL 跳过；所有测试文件收集成功。包含真实 PostgreSQL 迁移检查点恢复、旧 Policy ID 恢复、证据共享、上传重启／旧收尾隔离、连接准入、事务回滚、删除／取消与发布签名回归。
- Python 控制面：3764 通过；CLI：24 通过；真实 Runner/gRPC 报告传输与断线重放 E2E：2 通过。协议生成、类型检查与 Deploy Dev 构建通过。
- 本地现有 8 份 Guardrail 报告迁移完成，三个旧 `results` 列均已移除。旧的 748 用例报告可分页、筛选和按需加载 40 spans 的证据。
- 真实 Runner 重跑 `testing-report-ebbd4069-23a4-4e14-8c90-d05ff6f483b4`：748／748 通过、17 个持久化块。桌面展示 748 条、100%，每页 50 条。
- 真实 Keyword Blocking Policy：2／2 通过，父报告显示 Rule acceptance，按需加载 5 spans；用例原文由子报告持有，父报告引用同一证据。
- 截图：`output/report-memory-ui.png`、`output/report-policy-ui.png`。隔离压测 namespace 与 PostgreSQL 回归容器在验证后清理，普通 `tali` 环境继续运行。
