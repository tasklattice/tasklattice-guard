# 模型配置生命周期实测（2026-09-08）

## 结论与范围

在 OrbStack 独立命名空间 `tali-model-e2e` 中，完成模型注册、逐项保存和验证、
激活、切换、回滚，以及两个真实 Runner 副本的执行核对。没有修改主环境 `tali` 的 Default、
Provider 或活跃模型绑定，也没有改变已有 `tali-topic-e2e` 的 Mock 配置。

控制面使用 DeepSeek `deepseek-v4-flash`，数据面使用 NVIDIA
`nvidia/llama-3.1-nemotron-safety-guard-8b-v3`。
A/B 是同一个 NVIDIA 模型的两个独立注册项；验证的是配置分发和实际选择，
不是不同模型的效果比较。Topic 和 JailbreakDetect 本轮调用均为 0。

## 验证结果

| 路径 | 结果 |
| --- | --- |
| Provider / Model 注册和实际调用探测 | 通过 |
| Control Plane、Input、Output 逐项验证 | 通过；两个 Rail 均有 NeMo Rail 样本证据 |
| 未验证的新绑定尝试激活 | HTTP 409，旧活跃配置保持不变 |
| API：A → B → 回滚 A | 每阶段两个 Runner × Input/Output，12/12 通过 |
| 页面：选择 B → Save → 逐项 Validate → Activate | 实际操作成功；激活后两副本 Input 2/2 通过 |
| 页面：Rollback → 确认 | 实际操作成功；恢复 A 后两副本 Input 2/2 通过 |
| Guardrail 继承测试、编译、签名发布 | 2/2 通过，未排除样例 |
| 录制网关单测 | 4 passed；覆盖限额、离线回放、非法请求、错误响应与目录调用计数 |
| 脚本语法 | Node syntax check、Python compile 通过 |

16 次实际流量检查均核对 decision、fail_closed=false、model_invocations=1、
model_revision_id、effective_release_id，以及 trace 中实际处理请求的 Model ID。
同阶段两副本执行版本一致；不是仅根据 Controller 的 Active 标签认定成功。

页面验证遵循 Vibe Designing 的真实浏览器证据流程，范围为桌面主路径、保存反馈、
验证反馈和激活/回滚确认交互；未做 UI 重设计，也不代表响应式、完整键盘或无障碍验收。

## 资源与证据

- 测试 Guardrail：`ee8026eb-eb01-49c8-a752-20bb3cc3fdbd`
- 发布版本：`20260908-044507.427Z`
- Policy：完整的 `builtin-content-safety@1.0.0`，Input / Output 均启用。
- Artifact：`2ec5c3b2-ac4b-447f-b298-410d7717482d`
- Artifact SHA-256：`ce8ee666a805e2609bc3ada4fcb899a13ce9ce32c124fb775dd35d64e99e62f1`
- 页面激活 revision 4：`c0dc4139-acad-486f-ac4c-c3abe5da5e91`
- 页面回滚产生 revision 5：`1ce6b094-cb7f-4b1a-9816-b18acac969de`
- API 报告：`/tmp/guard-model-activation-20260908.json`
- 页面后流量报告：`/tmp/guard-model-ui-activate-20260908.json`、
  `/tmp/guard-model-ui-rollback-20260908.json`
- 原始脱敏请求/响应记录：`/tmp/guard-model-lifecycle-recordings-20260908.json`（本机临时文件，非持久仓库工件）。

本轮实际外部请求 **36 次，全部 HTTP 200**，硬上限 40；这些请求包含注册探测、
逐项验证、继承测试和流量执行，不能解释为 36 个独立安全质量样本。
网关在发送前计数，无自动重试，并禁止 Topic 和专用 classify 路径。
已导出记录后将临时网关缩容到 0，移除它的临时真实凭据 Secret；原始 `.env` 未改动。
因此保留的隔离 UI 可供查看配置，但不能继续通过这个已停用网关调用模型。
重新开展真实测试需要新回合及明确的限额，不能重建现有网关来重置预算。

## 发现的边界与下一步

1. 新草稿是独立验证快照：即使只改 Input，新的 revision 也需重新验证已绑定的
   Control Plane / Output。首次测试脚本仅验证 Input，激活被正确拒绝；
   已修正回归脚本，没有放宽产品门禁。
2. 激活后页面自动显示新 Draft 的 Not Checked，同时显示 Active revision。
   这不是已激活配置失效，但草稿与活跃配置的状态区分仍值得后续改善。
3. 本轮流量直接进入 Runner internal evaluate API，未经过外部 Integration /
   Relay-LiteLLM，也未验证真实业务模型生成的多窗口 SSE 全链路。
4. 下一阶段补真实业务生成 → 外部代理 → Runner Input/Output → 客户端 SSE，
   核对完整缓存、窗口放行、中断及客户端实际收到的字节；不能用本轮同步请求替代。
5. JailbreakDetect 已知攻击样例漏检仍未解决，Topic 真实服务仍按用户要求暂缓。
   本轮不构成全产品或模型检测质量最终验收。

## 自动化入口

- `tests/fixtures/kubernetes/model-e2e-values.yaml`：隔离环境及两个 Runner，无公开 LoadBalancer。
- `scripts/deploy_live_model_gateway.py`：仅针对上述命名空间的有界真实请求网关。
- `scripts/regress_model_activation_orbstack.mjs`：需要显式
  `GUARD_MODEL_LIFECYCLE_ALLOW=1`，通过报告保存检查点，避免无条件重发已完成的真实请求。
  本轮完成后不要删除报告直接重跑；新回合需独立记录与资源规划。
