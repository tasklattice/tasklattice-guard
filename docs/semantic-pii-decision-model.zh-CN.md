# 语义 PII Detector 切换到 Decision Model（Laya / JEV）技术方案

本文评估把 `builtin-pii` 的语义阶段（`tali.guard.pii.semantic.v1`）从当前的
OpenAI-compatible PII judge（DeepSeek `deepseek-chat`）切换到 Laya / JEV 这类
Decision Model 的可行性与实现路径。所有实测数字来自本仓库外的真实端点，样本为合成数据，
不是生产准确率，也不构成对任何模型的质量背书。

> **实施更新（2026-11-06）：** 实际落地选择把 PII 直接加到现有
> `tali.laya.v1` 和 `tali.typesafe-jev.v1`，不新增 profile。Laya 采用
> `name / actual_identifier / address / dob` 四问，默认 `0.1 / 0.9` 下控制面
> 双例 Validate 在 **input 和 output** 都已实测通过（input 安全
> `0.086 / 0.074 / 0.040 / 0.000`、违规 `1.000 / 0.985 / 0.113 / 0.673`；
> output 安全 `0.092 / 0.079 / 0.045 / 0.000`、违规 `1.000 / 0.975 / 0.118 / 0.651`；
> 重复 6 次一致）；44 条回归仍是
> 10/20 命中、10/20 灰区 block、11/24 正常 block、2 条误脱敏。JEV 用类别清单问，
> 质量更好，作为横向对比。下文保留研究过程、初稿对比和验收设计；实现状态
> 以本节和实际代码为准，早期“Laya 先离线”的建议不再适用。

## 1. 结论

1. **架构上可以直接切换，不需要改 Policy 契约。** `builtin-pii` 已经由“本地精确检查 +
   语义模型检查”两步组成，语义步骤只认 `tali.guard.pii.semantic.v1` 契约。需要改的是
   Runner 的 evaluator、Controller 的 profile/绑定清单，以及证据与验证链路。
2. **JEV 是当前质量最好的候选（在当前 44 条样本上）。** 使用“类别清单型”问题，输入方向
   `0.1 / 0.8`：20 条 PII 中 19 条明确命中并整块脱敏、1 条落入灰区（保存为 block）、
   0 条漏过；24 条正常文本中 22 条 allow、2 条灰区 block（虚构人物、机构邮箱）、
   0 条误脱敏。输出方向 `0.1 / 0.8`：18 条命中、1 条灰区、0 漏过；24 条正常文本
   22 allow / 2 block（其中一条为一次读超时，需重测）。这些数字仍需独立 holdout
   验证，不能直接当作生产准确率。
3. **Laya 当前 checkpoint 的 PII 质量不足，但可以通过控制面烟雾测试。** 在 10 组以上
   问题设计、2 种 state 形态、44 条冻结样本上，最好的 Laya 变体在 `0.1 / 0.9` 下
   只有 10/20 条 PII 明确命中；换成 `name + actual_identifier + address + dob`
   四问后可以通过双例 Validate，但 44 条回归仍是 10/20 命中、10/20 灰区 block、
   11/24 正常文本被 block、2 条误脱敏。由于 PII 语义的 `unknown` 在 Runtime 中
   会被当成 **block**（见 §3.4），这不是“漏脱敏”，而是把大量正常请求直接拦掉。
   Validate 通过只证明协议和两端方向，不证明质量。
4. **推荐落地（已实施）：** Laya 作为主模型直接绑定 `pii_semantic.input/output`，
   使用上述四问与 `0.1 / 0.9`；JEV 使用类别清单问与 `0.1 / 0.8` 做横向对比。
   两者都必须保留 DeepSeek 绑定作为回退，跑独立 holdout、全量 Guard 回归和灰度；
   如果目标是“只用 Laya 一个模型”且要求准确率，真正的解法仍是模型侧增加
   PII decision type 或微调，而不是继续调 prompt。

## 2. 背景与目标

现状（`docs/model-configuration.md` §Generic semantic PII）：

- `builtin-pii` 1.0.0 的 `model/pii` Rule 使用 `model/classifier` detector，
  `profile: pii-classification`；编译后的计划有两个步骤：
  `pii:exact`（本地正则，`tali.guard.pii.exact.v1`）和 `pii:semantic`
  （`tali.guard.pii.semantic.v1`，`always` 执行，`on_unsafe: transform`）。
- 语义步骤在本地精确脱敏之后执行，看到的是 `previous_output`，即已经替换为
  `[PII_REDACTED]` 的文本。
- 当前实现由 `SafetyModelEvaluator` + `OpenAICompatiblePiiAdapter` 完成：
  一次 chat completion 返回 `{"verdict":"pii|safe|unknown"}`，命中时把**整个目标块**
  替换为 `[PII_REDACTED]`，不声称返回字符级 span。
- 绑定是双向的：`pii_semantic.input` / `pii_semantic.output`，各自独立选模型。

目标：

- 让语义 PII 使用 Decision Model（Laya / JEV 的 Noul 概率协议），而不是生成式
  chat judge；
- 保留“命中即整块脱敏、灰区保守处理、失败不伪装成 safe”的现有产品语义；
- 不改变 `builtin-pii` 的契约与 Guardrail 计划结构，避免已发布 Guard 失效；
- 对 Laya / JEV 分别给出可复现的验收门，而不是用连通性或双例探针代替质量证据。

## 3. 当前实现与关键约束

### 3.1 调用链

```
Controller 绑定 (pii_semantic.input/output)
  → Runner dynamic_runtime_action_providers()
  → EvaluationActionProvider 路由 (capability="pii", contract=pii.semantic, rail)
  → SafetyModelEvaluator → OpenAICompatiblePiiAdapter → chat/completions
  → matched + transform: content="[PII_REDACTED]"
  → Runtime 采集 trace / findings / interventions / evidence
```

Decision Model 已有独立链路：

```
LayaNoulEvaluator / JevNoulEvaluator
  → POST {base_url}/systemone
  → {"state": ..., "questions": {id: {type:"noul", instructions: ...}}}
  → {"model": ..., "answers": {id: {type:"noul", noul: 0.97}}, "usage": ...}
  → matched / not_matched / unknown（阈值 lower/upper）
```

### 3.2 关键文件

| 职责 | 位置 |
| --- | --- |
| 本地精确 PII 与语义升级触发 | `runner/toolkit/nemo/evaluators/pii.py` |
| OpenAI-compatible PII 适配器 | `runner/toolkit/safety/providers.py`（`OpenAICompatiblePiiAdapter`） |
| 语义 PII 的整块替换 | `runner/toolkit/nemo/evaluators/safety_model.py:161` |
| Laya 共享传输/阈值/证据 | `runner/toolkit/nemo/evaluators/laya.py` |
| Laya 内容安全/越狱/话题问题 | `laya_content_safety.py`、`laya_jailbreak.py`、`laya_topic.py` |
| JEV 共享传输/阈值/证据 | `runner/toolkit/nemo/evaluators/jev.py` |
| JEV 内容安全问题 | `jev_content_safety.py` |
| Runner 的 profile 校验与路由注册 | `runner/providers.py:61`、`:150`、`:165` |
| 灰区复核 | `runner/toolkit/nemo/evaluators/classifier_review.py` |
| 决策模型证据集合 | `runner/evaluation_evidence.py:83` |
| 能力验证探针 | `runner/capability_validation.py:74` |
| Controller profile 契约 | `controller/server/model-config/domain.ts:141` |
| Controller 能力可选 profile | `controller/shared/guardrail-catalog.ts:58` |
| Noul 连接探针 | `controller/server/model-config/service.ts:1392` |
| PII 验证结果 UI | `controller/src/components/validation-result-summary.tsx:29` |
| `unknown` 的运行时动作 | `runner/toolkit/nemo/runtime.py:3323` |

### 3.3 现有约束

- `tali.laya.v1` / `tali.typesafe-jev.v1` 都没有宣传 PII：
  Controller 的 `capabilityProfileRefs.pii_semantic` 只有
  `tali.openai-compatible-pii.v1` 和 `tali.qwen3guard.v1`；Runner 也在
  `providers.py` 里显式拒绝 PII 绑定，错误信息写死为
  “input Topic Control, input Jailbreak detection or input/output Content Safety”。
- Laya/JEV 的 evaluator 总是返回 `request.content`（`laya.py:276`、`jev.py:177`），
  没有 transform 能力；直接复用会在命中时因缺少 replacement 无法解析 transform，
  最终按执行失败处理，而不是完成脱敏。
- `ClassifierReviewer.review()` 在复核命中时同样返回原始内容（`classifier_review.py:187`），
  若将来给 PII 开启 `review_unknown`，Runtime 的 transform 解析会因缺少 replacement
  而报 `_PatchConflict`。
- 阈值是**按 Model Runtime** 保存的，不是按 capability。同一个 Laya/JEV 注册同时
  用于内容安全（需要 `0.1/0.9`）和 PII（可能需要 `0.1/0.8`）时，操作点会互相牵制。
- Laya 的 compatible 服务（1Panel `laya-server`）只接受字符串 `instructions`；
  JEV 风格的对象型 `instructions`（含类别清单）会返回 422 `string_type`。
  `criteria` 字段在问题级可以被接受，但没有证据表明它参与判定。
- 当前 Z790 部署只安装了 `english` 和 `multilingual` 两个模型；
  `typed-decisions` 返回 `MODEL_NOT_AVAILABLE`。

### 3.4 最重要的运行时语义：PII 的 `unknown` 会 block

`_runtime_action()`（`runtime.py:3323`）只对
`jailbreak` / `content_safety` / `topic_control` 在
`unknown_reason="uncertain"` 且 `on_unknown="allow"` 时放行；`pii` 不在这个集合里。
因此语义 PII 的 `unknown` 一律返回 `block`。这意味着：

- 对 PII 来说，**灰区不是“放行”，而是“保守拦截”**；
- Laya 在正常文本上的大量灰区，会变成真实误拦；
- JEV 的灰区（如地址 0.46、账号 0.82）会变成 block，而不是“未脱敏放行”；
- 现有 `builtin-pii` 1.0.0 没有 `on_unknown` 参数，所以无法在 Policy 层改为 allow。

这条语义必须在评审中显式确认：如果产品希望灰区“放行（不脱敏）”，需要新增
`on_unknown` 参数并把 `pii` 纳入 `_runtime_action()` 的白名单；如果希望灰区“阻断”，
保持现状即可。**不建议在未确认前把 Laya 接上生产 PII 绑定。**

## 4. 为什么不只是“换个 profile”

即使只加一行 profile 配置，至少还有 8 处行为需要一起改，否则会出现“绑定成功但
行为错误”或“证据缺失”：

1. **transform 语义**：Noul evaluator 必须返回整块 `[PII_REDACTED]` 和带 replacement
   的 finding；否则 Runtime 无法执行 transform。
2. **输出方向**：`pii_semantic.output` 需要独立的 `state.current_output` 和问题；
   现有 Laya/JEV 只对内容安全开放 output。
3. **审核路径**：`ClassifierReviewer` 命中时也要能替换整块，否则复核命中会报错。
4. **阈值**：PII 的推荐上阈值（0.8）低于内容安全（0.9），需要独立注册模型，
   不能复用同一个 runtime 的阈值。
5. **证据**：`evaluation_evidence.py` 的 `layaEvaluations` / `evaluations` 需要
   认识 PII capability 和问题 ID，否则控制台看不到概率。
6. **能力验证**：`capability_validation.py` 的 PII 探针只有一对安全/违规样本，
   会掩盖 70% 召回率的模型；需要独立的 PII 回归，而不是把探针通过当验收。
7. **Controller profile 契约**：`domain.ts` 的 `profileContracts`、
   `guardrail-catalog.ts` 的 `capabilityProfileRefs`、UI 的 profile 列表和
   `controller-api.ts` 的联合类型必须同步，否则浏览器下拉框与 API 会不一致。
8. **UI 呈现**：`validation-result-summary.tsx` 目前用
   `profile === "tali.openai-compatible-pii.v1"` 判断 PII；新 profile 会显示成
   “native verdict”，需要改成基于 binding/capability。

## 5. 实测

### 5.1 方法

- 冻结样本：`tests/fixtures/pii-semantic-decision-eval.json`（工作副本在 `output/laya-pii-research/eval-set.json`），44 条合成文本，
  20 条 PII / 24 条正常；覆盖英文、中文、姓名、邮箱、电话、地址、生日、
  SSN/护照/身份证/IBAN、健康、薪资、账号、注入；正常侧覆盖机构名、占位符、
  标签、技术标识、虚构人物、机构邮箱、公共号码、新闻、日期、构建号等。
- 当前生产对照：DeepSeek `deepseek-chat`，使用仓库内未改动的
  `OpenAICompatiblePiiAdapter`，输入/输出各 44 次。
- JEV：`https://api.typesafe.ai/v1/systemone`，`jev-1.13.0`，类别清单型问题；
  输入/输出各 44 次，重复采样验证确定性。
- Laya：Z790 `1Panel-dev/laya-server` v0.1.2 双模型部署，`model=auto`，
  compatible 请求形态；同一批 44 条。
- 动作换算按真实 Runtime 语义：`matched → transform`、
  全部 ≤ lower → allow、其余 → block；PII 的 block 是灰区保守拦截。
- 期望动作：PII 样例期望 `transform`；正常样例期望 `allow`。

### 5.2 结果（44 条冻结样本，生产 state 形态）

| 方案 | 阈值 | PII 命中/拦截/漏过 | 正常 allow/拦截/误脱敏 | 说明 |
| --- | --- | --- | --- | --- |
| DeepSeek PII（现状） | adapter 内建 | 20 / 0 / 0 | 23 / 0 / 1 | 虚构人物 Elizabeth Bennet 被当成 PII |
| **JEV 类别清单** | 0.1 / 0.9 | 18 / 2 / 0 | 22 / 2 / 0 | 灰区：地址 0.46、账号 0.82 |
| **JEV 类别清单** | 0.1 / 0.8 | 19 / 1 / 0 | 22 / 2 / 0 | 灰区只剩地址；正常灰区为虚构人物、机构邮箱 |
| JEV 四头（name/contact/identifier/private） | 0.1 / 0.9 | 19 / 1 / 0 | 14 / 9 / 1 | 正常侧灰区明显多于类别清单 |
| Laya 四头（contact/identifier/private） | 0.1 / 0.9 | 10 / 10 / 0 | 8 / 14 / 2 | 正常文本 14/24 被灰区拦截；**不能通过探针** |
| Laya 四头（contact/identifier/private） | 0.1 / 0.8 | 13 / 7 / 0 | 8 / 14 / 2 | 同上，误拦仍是主导问题 |
| **Laya 四问（name/actual_identifier/address/dob）** | 0.1 / 0.9 | 10 / 10 / 0 | 11 / 11 / 2 | **控制面探针通过**；正常误拦略少，仍不适合独立承担 PII |
| Laya 六头（含 address/dob） | 0.1 / 0.9 | 11 / 9 / 0 | 8 / 14 / 2 | 增加头没有解决灰区 |
| Laya 内联类别清单 | 0.1 / 0.9 | 4 / 16 / 0 | 1 / 17 / 6 | 接口只收字符串，长问题表现最差 |

JEV 输出方向（`state.current_output`）：

| 方案 | 阈值 | PII 命中/拦截/漏过 | 正常 allow/拦截/误脱敏 |
| --- | --- | --- | --- |
| JEV 类别清单 | 0.1 / 0.8 | 18 / 1 / 0（另有 1 次读超时） | 22 / 2 / 0 |
| JEV 类别清单 | 0.1 / 0.9 | 16 / 3 / 0（另有 1 次读超时） | 22 / 2 / 0 |

Laya 四问在 input / output 的控制面 Validate 都通过（output 安全
`0.0923 / 0.0786 / 0.0447 / 0.0001`、违规 `0.9999 / 0.9745 / 0.1181 / 0.6510`）。
这仍然是 smoke test；44 条回归只测了 input，output 的质量需另建回归。

延迟（同一台工作站、同一时段，p50 / p95 / max）：

| 方案 | 输入 | 输出 |
| --- | --- | --- |
| DeepSeek PII | 945 / 2711 / 4908 ms | 894 / 3763 / 5029 ms |
| JEV 类别清单 | 436 / 941 / 1085 ms | 541 / 1335 / 1377 ms |
| Laya 四头 | 432 / 635 / 693 ms | 未测 |

延迟受网络与服务负载影响，不能当作 SLA；但 JEV 在 p50 上约为 DeepSeek 的 1/2。

### 5.3 解释与局限

- **Laya 的核心问题不是“阈值没调好”。** 对 44 条样本做 lower/upper 二维扫描，
  在“0 漏过”的约束下，Laya 最好的点仍有 16/24 正常文本被拦截或误脱敏；
  JEV 在同一约束下存在 `0.35 / 0.40` 的完全可分点。Laya 是**分数分布不可分**，
  不是操作点选错。
- **Laya 对通用 PII 问题几乎不响应。** 早前 18 条样本上：
  “Does this text contain personal information?” 只有 5 条正确、12 条灰区；
  “personally identifiable information…” 5 条正确；
  “PII” 字面问题出现“已脱敏文本 0.995 / 正常组织 0.04”的退化行为。
  Laya 能识别“person's name”（中文姓名可到 0.97），但没有 PII 这个决策概念。
- **能通过 Validate 不等于可用。** 把 Laya 的问法换成
  `name + actual_identifier + address + dob` 后，双例探针可以通过（安全样本最高
  0.086，违规样本最高 1.000），但 44 条回归仍是 10/20 命中、10/20 灰区 block、
  11/24 正常 block、2 条误脱敏。这是“为了过探针”选问法的直接代价，必须和
  “质量可用”区分开；如果更看重召回，旧的 contact/identifier/private 四头在
  44 条上是 10/20 命中、10/20 灰区、8/24 正常 allow、14 block、2 误脱敏，
  但过不了探针。
- **提示词与 state 形态高度敏感。** 同一 JEV 问题，`state` 不带
  `context_messages` 时虚构人物为 0.99（误脱敏），带空 `context_messages` 时为
  0.35（灰区 block）；机构邮箱从 0.87 降到 0.13。JEV 对重复采样是确定的，
  但**问题/状态形状的微小变化会显著改变分数**。因此问题文本必须版本化、
  冻结并在证据里记录 revision，不能在上线后随手改。
- **JEV 也会把“虚构人物”和“机构邮箱”判成灰区。** 这是 PII 定义问题
  （虚构角色是否算个人信息？`support@acme.com` 是否算个人联系方式？），
  需要通过问题措辞或产品定义解决，并用独立 holdout 验证；不能靠降阈值。
- **样本量小、来源单一。** 44 条合成样本只能证明“方向可行”，不能证明生产准确率。
  问题设计参考了早期 18 条结果，存在过拟合风险；JEV 的 0.95 召回必须在
  独立 500+ 条、带实体 span 标注、中英混合的 holdout 上复测。
- **Laya 的部署与训练目标不同。** 当前 Z790 是 `laya-rl-agent` 路由，
  只安装 english/multilingual，没有 `typed-decisions`。如果 Laya 有新的
  checkpoint 或 PII decision type，应在同一套 harness 上重测，而不是复用本文结论。

## 6. 方案选择

### 方案 A：JEV 作为 PII 语义后端（质量对照/回退候选）

- `tali.typesafe-jev.v1` 增加 `tali.guard.pii.semantic.v1`，输入/输出都支持。
- 新增 `JevPiiEvaluator`，使用类别清单型问题；命中时整块替换。
- 独立注册一个 JEV PII Model（同一 Provider，`upper_threshold=0.8`，
  并发按实际配额设置），避免和内容安全的 0.9 互相牵制。
- 保留 DeepSeek PII 绑定作为回退；验收通过后解绑。

收益：去掉每个块的生成式 PII 调用，p50 约减半；PII 判定由概率化 Decision Model
完成，证据可解释；当前样本 0 漏过。代价：仍有一次外部 JEV 调用（不是本地推理），
地址/账号等灰区会 block。

### 方案 B：Laya 主用 + JEV 横向对比（已实施）

- PII 直接加到现有 `tali.laya.v1` 和 `tali.typesafe-jev.v1`，不新增 profile；
- Laya 使用 `name + actual_identifier + address + dob` 四问，`0.1 / 0.9`；
  JEV 使用类别清单问，`0.1 / 0.8`（独立注册一个 PII Model 以隔离阈值）；
- 两者都通过控制面双例 Validate；Laya 的 44 条回归质量仍弱，必须灰度、
  保留 DeepSeek 回退，并跑独立 holdout。

收益：满足“Laya 为主力模型”的部署诉求；JEV 提供同协议的质量对照。
代价：Laya 在正常文本上的灰区 block 率较高；PII 的 `unknown` 会 block，
因此误拦是主要风险。

### 方案 C：Laya 高精度门 + JEV/DeepSeek 复核（不推荐当前落地）

- Laya 只在上阈值很高时命中，灰区交给独立 review；
- 但 Laya 的灰区比例太高（14/24 正常文本），复核会被频繁触发，
  延迟与外发数据量反而超过今天的 DeepSeek 单次调用；
- 且复核命中需要新增 transform-on-review 修复，收益不足。

### 推荐

**按方案 B 落地：Laya 主用、JEV 对照，两者都保留 DeepSeek 回退。** 控制面
Validate 通过只是准入门槛；生产切换前必须用独立 holdout 和灰度确认 Laya 的
误拦率与漏过率。如果“单模型 Laya + 可接受准确率”是硬性目标，下一步仍应推动
模型侧增加 PII decision type / 微调，而不是继续在 prompt 上迭代。

## 7. 详细设计

### 7.1 契约与 profile

不新增契约；复用 `tali.guard.pii.semantic.v1`。

| Profile | 契约 | 说明 |
| --- | --- | --- |
| `tali.typesafe-jev.v1` | + `tali.guard.pii.semantic.v1` | 输入/输出 PII；建议独立注册一个 PII Model（`0.1 / 0.8`） |
| `tali.laya.v1` | + `tali.guard.pii.semantic.v1` | 输入/输出 PII；四问设计，`0.1 / 0.9` |

不新增 PII-only profile：现有 profile 已经能按 binding 选择不同的 evaluator，
问题文本由 capability 决定，不会和内容安全互相污染；阈值通过独立注册 Model 隔离。
Laya 与 JEV 是不同 Provider kind / profile，不能混绑到同一个 Model；每个 Guardrail
的每个 rail 只能有一个 PII 绑定，因此运行时不会同时调用两者。要 A/B 或灰度，
需要在 Controller 层切换绑定或使用不同 Guard 版本，而不是在一个绑定里 fallback。

### 7.2 Evaluator

新增：

- `runner/toolkit/nemo/evaluators/jev_pii.py`
- `runner/toolkit/nemo/evaluators/laya_pii.py`

两者都继承各自的 Noul 基类，按现有“Laya 与 JEV 问题独立维护”的约定，
**不互相导入问题文本**。

接口要点：

```python
class JevPiiEvaluator(JevNoulEvaluator):
    id = "typesafe-jev-pii"
    scope_label = "input/output Semantic PII"
    display_name = "Jev Semantic PII"
    operation = "pii_classification"
    question_revision = "jev-pii-input.v1"   # 输出用单独的 revision
    capabilities = frozenset({"pii"})
    contracts = frozenset({CONTRACT_PII_SEMANTIC})
    rails = frozenset({"input", "output"})
    reasons = {...}
```

- 输入 `state`：`{"current_input": content, "context_messages": []}`；
  输出 `state`：`{"current_output": content, "context_messages": []}`。
  **初判的 `model_state()` 只给当前块，不带对话历史**：这与 OpenAI-compatible
  PII 适配器的“只分类目标块”一致，也避免无关 user 上下文抬高 name 分数（实测
  Laya output 的安全样本在带一条 user 上下文时 name 从 0.0923 升到 0.3557，
  直接让 Validate 失败）。`state()` 仍保留真实上下文，供灰区复核使用。
  初判 state 形状必须冻结，并用同一形状做验收与线上证据。
- 问题：类别清单型，P1–P5 覆盖姓名（含中文）、联系方式、地址/生日、证件、
  私密事实；明确排除标签/占位符/软件令牌/机构名。输出方向改为
  `state.current_output`，并明确“上下文只用于消解指代”。
- 决策：沿用 `any_upper_all_lower`；`unknown_reason="uncertain"`。
- **transform**：命中且 `request.proposed_action == "transform"` 时返回
  `"[PII_REDACTED]"` 和 replacement；`block` 计划保持原文，由 Runtime 阻断。
  该行为对 PII 是两个方向都生效。
- Laya 版本只使用**字符串** `instructions`；不得发送对象型 instructions（会 422）。
  最终采用 `name / actual_identifier / address / dob` 四问：它既能在默认
  `0.1 / 0.9` 下通过双例 Validate（安全样本最高 0.086，违规样本最高 1.000），
  又在 44 条回归上保持了 Laya 的最优 PII 召回（10/20 命中，0 漏过）。
  代价是 10/20 灰区 block、11/24 正常文本 block、2 条误脱敏；这是已知质量上限，
  必须在文档和 UI 中说明，不能把 Validate 通过当作准确率。
- **Laya 的 `model_state()` 必须显式覆盖。** 基类在单轮无历史时返回纯文本
  （`laya.py:153`，这是内容安全的优化）；本文的 Laya 实测都在对象 state
  （`{"current_input": ..., "context_messages": []}`）上完成。LayaPiiEvaluator
  固定返回 `{current_input|current_output, context_messages: []}`，不能用基类的
  纯文本回退；JEV PII 也覆盖 `model_state()`，保持“只检查当前块”。

### 7.3 基类的最小改动

`LayaNoulEvaluator` / `JevNoulEvaluator` 增加两个可覆盖钩子，避免复制
`evaluate_primary` 的 60 行：

```python
def result_content(self, request, verdict) -> str:
    return request.content

def result_replacement(self, request, verdict) -> str | None:
    return None
```

在成功路径（`laya.py:276`、`jev.py:177` 附近）改用：

```python
content = self.result_content(request, verdict)
replacement = self.result_replacement(request, verdict)
findings = (...) # replacement=replacement
result = evaluation_result(request, verdict, content, ...)
```

PII evaluator 覆盖这两个钩子即可；内容安全/越狱/话题的行为不变（默认返回原内容）。
`JevNoulEvaluator` 同时新增 `model_state()`（默认返回 `state()`），PII 用它收窄
初判 state；Laya 基类已有同名钩子。评审时注意：这些钩子是新 API，需要单测覆盖
“非 PII 能力不变”。

### 7.4 灰区复核（可选，第二阶段）

如果产品希望减少 JEV 灰区的 block，给 `builtin-pii` 增加新版本（例如 1.1.0），
暴露 `review_unknown` / `on_unknown`，并复用 `classifier_review.<rail>`：

- 复核问题使用 PII 的完整类别与排除项；`yes` → matched、全部 `no` → not_matched、
  仍有 `unknown` → 保持 unknown（当前会 block）。
- **必须同时修复** `ClassifierReviewer.review()`：当
  `capability == "pii" and proposed_action == "transform" and verdict == "matched"`
  时返回 `[PII_REDACTED]` 和 replacement，否则 Runtime 的 transform 解析会失败。
- 复核只对灰区调用，不会把已经明确命中的样本送去外部模型；这比今天
  “每个块都调 DeepSeek” 的外发面更小。
- 不建议在 Laya 上开启：灰区比例太高，会放大复核调用量和延迟。

### 7.5 Runner 路由与校验

`runner/providers.py`：

1. profile 校验块（`:61`）：
   - JEV：`if binding.profile_ref == JEV_PROFILE: allowed["pii_semantic"] = JevPiiEvaluator.contracts`；
     output 限制从“仅 content_safety”改为“content_safety 或 pii_semantic”。
   - Laya：`tali.laya.v1` 允许 `pii_semantic`；output 限制同样改为
     “content_safety 或 pii_semantic”。
2. 路由注册（`:150` / `:165`）：加入
   `("pii", "input", JevPiiEvaluator)`、`("pii", "output", JevPiiEvaluator)`、
   Laya PII 对应两项。注意**绑定 ID 是 `pii_semantic.<rail>`，路由 capability 是
   `pii`**；现有循环用 `bindings.get(f"{capability}.{phase}")`，直接加 `("pii", ...)`
   会取错绑定。应把循环改成显式的 `(binding_id, capability, phase, evaluator)`
   四元组，或单独为 PII 写一段。`EvaluationRoute` 的
   `(capability, contract, rail)` 必须唯一；Controller 每个 rail 只有一个绑定，
   不会冲突，但要用测试锁住。
3. `binding_sources` 已经排除 JEV/Laya profile，因此不会和
   `SafetyModelEvaluator` 的 PII 路由重复；新增 profile 不在排除集合里时要同步更新。
4. 传入 `reviewer=reviewers.get(phase)`，但 `builtin-pii` 1.0.0 没有
   `review_unknown`，因此复核不会触发；`supports_review` 会返回 true，
   编译器的 review 就绪校验只在计划启用该参数时才要求绑定。

### 7.6 证据

`runner/evaluation_evidence.py` 的两个 family 增加 PII：

- JEV：`evaluator_capabilities` 增加 `"typesafe-jev-pii": "pii"`；
  `probability_keys` 增加 `"pii": {"contains_pii"}`。
- Laya：增加 `"laya-pii": "pii"`；概率键为
  `{"name","actual_identifier","address","dob"}`（按最终问题 revision 固定）。
- `decisionModel` 继续由 family 决定；`profile_ref` 保持原值。

这样 `x-guard-evaluation-evidence` 的 `evaluations` / `layaEvaluations` 会出现
`capability: "pii"` 的条目，并带 `questionRevision`、`thresholds`、`probabilities`、
`policyAction`、`enforcedAction`。需要确认下游消费者对新增 capability 值不敏感；
现有字段是增量添加。

### 7.7 Controller / UI

- `controller/shared/guardrail-catalog.ts`：
  - `pii_semantic` 的 `capabilityProfileRefs` 增加 `tali.typesafe-jev.v1` 和
    `tali.laya.v1`（两者都在现有 profile 上开放，不新增 profile）；
  - `capabilityProfilePreference` 把 JEV、Laya 放在现有 PII profile 之后。
- `controller/server/model-config/domain.ts`：
  - `profileContracts["tali.typesafe-jev.v1"]` 和
    `profileContracts["tali.laya.v1"]` 都增加 `tali.guard.pii.semantic.v1`；
  - 不新增 `modelProfiles` / `profileTransports` / `layaProfileRefs` 条目。
- `controller/src/lib/controller-api.ts` 的 `ModelProfile` 联合类型。
- `controller/src/components/providers/model-selection.ts` 的 profile 列表。
- `controller/src/components/validation-result-summary.tsx:29`：
  把 `profile === "tali.openai-compatible-pii.v1"` 改为基于
  `context.binding_id?.startsWith("pii_semantic.")`（或 `capability`）判断，
  否则 JEV/Laya PII 的验证证据会显示成 native verdict。
- `controller/server/model-config/service.ts:1746`、`:1806` 的
  “Jev/Laya uses the System One API” 守卫要加入新 profile 的字符串匹配；
  `probeModel()` 的 Noul 连接探针是否改为 PII 问题：建议保持 greeting 连接探针
  （只证明协议/凭据），PII 质量由独立回归证明；如果要改，必须保留
  “连接成功 ≠ 能力通过”的文案。
- i18n：`tali.typesafe-jev.v1` 与 `tali.laya.v1` 的标签/描述加上 PII；
  质量说明放在文档和验证证据里，UI 不承诺准确率。
- 测试：`controller/server/model-config/domain.test.ts` 的
  `profileContracts` 精确断言、`provider-registration.test.ts` 的 Laya profile
  列表、`models.test.tsx` 的 PII 模型可见性。

### 7.8 能力验证与质量门

`runner/capability_validation.py` 的 `_CASES["pii_semantic"]` 继续作为**冒烟探针**：

- 安全样本 `Our support team can assist you.`；
- 违规样本 `John Smith's Social Security number is 123-45-6789...`。

该探针只验证调用/解析/双向判定，不验证准确率。实测：JEV 类别清单安全样本
`0.03`、违规样本 `0.98`，通过；Laya 四问安全样本 `0.086 / 0.074 / 0.040 / 0.000`、
违规样本 `1.000 / 0.985 / 0.113 / 0.673`，也通过（重复 6 次一致）。因此两者
都能在控制面 Validate 变绿，但这只证明协议和两端方向，不证明灰区、正常误拦或
真实分布上的准确率。Laya 的 44 条回归仍显示 10/20 命中、10/20 灰区、11/24 正常
block，必须用独立 PII 回归和灰度作为质量门。

新增独立回归（建议 `scripts/evaluate_pii_semantic.py`；首版样本可直接使用
`tests/fixtures/pii-semantic-decision-eval.json`，它当前只有
`id/content/expected/category`，实现回归时补齐 `rail_type`、`language` 和
`entities` span，并扩展到独立 holdout）：

- 样本字段：`id`、`content`、`rail_type`、`expected`（pii/safe）、
  `entities`（类型 + 原文 span，用于完整脱敏评分）、`language`、`category`、
  `notes`。
- 运行方式：直接调用 evaluator（不经过 Controller），固定 profile、问题 revision、
  state 形状和阈值；同时保存脱敏请求/响应（密钥遮蔽）。
- 指标：
  - PII 漏过率（expected pii → allow）必须为 0；
  - 正常文本误拦率（expected safe → block）与误脱敏率（expected safe → transform）；
  - PII 完整脱敏率（matched 且输出恰为 `[PII_REDACTED]`）；
  - 分语言、分实体类型的召回；
  - 错误率、p50/p95 延迟、每次调用的 token/费用；
  - 与 DeepSeek 基线在同一批样本上的配对差异。
- 建议门槛（需产品确认）：漏过 0；正常误拦 + 误脱敏 ≤ 2%；PII 完整脱敏 ≥ 95%；
  错误率 ≤ 0.5%；p95 ≤ 2 s；JEV 模型版本锁定为验收时的版本。

### 7.9 流式与窗口

`builtin-pii` 的 `output_delivery` 是 `window_buffered`。语义 PII 命中时替换的是
**当前窗口/目标块**，不是精确 span。需要：

- 用 `tests/data_plane/test_stage_a_pii_stream_boundaries.py` 类用例验证跨窗口实体
  不会被漏掉；
- 明确“整块/整窗替换”对用户体验的影响（可能丢弃同一窗口内的非 PII 内容）；
- 如果无法接受，需要本地 NER/规则提供 span，或把窗口边界与实体边界对齐；
  这不是 Decision Model 能解决的问题。

## 8. 分阶段实施

### Phase 0：冻结与复测（1–2 天）

- 用本文的 `output/laya-pii-research/` harness 在**实际生产 Laya 端点**复测；
  如果生产 checkpoint 与 Z790 不同，先看结果再决定是否继续。
- 确认 PII 的 `unknown` 语义（block / allow / review）和 PII 定义
  （虚构人物、机构邮箱、公开人物、用户自己的薪资）。
- 输出：复测报告 + 决策记录。

### Phase 1：JEV PII（建议 1 周）

- Runner：`jev_pii.py` + 基类钩子 + 路由 + 证据 + 单测。
- Controller：JEV profile + catalog + UI + 测试。
- 注册独立 JEV PII Model（`upper_threshold=0.8`，并发按配额）。
- 绑定 `pii_semantic.input/output`，跑能力验证、PII 回归、696 项全量 Guard 回归。
- 灰度：先 5% 流量或测试 Guard，比较与 DeepSeek 的差异；通过后解绑 DeepSeek。

### Phase 2：Laya PII 灰度与质量门（已接入）

- Runner / Controller 已支持 `tali.laya.v1` 的 `pii_semantic.input/output`。
- 用 `tests/fixtures/pii-semantic-decision-eval.json` 和独立 holdout 复测，
  重点看正常误拦（灰区 block）和地址/生日漏过；先 5% 流量或测试 Guard。
- 保留 DeepSeek PII 绑定作为回退；如果误拦不可接受，先只开输出方向或只开
  测试 Guard，不要一次性全量切换。

### Phase 3：灰区复核与 Policy 1.1.0（可选）

- 修复 `ClassifierReviewer` 的 PII transform。
- `builtin-pii` 新版本暴露 `review_unknown` / `on_unknown`；
  在 JEV 上开启复核，观察灰区比例（本样本约 9%）。
- 评估是否把 Laya 重新纳入（当前不建议）。

### 回滚

- 绑定层回滚：把 `pii_semantic.input/output` 重新指回 DeepSeek PII Model；
  不需要回滚 Runner/Controller 镜像。
- 镜像层回滚：先回滚绑定，再回滚镜像，避免旧 Runner 收到不认识的 profile。
- 保留旧的 Guard 版本与 DeepSeek 绑定，直到 JEV 回归稳定。

## 9. 测试矩阵

Runner：

- `tests/data_plane/test_decision_model_pii.py`（新增）：
  - 解析：合法 Noul、缺问题、布尔、越界、非有限数、缺模型名 → error；
  - 判定：any ≥ upper → matched；全部 ≤ lower → not_matched；其余 unknown；
  - transform：matched + transform → 内容为 `[PII_REDACTED]`、finding replacement；
  - block 计划：matched 不改内容；
  - 输出方向：`state.current_output`、上下文只用于指代；
  - 截断：Laya `usage.truncated` → `LayaInputTruncatedError`；
  - 证据：question revision、thresholds、model、request budget。
- `tests/test_pii_model_escalation.py`：保持现有 OpenAI-compatible 路径；
  新增 JEV/Laya 路径的等价断言。
- `tests/control_plane/test_capability_validation.py`：JEV PII 探针通过；
  Laya 当前设计下探针失败（作为预期行为记录，不作为上线依据）。
- `tests/data_plane/test_evaluation_evidence.py`：PII 行进入
  `evaluations`/`layaEvaluations`，`capability="pii"`。
- 现有 `tests/data_plane/test_noul_content_safety.py`：确认内容安全/越狱/话题
  回归不受基类钩子影响。

Controller：

- `domain.test.ts`：新的 `profileContracts`、profile 列表、provider 限制；
- `provider-registration.test.ts`：Laya / JEV 的 System One 探针与模式；
- `models.test.tsx`：PII 绑定下拉框出现 JEV 和 Laya；
- `validation-evidence-sheet.test.tsx`：PII 证据标签不再依赖单一 profile。

Guard：

- 696 项全量回归：PII 相关 case 不能新增失败；
- PII 专项回归（44 + 独立 holdout）：见 §7.8；
- 流式边界用例。

## 10. 风险与未决问题

1. **PII 定义未冻结。** 虚构人物、机构共享邮箱、公开人物、用户自己的薪资/健康信息
   是否算 PII，直接决定模型对错。需要产品书面定义，再写进问题与验收标签。
2. **JEV 提示词敏感。** 问题/state 形状的小改动会改变分数；必须版本化、冻结、
   在证据里记录 `questionRevision`，并在变更后重跑 holdout。
3. **JEV 的地址/账号灰区。** 地址 0.46、账号 0.82 会 block；如果产品要求脱敏而非
   阻断，需要本地地址规则或复核兜底。不能通过降 upper 到 0.4 解决（会引入误脱敏）。
4. **外部 egress。** JEV 仍是外部服务；语义步骤虽然在本地精确脱敏之后，但未识别的
   姓名、地址等仍会发送到 JEV。如果目标是数据不出域，需要 Laya 本地推理；本方案
   无法在 Laya 质量达标前满足这一点，应如实告知。
5. **阈值共享。** 同一模型同时绑定内容安全与 PII 会互相牵制；必须独立注册或引入
   per-capability 阈值（后者是更大的产品改动）。
6. **Laya API 的模型选择。** compatible 服务拒绝对象型 instructions；
   `typed-decisions` 未安装。若未来部署 typed-decisions，需重新测试其 PII decision type。
7. **能力验证的误导性。** 一对安全/违规样本只覆盖两端，不衡量灰区、正常误拦或真实分布；
   JEV 通过它也不代表准确率，Laya 失败它也不代表“只差一点”。文档与 UI 必须继续标注
   “smoke test, not a guarantee”，并以独立 PII 回归为准。
8. **输出流式窗口。** 整窗替换可能过度脱敏或跨窗漏检；需要边界用例。
9. **模型版本漂移。** JEV `jev-1.13.0`、Laya checkpoint 升级都可能改变分数；
   绑定版本并在升级后重跑验收。

## 11. 复现与证据

证据目录：`output/laya-pii-research/`（只含合成数据与遮蔽后的请求/响应，不含密钥）。

```sh
# Laya / JEV 问题设计对照（18 条）
.venv/bin/python output/laya-pii-research/probe_laya_pii.py \
  --base-url "$LAYA_BASE_URL" --key-file .local-secrets/laya-server-z790-api-key \
  --output output/laya-pii-research/probe-results.json

# 44 条冻结样本对照（Laya 四头 / JEV 四头 / JEV 类别）
set -a; . ./.env; set +a
.venv/bin/python output/laya-pii-research/evaluate_pii_models.py \
  --output output/laya-pii-research/model-comparison-results.json

# 生产 state 形态复测
.venv/bin/python output/laya-pii-research/probe_state_shape.py

# 现场 DeepSeek 基线
.venv/bin/python output/laya-pii-research/probe_deepseek_pii.py \
  --output output/laya-pii-research/deepseek-results.json

# 真实 Runner 控制面对 Laya / JEV PII 的 validate_capability
set -a; . ./.env; set +a
.venv/bin/python output/laya-pii-research/live_control_plane_validate.py
```

`probe_laya_pii_categories.py`、`probe_laya_pii_final.py`、
`probe_jev_pii.py`、`probe_jev_pii_output.py`、`probe_jev_output_compare.py`、
`probe_jev_refined.py`、`probe_jev_repeat.py` 保存了问题措辞、state 形态和
重复性实验的原始结果。`README.md` 汇总了每个文件的用途与关键数字。

这些脚本只读合成样本，不注册模型、不绑定、不发布 Guard；密钥来自本地文件/环境变量，
输出中已遮蔽。它们不是生产回归的一部分，复测时请使用独立的 Provider 凭据与配额。

## 附录：分类器问题归 Policy 所有（2026-11-10 变更）

**问题**：JEV / Laya 适配器各自持有 P1–P5 问题文本，Policy 只声明"调用语义 PII 检测"。
语义边界（什么算 PII、什么算越狱）是产品策略，却由 Runner 的发布节奏决定；换模型或改措辞必须改代码，
无法按 Guardrail 灰度或回滚。

**改法**：把问题文本上移为 Policy 参数，Runner 只负责"选、渲染、投影"。

| 位置 | 角色 |
| --- | --- |
| `policies/library/<policy>/policy.yaml` | 参数 `questions` 的 default 是唯一权威文本（问题、类别、正反判据） |
| `policies/rules/model/**/rule.yaml` | `detector.parameters.questions: '{{questions}}'`，Rule 不再含文本 |
| `runner/toolkit/nemo/evaluators/policy_prompt.py` | 解析 YAML、校验、按 provider/Rail/边界选择、渲染占位符、投影到 provider 协议 |
| 各适配器（`jev_*` / `laya_*`） | 只回答"何时问"与"怎么发"，不含任何 prompt 文本 |

覆盖范围：

| Policy | 适配器 |
| --- | --- |
| `pii-semantic` | `jev_pii.py`（1 个合并问题 + 类别 + 判据）、`laya_pii.py`（4 个单概念问题） |
| `content-safety-model` | `jev_content_safety.py`（全量定义）、`laya_content_safety.py`（首判短问、复核全量问） |
| `prompt-instruction-attacks` | `jev_jailbreak.py`、`laya_jailbreak.py`（direct / external / memory 三种边界） |
| `business-topics` | `jev_topic.py`、`laya_topic.py`（deny / allow 两问，`{allowed_topics}` / `{restricted_topics}` 代入） |

### `questions` 参数格式

```yaml
- id: contains_pii                # 模型答案键
  rails: [input, output]          # 可选，默认两条
  providers: {jev: both, laya: primary}   # 可选；primary / review / both
  when: direct                    # 可选；适配器按边界选用（direct/external/memory/denied/unlisted…）
  instructions:                   # 字符串，或命名指令字段的映射（JEV 用映射，Laya 首判必须字符串）
    question: "…{field}…"
    personal_data_categories: |
      P1: …
  criteria:                       # 可选；JEV 必填
    "true": "…{subject}…"
    "false": "…"
```

- `{field}` → `state.current_input` / `state.current_output`；`{subject}` → "current input" / "assistant output"；
  其它 `{name}` 用该 Policy 的参数值代入（如 topic 的 `{allowed_topics}`）。
- 适配器只决定**何时**问与**如何投影**；它既不能改词，也不能新增问题。`policy_prompt.py` 对重复 id、
  未知 provider、Laya 首判收到映射指令、缺 `criteria` 等情况一律抛 `PromptDefinitionError`（fail-closed）。

### 运行期边界

定义随**已发布 Guardrail** 进入计划快照，Runner 只按这份快照构造模型请求：

| purpose | 定义来源 | 缺失时 |
| --- | --- | --- |
| `online`（线上流量） | 仅 `request.parameters`（= 已发布 Guardrail 的解析值） | fail-closed，**不回退到本机 catalog** |
| `validation`（能力探针 / 预览） | 未发布计划，回退到已编译 Policy 默认 | 同样报错 |

因此滚动升级期间旧 Runner 不会用自己 catalog 里的定义去评估客户未发布的边界。
每条评估证据额外写入 `definition_source`（`published-guardrail` / `policy-default`）、
`definition_sha256`（渲染后问题的指纹）与 `question_revision = <capability>:<provider>:<sha12>`，
可直接与已发布版本对账。

### 默认值取舍

`review_unknown` 默认 `true` 仅用于 `pii-semantic`：它的灰区正是主要失效模式。
`content-safety-model` / `prompt-instruction-attacks` / `business-topics` 保持 `false`，
因为开启复核会要求每个引用它们的计划都具备已校验的 `classifier_review` 绑定（延迟 + 成本），
应由具体部署逐个打开。

### 版本策略

Policy / Rule 版本号沿用现有值：`questions` 是 Policy 参数，其内容变化由 `definition_sha256`
进入每条证据可追溯。发布新语义边界时按 normal release 流程做 minor 版本升级。
