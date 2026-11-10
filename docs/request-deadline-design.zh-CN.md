# Guard 请求生命周期与固定 5 秒截止时间

状态：设计方案，2026-11-09。尚未实施或部署；当前集群上一轮设置的 90 秒仍需在实施时移除。该设计取代通过增大 Scan timeout 完成 Benchmark 的临时方案。

## 目标与边界

在线 F5 Scan 固定使用 5,000 ms 的服务端总预算，不提供 Guardrail、Endpoint、模型或 Helm 层面的延长选项。鉴权、读取请求体、排队、路由、所有检查、二次复核和响应收尾均计入总预算。子操作只允许缩短截止时间，不能重新获得完整预算。

本次先覆盖 F5 独立扫描；复用的生命周期基础设施可用于其他 Adapter。流式生成的整个对话不应直接套用一次扫描的 5 秒定义，需要另行明确每次受保护输出的边界。

5 秒保证的是在服务入口边界停止等待、终止本次检测并拒绝未获安全确认的请求，不保证模型总能在 5 秒内给出正确分类。客户端到入口的网络传输不包含在服务内部耗时承诺中。需同时度量及时成功判定率、准确率和错误率，不能把超时后的拒绝计为正确检测。

## 当前代码的问题

| 位置 | 已确认的行为 | 影响 |
| --- | --- | --- |
| `runner/scan.py` | 先申请项目许可、读取请求体，再调用带 timeout 的 `evaluate_standalone` | 排队与读请求体没有纳入同一个总预算 |
| `runner/scan.py`、`runner/toolkit/runtime/service.py` | 遥测及路由 completion 在 timeout 区域外继续 await | 检测超时不等于响应及时结束 |
| `runner/toolkit/nemo/runtime.py` | Action 用当前时间加自身 timeout 创建 deadline；引擎预算按模块累加 | 下层不知道请求真正还剩多少时间，容易启动已经无望完成的调用 |
| NeMo 0.24.0 的 Colang 2 `RuntimeV2_x.process_events` | 用 `create_task` 启动 Action，用 `asyncio.wait` 等待，取消外层等待时未统一取消这些 Action | 当前完整护栏所用 LLMRails/Colang 2 路径需要补齐请求到 Action 的取消传播 |
| `runner/toolkit/nemo/queue_context.py` | 仅在 IORails profile 下为 NeMo 队列复制 ContextVars | 传播了诊断信息，但没有把已执行工作与调用方的取消绑定；不能将此队列实验直接归因于当前 Colang 2 Benchmark |
| `runner/toolkit/nemo/evaluators/classifier_review.py` | 复核在 Action deadline 内最多进行两次读取尝试 | 必须改为消费请求剩余预算，在线路径默认不重试已发送的推理 |

当前安装版本为 NeMo 0.24.0。已保存的全特性护栏遥测使用 `llmrails_colang2_programmable`；`registry.py` 也显式按 profile 选择引擎。需要区分以下两条执行路径。

2026-11-09 使用当前 Colang 2 Runtime、无模型的合成 Action 离线复现：启动 `process_events(..., blocking=True)`，等待 Action 开始，再取消调用任务。结果为：

```json
{
  "caller_cancelled": true,
  "action_cancelled": false,
  "action_still_running": true,
  "action_completed_after_caller_cancel": true
}
```

另使用 IORails 所用的 NeMo 队列及项目的 context 补丁复现：启动一个工作项，等待它进入执行，再取消 `queue.submit()` 的调用任务。结果为：

```json
{
  "caller_cancelled": true,
  "work_cancelled": false,
  "busy_workers_after_caller_cancel": 1,
  "work_completed_after_caller_cancel": true
}
```

两项复现分别证明对应路径的取消传播缺口，不据此推定某条历史 Benchmark 的全部耗时原因。当前完整护栏优先修复 Colang 2 Action 的生命周期归属。

## 实现选择

Python 3.13 标准库已有 `asyncio.timeout_at()` 和 `TaskGroup`；可以用绝对截止时间和请求拥有的任务组实现。异常清理后必须继续传播 `CancelledError`，不能吞掉取消。[Python 文档](https://docs.python.org/3.13/library/asyncio-task.html)

AnyIO 的 `CancelScope` 提供嵌套取消和有效 deadline，更接近 Go context 的使用体验。但已有 Runner/NeMo 大量使用 asyncio，AnyIO 的取消语义也不同；引入它仍不能自动修复已有的独立 worker。建议保持 asyncio，在项目中增加轻量的 `ExecutionContext`，不用第三方 Go context 仿制包。[AnyIO 文档](https://anyio.readthedocs.io/en/stable/cancellation.html)

`contextvars` 只用于携带 request ID、trace 和当前执行上下文，不能充当取消机制。Go context 本身同样要求下游协作响应取消，并不是强制杀死执行线程的机制。[Go context 文档](https://pkg.go.dev/context)

## 每个请求一个 ExecutionContext

在 ASGI 入口、任何排队和读取 body 之前创建，字段至少包括：

- `request_id`、入口单调时钟 `started_at`、只读的 `deadline_at`。
- 当前阶段和终态；取消原因：deadline、客户端断开、服务关闭、确定拦截后的短路。
- 已固定的 Router、Guardrail、模型绑定版本，仅用于归属和追踪。
- 请求拥有的子任务集合、排队项和释放句柄。
- 有上限的增量证据记录：已完成检查、进行中的调用、未启动检查、调用尝试和资源释放状态。

核心操作为 `remaining()`、`check_active()`、`spawn()`、`cancel(cause)`、`finish_once(outcome)`。所有子任务共享根截止时间；可以派生更早的内部阶段截止时间。核心执行接口显式接收 context，深层诊断通过 ContextVar 获取。

```text
received → authenticating/reading → queued → evaluating ↔ reviewing
                                             ↓
                     completed | timed_out | unavailable | cancelled
                                             ↓
                                  finalized（仅一次）
```

进入终态后禁止新模型调用、重试、重新排队及迟到结果写回。状态、trace 与资源释放各有明确归属，不能只在最终 `decision` 形成后才保存证据。

## 固定预算的执行规则

建议以 `入口时间 + 5 秒` 为最终响应边界，在内部更早结束检测，预留收尾时间。初始预算示例如下；这些是实现中的调度目标，需压测验证，不作为可配置产品参数。

| 相对入口时间 | 目标 |
| --- | --- |
| 0–0.2 s | 鉴权、读取有大小限制的 body、路由和准入；拥塞时尽早拒绝 |
| 截至 1.4 s | 本地规则与 Laya 首轮的主要执行预算；更早出现 Unknown 可立即提交复核 |
| 截至 4.5 s | 完成尚需的独立复核；所有检查共用剩余预算 |
| 4.5–4.8 s | 停止检测、取消工作、形成响应和最小审计记录 |
| 截至 5.0 s | 入口独立截止保护，拒绝继续等待 |

不能给每条 Policy 分配独立的 5 秒，也不能在 Laya 耗尽 5 秒之后再启动复核。模型内部 queue、连接、读取和必要的退避都消耗相同剩余时间。HTTPX 的 read timeout 是等待数据块的限制，不能代替整个请求的总 deadline。[HTTPX 文档](https://www.python-httpx.org/advanced/timeouts/)

Laya 的合法 Unknown 或明确截断可以进入已绑定的复核模型；模型不可达、调用超时仍属于依赖故障。若以后需要在主模型故障时切换备用模型，应作为单独的高可用策略设计，并在剩余预算内提前切换，不把它混为 Unknown 复核。

在线请求默认不重试已经发送的推理。只允许在有足够剩余预算且确认尚未执行时，进行受限的连接恢复；临近截止时间不重试。无可用额度、排队拥堵或依赖熔断时快速返回错误，避免所有请求占满 5 秒。

只对内容视图、依赖和动作优先级允许的检查做并行；不直接把整条 Policy 链全部并发。Laya 服务并发 1 的容量限制仍然有效。后续可评估同语义输入的批量判定或复核合并，必须独立验证覆盖和误判，不能为时延省略必需检查。若部署容量无法满足预算，需要改进模型服务或推理方式。

## 取消传播与资源清理

1. 入口 deadline 到达、客户端断开或服务关闭均取消请求任务树。body 的 ASGI 消息由单一消费者处理，避免额外的断连轮询抢走请求数据。
2. 项目许可、模型 semaphore、NeMo 队列等待均必须响应取消；已经过期的排队项不得发起 HTTP 调用。
3. 当前 Colang 2 路径在项目注册的 Action 入口关联正在执行的 task 与请求 context，取消请求时停止其 Action 及后续调用。若启用 IORails，长驻 worker 为每个工作项创建并注册请求拥有的子任务；取消该子任务而不是整个 worker，否则会逐步耗尽工作池。两条路径均覆盖“取消与工作开始同时发生”的竞态。
4. HTTP 请求取消后关闭本地连接并释放本地资源；迟到结果不改变已经提交的终态。HTTP 断连不保证远程 GPU 推理已停止，需由自部署模型服务支持 deadline/cancel 或自己的有界执行与准入，并记录取消是否得到确认。
5. 请求内清理不得新增数秒 shield 或在 `finally` 中无限等待。常规遥测投递由服务生命周期内的有界持久队列负责，最小审计写入和响应预算一致；审计写入失败要保留错误和计数，不能静默丢弃，也不能无限阻塞。
6. 对不响应取消的工作记录取消超时并隔离。同步长时间 CPU 工作不得阻塞入口事件循环；必要时放到可终止的独立进程。线程本身无法通过 asyncio cancellation 强制终止。

`TaskGroup` 退出也会等待子任务；仅套一层 timeout 并不能对阻塞事件循环或吞掉取消的代码形成硬截止。因此需要独立于 Runner 执行进程的入口截止保护。该入口固定使用相同 5 秒合同，不对用户开放调整；内部使用更早的检测截止时间。如果客户端直接访问 Runner，就不能宣称已具备进程失去响应时的独立 5 秒响应保证。

## 超时如何处理

建议在当前 Enforce 场景采用拒绝继续执行的行为，同时保持分类结果与执行状态分离：

| 情况 | F5/API 处理 | 判定/遥测 |
| --- | --- | --- |
| 所需检查完成，确认安全 | 正常 Allow | completed |
| 确认违规 | 正常策略 Block/Transform | completed，保留命中原因 |
| 复核在预算内返回 Unknown | 正常 Block | completed，classification unknown |
| 总 deadline 或必需模型调用超时 | HTTP 504，不放行业务请求 | execution timeout，保留已完成和未完成项 |
| 依赖不可达、熔断、必需检查失败 | HTTP 503，不放行 | execution unavailable/error |
| 尚未获得执行容量且拥塞 | HTTP 429，提供有界重试提示 | admission rejected |
| 客户端断开 | 停止计算，不再尝试写响应 | cancelled，client_disconnect |

504 沿用 F5 错误响应形式，不伪装成 HTTP 200 的策略命中。接入方必须将非成功响应视为未获放行许可；单独提供扫描 API 无法替客户端保证业务不会继续。Monitor 场景可以保持显式观察语义，但不能成为 Enforce 超时后自动降级的通道。

类似系统中，gRPC 的截止时间到达会返回 `DEADLINE_EXCEEDED`，下游工作仍需要应用负责停止；跨服务传递的是扣除已消耗时间后的预算，不能传播跨机器不可比较的本地单调时间值。[gRPC deadlines](https://grpc.io/docs/guides/deadlines/)

Envoy 外部授权默认 `failure_mode_allow=false`，授权服务错误时拒绝请求，并允许显式的 fail-open 配置。其 HTTP ext_authz 默认错误状态为 403；本项目建议保留 503/504 区分依赖故障与策略违规。这里借鉴的是故障时的授权行为，不声称各系统都采用同一种状态码或超时长度。[Envoy ext_authz](https://www.envoyproxy.io/docs/envoy/latest/api-v3/extensions/filters/http/ext_authz/v3/ext_authz.proto.html)

## 实施顺序与验收

1. 增加统一 ExecutionContext，贯穿 Scan 入口、准入、Runtime、模型调用和复核；首先修复当前 Colang 2 Action 的取消归属，并为 IORails 队列路径补充相同约束。
2. 移除新增的 `runner.scanTimeoutSeconds`、在线 `GUARD_SCAN_TIMEOUT_SECONDS` 和分散的总预算覆盖路径。模型在线调用只消费剩余预算；控制面验证任务的预算与在线请求明确分离。
3. 将收尾、审计和响应纳入固定预算，提供独立入口截止保护。删除已有 Helm 90 秒覆盖并确认所有入口流量经过同一截止保护。
4. 完成断连、队列取消、延迟和故障注入测试后，部署并重新运行原始 Benchmark。

无需 Z790 即可验证：

- 请求体慢读、项目排队、NeMo 排队、模型排队、连接卡住、持续慢速返回 body 都不会获得新的总预算。
- 已开始和未开始的工作项取消后，不再发起新调用，池中 worker 数量和 semaphore 恢复正确。
- Laya 在截止前返回 Unknown，但复核无法完成时，返回 504，不返回 Allow，也不伪造明确违规。
- 复核返回 Unknown、模型超时和客户端取消三种路径保持不同状态。
- 日志服务卡住、迟到成功、重试、多个任务同时结束不会导致双响应、双完成事件或泄漏。
- 事件循环被故意阻塞时，独立入口仍在固定期限结束等待；测试单独报告远程推理是否取消成功。

验收同时报告：服务入口 P50/P95/P99、超时率、取消完成率、残留任务数、队列等待、模型耗时、及时有效判定率及每数据集准确率。端到端成功率分母包含所有计划请求，超时拒绝不能算正确识别。离线模拟证明生命周期约束，真实模型是否能在 5 秒内达到全部数据集超过 70%，仍须在服务恢复后测量。
