# LiteLLM 离线安全模型接入配置

本文说明如何把 Qwen3Guard、Llama Guard 3 和 Qwen3.5 通过 LiteLLM 或其他
OpenAI Chat Completions 兼容网关接入 TaskLattice Guard。

## 架构结论

NeMo Guardrails 是 Runner 的核心运行时；模型不是 Policy 或 NeMo Action。接入分成
三个独立对象：

```text
Evaluation Contract
        |
        v
Evaluator Binding ----> Evaluator Profile
        |               prompt / response parser / supported contracts
        v
Model Runtime
endpoint / client / model / credential / timeout
```

- Qwen3Guard-Gen-8B 是主要 Guard 模型，Profile 为 `tali.qwen3guard.v1`。
- Llama Guard 3 当前只绑定 `tali.guard.content-safety.v1`，不能作为全局主备。
- Qwen3.5 使用 `tali.taxonomy-judge.v1`，负责 taxonomy normalization、主题语义和
  公司策略等已声明 Contract。
- 本地正则和规则 Evaluator 不配置 Model Runtime。Trigger graph 只有在前置结果为
  `uncertain` 时才激活语义 PII 等后续 Contract，因此不会让每个输入/输出固定调用两次。

## 配置示例

```bash
export MODEL_GUARDRAILS_MODEL_RUNTIMES_JSON='[
  {
    "id":"qwen3guard",
    "client":"openai_chat",
    "base_url":"http://litellm.internal/v1",
    "model":"tasklattice-qwen3guard",
    "api_key_env_var":"LITELLM_API_KEY",
    "timeout_seconds":20,
    "max_tokens":128
  },
  {
    "id":"llama-guard",
    "client":"openai_chat",
    "base_url":"http://litellm.internal/v1",
    "model":"tasklattice-llama-guard-3",
    "api_key_env_var":"LITELLM_API_KEY",
    "timeout_seconds":20,
    "max_tokens":128
  },
  {
    "id":"qwen-judge",
    "client":"openai_chat",
    "base_url":"http://litellm.internal/v1",
    "model":"qwen3-5",
    "api_key_env_var":"LITELLM_API_KEY",
    "timeout_seconds":30,
    "max_tokens":256
  }
]'

export MODEL_GUARDRAILS_EVALUATOR_BINDINGS_JSON='[
  {"id":"qwen-content","contract_ref":"tali.guard.content-safety.v1","profile_ref":"tali.qwen3guard.v1","model_ref":"qwen3guard","priority":10},
  {"id":"llama-content","contract_ref":"tali.guard.content-safety.v1","profile_ref":"tali.llama-guard-3.v1","model_ref":"llama-guard","priority":20},
  {"id":"qwen-jailbreak","contract_ref":"tali.guard.jailbreak.v1","profile_ref":"tali.qwen3guard.v1","model_ref":"qwen3guard","priority":10},
  {"id":"qwen-pii","contract_ref":"tali.guard.pii.semantic.v1","profile_ref":"tali.qwen3guard.v1","model_ref":"qwen3guard","priority":10},
  {"id":"judge-taxonomy","contract_ref":"tali.guard.taxonomy-normalization.v1","profile_ref":"tali.taxonomy-judge.v1","model_ref":"qwen-judge","priority":10},
  {"id":"judge-topic","contract_ref":"tali.guard.topic-control.semantic.v1","profile_ref":"tali.taxonomy-judge.v1","model_ref":"qwen-judge","priority":10},
  {"id":"judge-company","contract_ref":"tali.guard.company-policy.v1","profile_ref":"tali.taxonomy-judge.v1","model_ref":"qwen-judge","priority":10}
]'
```

两个 Binding 只有在 `contract_ref` 相同时才构成主备。例如 Qwen 和 Llama 的内容
安全 Binding 可以按 10、20 的优先级故障转移；Llama 不支持 jailbreak 或语义 PII，
因此不会进入这些路由。启动时 Profile/Contract 不兼容、未知 `model_ref`、重复优先级
或缺少凭证都会被拒绝。

## 协议与模型输出

`openai_chat` 是当前内置 Model Client，要求 Endpoint 接受
`POST /chat/completions`。这不意味着所有 Guard 模型天然拥有相同协议：Evaluator
Profile 仍分别负责 Qwen3Guard、Llama Guard 3 和 Qwen3.5 的提示与响应解析。

模型不必在架构上永久绑定 OpenAI 协议。`ModelClient` 是可替换接口；本地推理、专有
HTTP 或 SDK 接入可以实现新的 Client，而不改变 Evaluation Contract 和 Policy。

## 无 Endpoint 的验证

仓库测试用 `httpx.MockTransport` 和 in-memory `ModelClient` 独立 Mock 物理 Endpoint。
覆盖范围包括：

- Model Runtime 与 Evaluator Binding 的解析和引用校验；
- Qwen 主路由与 Llama 兼容 Contract 内回退；
- Qwen、Llama 与 taxonomy Profile 的原生响应解析；
- 本地 PII 命中短路，以及 `uncertain` 时触发 Qwen；
- 请求 URL、模型名、超时配置、RTT/模型等待时间与调用次数。

运行：

```bash
.venv/bin/pytest -q \
  tests/test_runner_model_config.py \
  tests/test_safety_model_providers.py \
  tests/test_pii_model_escalation.py
```

这些测试不需要真实模型 Endpoint。上线前仍应针对实际 LiteLLM、vLLM 或 SGLang 部署
执行冒烟和负载测试，确认 chat template、停止条件、并发、超时与真实 RTT。
