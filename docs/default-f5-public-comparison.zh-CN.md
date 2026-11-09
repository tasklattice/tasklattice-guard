# 新版 Default：真实 F5 Scan Endpoint 与直接 Service 的公开评估对照

日期：2026-10-19。参照为[上一轮真实模型 Service 评估](default-model-public-comparison.zh-CN.md)。本轮保留相同样本、标签、Default 计划、模型、提示词模板和 Runner 源码，增加实际 HTTP 请求、Endpoint 凭据校验、Router 选择、签名工件加载及 F5 Scan 结果映射。

结论：在相同单段输入和固定模型响应下，Service 与完整 Scan 链路的 5214/5214 条状态和决策一致，flagOnly 的协议映射控制也全部通过。真实调用的 Jailbreak 攻击结果与上轮一致；内容公开集有 61 条有效决策差异，其中 56 条来自原本带用户上下文的输出样本。Scan 的单段协议缺少这部分上下文，不能据此宣称与完整上下文 Service 等效。

## 运行边界

使用隔离的真实 TCP Runner，监听本机随机端口，实际调用生产 `RunnerAPI` 的 `f5-scan` 路由；没有使用 ASGI 假请求、模拟鉴权、模拟 Router 或模拟实时推理。该运行没有连接现有 Controller 的同步通道，签名工件及路由由评估启动程序装载，遥测写入本地证据目录。它验证完整 Scan 请求执行链，不验证 Controller 发布／同步或现有集群 Ingress。

现有 OrbStack 部署在运行前仍使用 32-Policy 旧 Default。为了对齐上一轮 34-Policy 新版计划，本轮启动独立 Runner；没有升级共享集群、改变已部署模型分配、修改现有 Endpoint／Router 或切换系统基线。原部署的只读检查记录见 `shared-deployment-before.json`。

冻结的 5,214 条检查分别以 `flagOnly=false` 和 `true` 完成真实推理，共 10,428 次正式 Scan HTTP 请求、18,949 次实际模型请求。包含 3,431 条内容公开检查、31 条自编诊断、1,752 条 Jailbreak 专题检查；套件有重叠，模式重复也不算新增独立样本。两种模式分别重做推理，并非复用缓存。

## 与上轮 Service 的实测对比

下表按双方均得到确定结果的同一批样本计分，使用 Endpoint 的执行模式。错误和 unknown 单列；正常标签下的阻断仍称为误拦候选，transform 不等于已消除风险。

| 指标 | 上轮直接 Service | 本轮 F5 Endpoint，flagOnly=false |
| --- | ---: | ---: |
| Jailbreak 攻击整链有效阻断 | 374/382（97.91%） | 374/382（97.91%） |
| 内容风险参照有效阻断 | 1285/1354（94.90%） | 1265/1354（93.43%） |
| 内容风险参照明确放行 | 51/1354（3.77%） | 68/1354（5.02%） |
| 内容风险参照仅变换，残余未定 | 18/1354（1.33%） | 21/1354（1.55%） |
| 正常参照误拦候选 | 444/1555（28.55%） | 427/1555（27.46%） |

内容公开集的最终决策一致度：3360/3421（98.22%）；Jailbreak 攻击集：382/382（100.00%）。这些是跨次真实推理的比较，不能仅由分数差异推断 Adapter 改变了模型能力。

| 切片 | 风险阻断：Service → Endpoint | 正常误拦候选：Service → Endpoint | 有效决策一致度 |
| --- | --- | --- | --- |
| aegis/input | 678/728（93.13%） → 677/728（92.99%） | 217/886（24.49%） → 218/886（24.60%） | 1916/1921（99.74%） |
| aegis/output | 257/268（95.90%） → 238/268（88.81%） | 144/419（34.37%） → 126/419（30.07%） | 757/813（93.11%） |
| xstest/input | 170/173（98.27%） → 170/173（98.27%） | 83/250（33.20%） → 83/250（33.20%） | 448/448（100.00%） |
| harmbench/input | 180/185（97.30%） → 180/185（97.30%） | 未测 → 未测 | 239/239（100.00%） |
| jbb_benign/input | 未测 → 未测 | 44/100（44.00%） → 44/100（44.00%） | 100/100（100.00%） |
| jbb_attack_GCG/input | 93/100（93.00%） → 93/100（93.00%） | 未测 → 未测 | 100/100（100.00%） |
| jbb_attack_PAIR/input | 81/82（98.78%） → 81/82（98.78%） | 未测 → 未测 | 82/82（100.00%） |
| jbb_attack_JBC/input | 100/100（100.00%） → 100/100（100.00%） | 未测 → 未测 | 100/100（100.00%） |
| jbb_attack_prompt_with_random_search/input | 100/100（100.00%） → 100/100（100.00%） | 未测 → 未测 | 100/100（100.00%） |

JailbreakDetect 在 382 条攻击中的阶段判定：执行模式 `{"not_matched": 282, "matched": 100}`，标记模式 `{"not_matched": 282, "matched": 100}`。这与整链阻断是不同指标，内容安全或本地规则也可终止攻击输入。

## flagOnly：标记与实际执行

| 正式 Scan 返回 | flagOnly=false | flagOnly=true |
| --- | ---: | ---: |
| cleared | 1259 | 1261 |
| blocked | 3634 | 0 |
| redacted | 287 | 0 |
| flagged | 19 | 3941 |
| no_outcome | 15 | 12 |

`flagOnly=true` 下的 `flagged` 表示检测到需要标记的情况，不能按 HTTP Scan 的实际 `blocked` 计分。内部 block 和 transform 都可能映射为 flagged；公开质量表采用内部确定的 block 判定，外部执行表单独统计 blocked。

382 条 Jailbreak 攻击是直接的例子：执行模式返回 374 个 blocked、3 个 redacted、5 个 cleared；标记模式返回 377 个 flagged 和 5 个 cleared。不能把其中的 flagged 数直接称为攻击阻断数。

本实现的 flagOnly 只改变 outcome 映射，内部请求仍为 enforce。它不会绕过模型或规则：`redactedInput` 仍可能包含改写，输出方向内部 block 时 `result.response` 仍为 null。因此 flagged 也不意味着“模型判为安全”或“原文一定原样交付”。

在内容公开集正常参照中，标记模式返回 flagged 为 643/1555（41.35%）；这包括会阻断、会变换及仅标记的情况，不能与实际误拦率直接等同。

执行模式仍有 19 条内部 allow、对外 flagged 的确定结果。这是现有 Scan 映射对模块 `intervene` 状态的处理，不能计为实际阻断；逐例索引见 `comparison.json.flagged_internal_allow`。

两种真实推理模式在 5196 条双方有效检查中有 10 条内部决策不同。已逐项核对两种模式实际发生的对应模型请求体完全相同；flagOnly 本身没有传入模型或改变内部 enforce 模式。远端推理结果可能波动，提前终止造成的调用数量差异另列。下面的同响应控制专门检查这一点。

## 固定模型响应后的链路一致性

使用执行模式已录下的原生响应做独立控制：服务端仍走同一生产代码，模型传输层要求 host、path、JSON 请求体逐项相同，才返回对应响应；没有模糊匹配、在线回退或额外模型调用。控制结果不混入真实模型质量分数。

- Scan 的原文／方向投影到直接 Service：5214/5214 条状态和内部决策相同；文本数组差异 0 条。
- 同一模型响应经真实 TCP 的 flagOnly=true 路径：5214/5214 条 HTTP 状态、预期 outcome 映射和返回内容一致；差异 0 条。
- 运行时记录的模型调用数与实际 HTTP 记录逐条核对；每个 Scan 的请求 ID 唯一，路由版本和 Guardrail 身份均核对。

## 历史输入与错误边界

Scan 协议只提交单段 input 和方向。本轮没有把历史拼入文本，也没有声称额外 messages 字段能生效。上一轮 Service 的 813 条 Aegis output 带用户上下文，另有 2 条自编 input 带历史；这些样本在 Scan 中失去历史，不能视为完全相同的模型输入。原文和标签保留相同，报告按有／无历史分别比较。

原生模型请求核对发现 814 条调用序列与上轮不同，其中 813 条涉及历史省略。没有历史的样本，在两边实际发生的对应调用中，模型请求体逐项相同；调用数量差异单独记录，不能视为文本被改写。

一个有意选取的机制例子是 `aegis:0f46b881a15b4731b44e87076a703b92:output`：原用户上下文涉及冒充医院诈骗，输出作含糊赞同；Service 阻断，单段 Scan 放行。只看输出看不到其所赞同的行为背景。这个例子保留原标签，不是独立盲审或代表性抽样；证据索引见 `context-loss-example.json`。

- 原本无历史：4399 条；双方有效决策一致 4379/4384（99.89%）。
- Scan 省略历史：815 条；双方有效决策一致 759/815（93.13%）。

执行模式状态：`{"complete": 5199, "execution_error": 11, "indeterminate": 4}`；标记模式状态：`{"complete": 5202, "execution_error": 6, "indeterminate": 6}`。对应 HTTP 状态分别为 `{"200": 5199, "503": 15}` 和 `{"200": 5202, "503": 12}`。

内容公开集原有 1558 条正常参照中，执行模式另有 3 条 HTTP 错误，标记模式另有 3 条。这些会影响可用性，但与模型误拦候选分开统计。

模型错误导致的内部保守 block 不记为有效检出。Scan 可能把这种执行失败转换为 HTTP 503；unknown 也按内部证据另列，不把失败返回和正常的安全分类混为一谈。未形成确定判定的逐例记录见 `comparison.json.errors`。

## 性能、证据与适用范围

- 时间：2026-10-19T06:07:55.224663+00:00 至 2026-10-19T06:52:41.455260+00:00（UTC）。
- Endpoint：`http://127.0.0.1:52469/runtime/v1/endpoints/739aab13-3190-4d9f-90c3-48e9522cb923/backend/v1/scans`；运行结束后隔离进程关闭。
- 冻结计划 SHA-256：`7d07397f9f0aedbe82280cdc163e670c9c9d7cbf06f781d527b85a263be66ba2`；模型配置 SHA-256：`133ace246688776ef622d46c634ce08c4649ac2cd95afc7a2de95a78f14c6ad8`。
- 模型仍为 NVIDIA `nemoguard-jailbreak-detect` 和 `llama-3.1-nemotron-safety-guard-8b-v3`，8 个并发检查，Scan 总超时 25 秒、模型调用超时 30 秒，客户端 40 秒，不重试。
- 本机 TCP 单次请求耗时：执行模式 p50/p95 为 1917/3177 ms；标记模式为 1990/3243 ms。不包含客户端排队等待，不是集群／公网 SLO。
- 正式模型 HTTP 状态：`{"200": 18944, "502": 5}`。预检和早期 smoke 调用另存，不进入正式分数。
- API 实际返回的 token 用量：`{"prompt_tokens": 8315683, "total_tokens": 8549645, "completion_tokens": 233962}`；Jailbreak 分类服务没有 token 用量，未推算金额。
- 输入集、标签、原始 HTTP、内部判定、路由遥测、源码和依赖快照、签名工件、评分脚本及校验和均留存；凭据不进入证据包。

验证包括 93 项 Scan 协议与评分测试通过，以及真实 HTTP 预检中的鉴权、非法参数、默认 flagOnly 和显式模式检查。共享部署的 Default、活动模型版本、Endpoint 和 Router 前后复核一致，见 `shared-deployment-after.json`。

证据目录：[`output/default-f5-public-evaluation/live-20261019`](../output/default-f5-public-evaluation/live-20261019/)。关键文件为 `comparison.json`、`live/results.jsonl`、`live/decisions.jsonl`、`live/model-http.jsonl`、`controls/`、`manifest.json` 和 `checksums.json`。

本轮未执行目标模型生成或攻击成功率评估，没有独立审查变换后的语义风险。公开集训练重叠及托管模型权重版本不可见的限制继承上一轮报告。现有集群升级、Controller 发布同步、Ingress／多副本、真实业务模型交付需要各自的验收，不能由本机隔离 Endpoint 结果替代。

后续若要求 Scan 与带上下文的 output Service 具有相同能力，应先明确输出扫描需要的用户上下文传递契约，再做相同样本与保留集验证。当前数据不支持把漏检变化归因于 F5 包装层算法，也不支持把误拦下降单独称为质量改进。
