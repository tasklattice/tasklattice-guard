# JEV / Laya 灰区复核

灰区复核是输入检测的第二阶段。只有 JEV 或 Laya 成功返回合法分数、但无法在各自配置的上下界之间作出确定判断时，才调用单独绑定的复核模型。原始模型问题、分类口径和第一阶段证据保持不变。

| 第一阶段结果 | 处理 |
| --- | --- |
| 任一风险分数达到上界（本地验收为 0.85） | 按当前 Rule 的命中动作处理，不调用复核 |
| 所有风险分数不超过下界（本地验收为 0.1） | 未命中，继续其他 Policy，不调用复核 |
| 合法分数处于灰区，且 `review_unknown=true` | 使用原问题、原输入和原上下文调用复核模型 |
| 灰区且未开启复核 | 保留该 Rule 的 `on_unknown` 行为 |
| 调用失败、非法分数、缺少上下文 | 保留错误或覆盖不足处理，不通过复核掩盖错误 |

复核严格接受每个原问题的 `yes`、`no`、`unknown`。任一 `yes` 表示命中；全部 `no` 表示该项未命中；仍有 `unknown` 表示需要上下文，保留覆盖不足处理。复核未命中只结束当前检测项，不能覆盖其他 Policy 的 Block。输出检测不使用此输入复核链路。

## 配置

先注册一个 `tali.classifier-review.v1` 协议的模型，再通过 `classifier_review.input` 绑定。绑定使用实际 Runner 和独立的安全、违规样例验证，始终返回安全或始终返回违规的模型不能通过验证。缺少可用复核绑定、第一阶段并非 JEV / Laya 或协议不匹配时，启用复核的计划不能就绪；不会借用输出模型或控制面编写模型。

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

复核提示词版本为 `classifier-review.v1`。模型只接收签名 Policy 的原问题和原状态，不接收第一阶段分数、预期动作、数据集标签或测试结果。复核新提示词单独版本化，未修改既有 JEV 问题；Laya 的问题在自己的适配中独立维护。

## 错误与证据

复核使用独立模型配置的超时，并受当前 Action 剩余时间约束。读取超时最多重试一次，两次共享原总预算，每次实际调用单独记账。解析失败、未知标签和最终超时都保留为错误；不会变成未命中。

请求 `x-guard-evidence: evaluations-v1` 后，响应头 `x-guard-evaluation-evidence` 中每项检测保留原模型、实际上下界、原始分数、原始 verdict、第一阶段动作、Policy 版本及 Guard 版本。存在复核时，嵌套的 `review` 记录模型、返回模型、判定、每题答案、耗时、动作和每次调用结果；`decisionSource` 与 `finalPolicyAction` 标明最终决策来源。原始 `unknown` 不会被复核结论改写。

复核增加延迟和模型调用量；链路正常不等于检测质量已经达标。验收应使用同一冻结数据、原始标签、同一评分口径，单独比较 JBB 误拦、Aegis 指标、有害/攻击召回及调用错误。

## 本地部署与回退

本地镜像应包含 Controller 的协议/Policy 定义和 Runner 的复核实现，再发布新 Guard 版本并显式切换 Router。仅修改模型绑定或重启 Pod 不会替旧 Guard 开启复核。CLI 与 UI 使用同一组 Controller API。

回退优先将 Router 切回旧 Guard 的已发布版本。若还需回退镜像，应在路由回退之后执行，避免旧 Runner 接收仍启用新参数的计划。不要先降级镜像并保留新 Guard 路由。
