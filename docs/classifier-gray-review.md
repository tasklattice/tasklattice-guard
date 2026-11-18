# JEV / Laya 灰区复核

灰区复核是 JEV/Laya 输入检测、内容安全输出检测及语义 PII 输入/输出检测的第二阶段。第一阶段成功返回合法分数、但无法在各自配置的上下界之间作出确定判断时，调用当前能力和 Rail 单独绑定的复核模型。Laya v2 也会对无法确认全部任务范围的复合请求返回覆盖不足的 `unknown`。第一阶段原始分数和证据保留，不因复核而改写。

| 第一阶段结果 | 处理 |
| --- | --- |
| 达到当前检测的明确命中条件 | 按当前 Rule 的命中动作处理，不调用复核 |
| 所有风险分数不超过下界（本地验收为 0.1），且无适用范围限制 | 未命中，继续其他 Policy，不调用复核 |
| 合法分数处于灰区，且当前能力和 Rail 有生效的复核模型 | 使用原问题、待检查的输入/输出和原上下文调用复核模型 |
| Laya v2 无法确认复合请求全部任务的范围，且当前能力和 Rail 有复核模型 | 使用完整话题规则与整个请求复核 |
| Laya 内容安全两种表述判定不一致，或话题策略包含多项列表，且当前能力和 Rail 有复核模型 | 保留原始分数，按覆盖不足复核完整策略 |
| Laya 返回合法结构但报告输入截断，且当前能力和 Rail 有复核模型 | 将片段分数保留为丢弃证据，使用完整原文和上下文复核 |
| 当前能力和 Rail 没有复核模型，初判返回普通灰区 | 按该 Rule 的 `on_unknown` 处理 |
| 当前能力和 Rail 没有复核模型且发生截断，或初判调用失败、分数非法、缺少上下文 | 按错误或覆盖不足处理 |

聊天模型复核严格接受每个原问题的 `yes`、`no`、`unknown`。任一 `yes` 表示命中；全部 `no` 表示该项未命中；仍有 `unknown` 表示复核仍不确定：对于启用拦截的 Rule，正常返回 Block，保留 Unknown 证据，不伪装成明确命中或调用错误。复核未命中只结束当前检测项，不能覆盖其他 Policy 的 Block。安全类输出复核使用共享模型和 `classifier-review-output.v2` 模板。Qwen3Guard 使用下文的原生标签协议。

模型调用证据与对应内容块的最终判定关联。首次调用超时而内部重试成功时，保留两次调用以及超时诊断，并将已恢复的诊断标为 `affectsResult=false`；最终仍不确定则正常 Block，最终调用失败则保留执行错误。这适用于输入、输出及各自独立的复核绑定。

截断也保留原生调用的 `LayaInputTruncatedError`、用量及丢弃分数，最终结果由独立复核决定。`on_unknown=allow` 仅用于没有复核模型时的普通灰区。模型网络不可达、HTTP 错误及非法响应沿用执行错误路径。

外部内容的判定问题还检查重复或条件性的行为建议，包括代码注释、配置说明中的跳过认证或安全检查要求。“可信环境”声明不构成授权。正常代码说明、反对绕过的警告及无关的软件禁用状态本身不属于这种引导。该问题供可配置的复核模型使用，不绑定具体供应商。

## 配置

内容安全、越狱、Topic Control 和语义 PII 默认使用内置 Laya 初判，无需选择、注册或保存初判模型。防护能力页面提供两项可选复核配置。

| 复核绑定 | 可选模型协议 |
| --- | --- |
| `classifier_review.security`（内容安全、越狱、语义 PII） | Qwen3Guard、`generic-chat`、`tali.classifier-review.v1` |
| `classifier_review.topic_control.input` | `generic-chat`、`tali.classifier-review.v1`；不接受 Qwen3Guard |

同一独立检查组的 Laya 初判可[合并为一次本地前向](laya-batched-inference.md)。安全复核使用 Qwen3Guard 时，相同内容块和上下文的安全项共用一次原生审核响应，并按各自类别判定。通用聊天模型可在一次请求中回答同组并发就绪的安全项，保留每项自己的问题和上下文。话题复核使用独立请求。

未配置某项复核时，以该能力的 Laya/JEV 初判为最终检测结果；初判为 Unknown 时沿用 Rule 的 `on_unknown`，调用错误和覆盖不足仍按原路径处理。特别是 Topic 未配置时，不会借用内容安全、越狱或 PII 的复核模型，也不会人为追加一条失败或 Unknown 的复核结果。选中“不复核，使用初判结果”并保存、应用，即可取消该能力的复核。

设置页的安全复核验证使用同一轮测试对话。Runner 先用一次请求复核用户输入的内容安全、越狱和语义 PII，再带上原始用户输入，用一次请求复核预设模型回复的内容安全和语义 PII。每项判定都必须符合预期。验证证据按这两个阶段列出分项结论和实际 HTTP 往返，重试单独计数。话题复核仍使用允许范围内的产品支持请求及范围外的菜谱请求。

升级时，旧的 `classifier_review.input` / `classifier_review.output` 设置只迁移到对应阶段的安全类复核；Topic 保持未配置。显式保存的空值优先于旧设置。旧回执不会被当作新能力的验证证据，需按新的绑定重新验证。

聊天模型使用 Runner 内置模板，自动渲染原判定问题、当前输入或输出，以及对话上下文。

输出模板将 `state.current_output` 作为检查对象，上下文仅用来解析指代。用户提出危险请求并不意味着助手的安全拒绝也违规。Laya 原生输出初判只接收当前助手文本；完整对话交给灰区复核，明确初判不具备完整的上下文判断能力。

```sh
bin/guardctl platform bind \
  --url http://localhost:38081 --env-file /private/path/guard.env \
  --binding classifier_review.security --model-id REVIEW_MODEL_ID \
  --state /private/path/review-binding.json
```

语义 PII 复核确认命中后，按当前 Rule 的动作处理。`transform` 使用适配器固定的 `[PII_REDACTED]` 替换整个被检查块。未命中时保留原文。启用拦截的 Rule 在复核仍为 Unknown 时返回 Block，执行错误按错误路径处理。

输入复核提示词版本为 `classifier-review.v2`。短文本、标识符或代码片段本身不代表上下文缺失；没有问题所要求的违规行为证据时应回答 no，真正依赖缺失指代或必要上下文时仍回答 unknown。明确的违规或越权指令不因缺少额外背景变成安全。

聊天复核模型只接收签名 Policy 的规范问题和原始输入/历史，不接收第一阶段分数、预期动作、数据集标签或测试结果。JEV 使用其原始问题；Laya 初判采用短问题及辅助一致性检查，复核使用对应的完整规范问题（含类别、例外和所有任务规则）。辅助问题只用于触发弃权，不添加新的策略类别。两份问题均在 Laya 适配中独立维护，不调用 JEV 的问题生成函数。

### Qwen3Guard 原生复核

注册 Qwen3Guard-Gen 的 OpenAI 兼容服务时，保留模型协议 `tali.qwen3guard.v1`，再将其绑定到分类灰区复核。服务须使用模型自带的聊天模板。Runner 将原始对话作为 `messages` 发送到 `/chat/completions`：输入检查以 `user` 消息结束，输出检查以当前 `assistant` 回复结束；不将问题 JSON 当作被检查文本。详见 [Qwen3Guard 官方协议](https://github.com/QwenLM/Qwen3Guard#qwen3guard-gen)。

复核按 Qwen3Guard 自身的安全标准解释 `Safety` 和 `Categories`，不声称逐一回答可自定义的 Policy 问题：

| 原生结果 | 当前检测的复核结果 |
| --- | --- |
| `Safe` | 未命中 |
| `Unsafe` 且包含当前检测适用的类别 | 命中；PII 的 transform 仍使用固定的整块脱敏 |
| `Controversial` 且包含适用类别，或类别无法映射 | Unknown；启用拦截的 Rule 保守 Block |
| 所有类别均已知，但只属于其他检测 | 当前检测未命中，不覆盖其他 Rule 的判定 |
| 缺少、重复或冲突的标签、非法响应 | 执行错误 |

支持内容安全、直接用户越狱及输入/输出语义 PII。越狱须出现 `Jailbreak` 类别，PII 须出现隐私类别，不能把其他不安全类别当作它们的命中。输出里的 `Refusal` 只描述是否拒答，不能覆盖 `Safety: Unsafe`。

业务话题边界由独立的话题聊天复核模型判断，不能把 Qwen3Guard 绑定到话题复核。Qwen3Guard 不支持的外部内容和记忆攻击信任边界或新增问题，仍保留 Unknown 和未覆盖原因；需要这些能力时，在安全复核项选择能够回答完整问题的聊天模型。原生模型的安全标准也可能与自定义 Policy 的判据不同，应通过完整 GuardRail 测试确认效果。

原生复核版本为 `qwen3guard-review.v1` / `qwen3guard-review-output.v1`。证据保留协议、原生安全标签、类别和覆盖范围，`answers` 为空；Laya/JEV 的原始分数继续保留。超时、重试、并发限制和计费证据与聊天复核共用。

离线运行 `scripts/evaluate_laya.py` 时，`--review-model`、`--review-base-url`、`--review-key-env` 只配置安全类复核，加上 `--review-profile tali.qwen3guard.v1` 可使用原生复核。Topic 需单独提供 `--topic-review-model`、`--topic-review-base-url`、`--topic-review-key-env`，协议默认 `generic-chat`；未提供时直接保留 Laya 结果。

## 错误与证据

复核使用独立模型配置的超时，并受当前 Action 剩余时间约束。读取超时最多重试一次，两次共享原总预算，每次实际调用单独记账。解析失败、未知标签和最终超时都保留为错误；不会变成未命中。

请求 `x-guard-evidence: evaluations-v1` 后，响应头 `x-guard-evaluation-evidence` 中每项检测保留原模型、实际上下界、原始分数、原始 verdict、第一阶段动作、Policy 版本及 Guard 版本。存在复核时，嵌套的 `review` 记录模型、返回模型、判定、每题答案、耗时、动作和每次调用结果；`decisionSource` 与 `finalPolicyAction` 标明最终决策来源。原始 `unknown` 不会被复核结论改写。

复核增加延迟和模型调用量；链路正常不等于检测质量已经达标。验收应使用同一冻结数据、原始标签、同一评分口径，单独比较 JBB 误拦、Aegis 指标、有害/攻击召回及调用错误。

## 本地部署与回退

CLI 与 UI 使用同一组 Controller API。应用当前能力和 Rail 的绑定可以调整或取消复核。使用固定模型配置的项目组，应按该项目组的配置刷新流程应用变更。
