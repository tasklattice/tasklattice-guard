# JEV / Laya 灰区复核

灰区复核是 JEV/Laya 输入检测、Laya 内容安全输出检测的第二阶段。第一阶段成功返回合法分数、但无法在各自配置的上下界之间作出确定判断时，调用当前 Rail 单独绑定的复核模型。Laya v2 也会对无法确认全部任务范围的复合请求返回覆盖不足的 `unknown`。第一阶段原始分数和证据保留，不因复核而改写。

| 第一阶段结果 | 处理 |
| --- | --- |
| 达到当前检测的明确命中条件 | 按当前 Rule 的命中动作处理，不调用复核 |
| 所有风险分数不超过下界（本地验收为 0.1），且无适用范围限制 | 未命中，继续其他 Policy，不调用复核 |
| 合法分数处于灰区，且 `review_unknown=true` | 使用原问题、原输入和原上下文调用复核模型 |
| Laya v2 无法确认复合请求全部任务的范围，且 `review_unknown=true` | 使用完整话题规则与整个请求复核，不独立截取句子改变语义 |
| Laya 内容安全两种表述判定不一致，或话题策略包含多项列表，且 `review_unknown=true` | 保留原始分数，按覆盖不足复核完整策略；不把相互冲突的分数强行归为安全或命中 |
| 灰区且未开启复核 | 保留该 Rule 的 `on_unknown` 行为 |
| 调用失败、非法分数、缺少上下文 | 保留错误或覆盖不足处理，不通过复核掩盖错误 |

复核严格接受每个原问题的 `yes`、`no`、`unknown`。任一 `yes` 表示命中；全部 `no` 表示该项未命中；仍有 `unknown` 表示需要上下文，保留覆盖不足处理。复核未命中只结束当前检测项，不能覆盖其他 Policy 的 Block。输出复核使用独立的 `classifier_review.output` 绑定和 `classifier-review-output.v2` 模板，不借用输入复核绑定。

## 配置

在 `classifier_review.input` / `classifier_review.output` 中显式选择已注册的 `generic-chat` 模型（包括 DeepSeek），或选择 `tali.classifier-review.v1` 协议的模型。已有 Generic chat 模型无需重复注册或修改协议，可同时保留 Control Plane 用途；未显式绑定时不会自动借用另一 Rail 或控制面模型。绑定使用实际 Runner 和独立的安全、违规样例验证，始终返回安全或始终返回违规的模型不能通过验证。缺少当前 Rail 可用的复核绑定、第一阶段不支持复核或协议不匹配时，启用复核的计划不能就绪。

无需在 Guard 中编写 Prompt Template。Runner 使用内置模板，自动渲染原判定问题、当前输入和对话上下文；Guard 的 Policy 绑定只需开启复核参数。

输出模板将 `state.current_output` 作为检查对象，上下文仅用来解析指代。用户提出危险请求并不意味着助手的安全拒绝也违规。Laya 原生输出初判只接收当前助手文本；完整对话交给灰区复核，明确初判不具备完整的上下文判断能力。

```sh
bin/guardctl platform bind \
  --url http://localhost:38081 --env-file /private/path/guard.env \
  --binding classifier_review.input --model-id REVIEW_MODEL_ID \
  --state /private/path/review-binding.json
```

在 Guard 的 Policy binding 中选用以下新版本，并设置 `parameterValues.review_unknown` 为字符串 `"true"`：

| Policy | 支持复核的版本 |
| --- | --- |
| `builtin-content-safety` | 1.2.0 |
| `builtin-jailbreak` | 1.2.0 |
| `builtin-jailbreak-strict` | 1.1.0 |
| `builtin-topic-safety` | 2.2.0 |

新参数默认 `"false"`。旧版本保留原定义，不能靠增加未声明参数开启复核。三项检测可以分别开启；`on_unknown=allow` 仍只控制当前 Rule 的第一阶段灰区处置。

输入复核提示词版本为 `classifier-review.v2`。短文本、标识符或代码片段本身不代表上下文缺失；没有问题所要求的违规行为证据时应回答 no，真正依赖缺失指代或必要上下文时仍回答 unknown。明确的违规或越权指令不因缺少额外背景变成安全。

模型只接收签名 Policy 的规范问题和原始输入/历史，不接收第一阶段分数、预期动作、数据集标签或测试结果。JEV 使用其原始问题；Laya 初判采用短问题及辅助一致性检查，复核使用对应的完整规范问题（含类别、例外和所有任务规则）。辅助问题只用于触发弃权，不添加新的策略类别。两份问题均在 Laya 适配中独立维护，不调用 JEV 的问题生成函数。

## 错误与证据

复核使用独立模型配置的超时，并受当前 Action 剩余时间约束。读取超时最多重试一次，两次共享原总预算，每次实际调用单独记账。解析失败、未知标签和最终超时都保留为错误；不会变成未命中。

请求 `x-guard-evidence: evaluations-v1` 后，响应头 `x-guard-evaluation-evidence` 中每项检测保留原模型、实际上下界、原始分数、原始 verdict、第一阶段动作、Policy 版本及 Guard 版本。存在复核时，嵌套的 `review` 记录模型、返回模型、判定、每题答案、耗时、动作和每次调用结果；`decisionSource` 与 `finalPolicyAction` 标明最终决策来源。原始 `unknown` 不会被复核结论改写。

复核增加延迟和模型调用量；链路正常不等于检测质量已经达标。验收应使用同一冻结数据、原始标签、同一评分口径，单独比较 JBB 误拦、Aegis 指标、有害/攻击召回及调用错误。

## 本地部署与回退

本地镜像应包含 Controller 的协议/Policy 定义和 Runner 的复核实现，再发布新 Guard 版本并显式切换 Router。仅修改模型绑定或重启 Pod 不会替旧 Guard 开启复核。CLI 与 UI 使用同一组 Controller API。

回退优先将 Router 切回旧 Guard 的已发布版本。若还需回退镜像，应在路由回退之后执行，避免旧 Runner 接收仍启用新参数的计划。不要先降级镜像并保留新 Guard 路由。
