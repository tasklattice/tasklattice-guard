# Laya Decision Model

Laya 是独立的 Decision Model 适配。初始实现按 JEV 的 `/systemone` 与 Noul 概率协议复制，覆盖输入内容安全、越狱检测、话题控制，以及外部内容/记忆中的越狱判定。复制的是初始实现和问题设计，不假定两款模型的概率分布或检测质量相同。

## 独立配置

| 项目 | JEV | Laya |
| --- | --- | --- |
| Provider kind | `typesafe` | `laya` |
| 完整输入协议 | `tali.typesafe-jev.v1` | `tali.laya.v1` |
| 仅话题协议 | `tali.typesafe-jev-topic.v1` | `tali.laya-topic.v1` |
| Transport | `typesafe_systemone` | `laya_systemone` |
| 模型 ID | 用户注册的 JEV 版本 | 初始建议为 `laya`，可填写实际版本 ID |
| 阈值环境变量 | `GUARD_JEV_LOWER_THRESHOLD` / `GUARD_JEV_UPPER_THRESHOLD` | `GUARD_LAYA_LOWER_THRESHOLD` / `GUARD_LAYA_UPPER_THRESHOLD` |
| Helm 配置 | `runner.jev` | `runner.laya` |
| 响应评估证据 | `evaluations` | `layaEvaluations`，含 `decisionModel: "laya"` |

两组阈值的代码默认值均为 **0.1 / 0.9**。修改 JEV 的实际部署阈值不会修改 Laya。若要让 Laya 的上界为 0.85，应显式配置：

```yaml
runner:
  laya:
    lowerThreshold: 0.1
    upperThreshold: 0.85
```

阈值仍属于 Runner 级配置，作用于该 Runner 上的全部 Laya 检测。它们是操作点，不是已经校准的准确率或置信度保证。

## 请求、判定与错误

在所配置的 Laya API 根地址后追加 `/systemone`，使用 Bearer 凭据。请求保持与 JEV 相同的形状：

```json
{
  "model": "laya",
  "state": {"current_input": "要检测的内容", "context_messages": []},
  "questions": {
    "unsafe_content": {"type": "noul", "instructions": {}, "criteria": {}}
  }
}
```

实际检测会填入独立维护的完整问题与类别。响应必须返回实际模型名和与请求完全对应的问题 ID：

```json
{
  "model": "laya",
  "answers": {"unsafe_content": {"type": "noul", "noul": 0.87}}
}
```

任一相关分数达到上界即命中；全部不超过下界即未命中；其余合法分数为 unknown。当前 Rule 的 `on_unknown` 单独处理灰区，不能覆盖其他 Policy 的 Block。布尔值、字符串、越界、非有限分数、缺少问题或模型名均为错误，不会转为安全判定。

`review_unknown` 与 JEV 一样可选。开启时只复核合法灰区，使用原 Laya 问题与原状态；第一阶段错误保留错误处理。复核仍需独立验证的 `classifier_review.input` 绑定。具体规则见 [灰区复核](classifier-gray-review.md)。

完整输入协议仅支持 `content_safety.input`、`jailbreak.input`、`topic_control.input`。仅话题协议只支持 `topic_control.input`。两者均不借用输出、PII 或控制面绑定，JEV Provider 也不能绑定 Laya 协议。

## 提示词与后续分化

四个独立文件位于 `runner/toolkit/nemo/evaluators/`：

- `laya.py`：传输、严格解析、阈值决策、错误与原始证据。
- `laya_content_safety.py`：内容安全问题及独立冻结的类别文本。
- `laya_jailbreak.py`：直接输入、外部内容与记忆问题。
- `laya_topic.py`：话题问题及模式处理。

这些文件不继承或调用 JEV 适配类、问题函数。问题内容最初逐项相同，Laya 使用自己的问题修订标识。今后调整 Laya 的提示词、类别、概率解析、上下文或阈值，只修改 Laya 对应实现与回归。

## 注册、验证与启用

UI 中选择 **Laya**，填写实际 API 根地址及凭据，再选择 `laya` 或实际服务提供的模型版本。模型发现为可选；目录使用与 JEV 相同的 `{"models":[{"name":"laya"}]}` 形状。

先部署包含该适配的 Controller 与 Runner，再执行注册与绑定。升级只增加可配置的 Provider 与协议，不会自动注册 Laya、替换现有 JEV 绑定或修改已发布的 Guard 与 Router。

CLI 使用同一组 Controller API：

```sh
bin/guardctl platform register-model \
  --url http://localhost:38081 --env-file /private/path/guard.env \
  --provider-name Laya --provider-kind laya \
  --provider-url "$LAYA_BASE_URL" \
  --model laya --profile tali.laya.v1 --key-env LAYA_API_KEY

bin/guardctl platform bind \
  --url http://localhost:38081 --env-file /private/path/guard.env \
  --binding content_safety.input --model-id LAYA_MODEL_ID \
  --state /private/path/laya-content-safety-binding.json
```

`LAYA_BASE_URL` 与 `LAYA_API_KEY` 由实际服务提供。注册返回的 Model ID 替换 `LAYA_MODEL_ID`。越狱及话题检测分别使用 `jailbreak.input`、`topic_control.input` 和不同的私有 state 文件。每项绑定都通过实际 Runner 的安全/违规双侧探针后再启用；模型连通性不等于检测能力通过。

## 证据与验收范围

请求 `x-guard-evidence: evaluations-v1` 后，响应头 `x-guard-evaluation-evidence` 中的 `layaEvaluations` 包括 `decisionModel`、实际模型、实际阈值、原始分数、verdict、动作、Policy 版本与 Guard 版本；可选复核证据嵌套在当前检测项中。未执行 Laya 检测时该集合可以省略。JEV 原有集合保持原含义。

自动化验证包含模拟 HTTP 契约、真实 Controller 计划到 NeMo/Runner 决策链路，以及混合模型阈值和凭据隔离。上线后还应验证实际镜像、API Schema、桌面注册入口与响应证据，并比较升级前后的模型分配、Guard 和 Router。

这些检查不能证明真实 Laya 模型的检测质量。接入实际服务后，需使用冻结数据单独验收 Laya，再显式切换相应绑定。
