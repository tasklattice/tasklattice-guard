# 真实业务 SSE 回归：镜像错配（2026-09-08）

## 本轮未通过

隔离 OrbStack `tali-model-e2e` 的真实链路回归使用了旧的
`ghcr.io/tasklattice/tali-litellm:dev` 镜像。该镜像没有当前 protected output-stream 实现，
逐片调用 `litellm_basic_guardrail_api`，未调用 `guardrails/output-stream`。
完整缓存模式的客户端提前收到 758 字符，违反完整缓存合同。
这是回归脚本错误选择旧默认镜像暴露的工件错配，不能据此判断当前源码也有相同缺陷。

- 旧镜像：`sha256:e2676c00235fb99ec54327f4c2d76c78120a7ce3bb7b042f6bbdfda245212cb9`。
- DeepSeek `deepseek-v4-flash`：1 次真实业务 SSE，上游完整回答 2,560 字符，显式 stop。
- NVIDIA Safety Guard v3：网关预算 40 次用完，40 次均 HTTP 200；包含注册、验证、发布测试和逐片检测。
- 随后的请求被本地预算网关 429 拒绝，不是 NVIDIA 服务失败。没有自动重试或扩大预算。
- Topic / JailbreakDetect 真实调用均 0；主环境 `tali` / Default 未修改。
- 安全流式样例：无 output-stream 检查，客户端收到部分内容后报错，失败。
- 攻击样例：预算耗尽，Input 检查失败，业务调用未发出，不能算检测通过。
- 后续模式准备时验证无法完成而停止，三模式真实验收没有完成。

报告：`/tmp/guard-live-stream-proxy-20260908.json`，含隔离 Integration 凭据，权限 0600，勿直接提交。
脱敏调用记录：`/tmp/guard-live-stream-recordings-20260908.json`，权限 0600。
业务回答 fixture：`tests/fixtures/model_responses/20260908-deepseek-business-answer.json`；
它是完整上游回答，不表示当时客户端成功接收完整回答。

## 已修复测试入口

1. 新增 `scripts/verify_relay_stream_image.py`，在读取真实凭据、修改 Controller、发送 API 前，
   禁网络且禁止拉取镜像，逐文件验证镜像内 Guard 代码与当前 Relay overlay 的 SHA-256 一致。
2. 两个业务代理回归脚本要求显式选择镜像，使用已经验证的不可变 image ID 启动；不再默用 dev。
3. 真实 SSE 测试转发层拒绝旧 response 路径，返回 426，不继续逐片消耗模型预算。
4. 首个失败样例立即停止，不继续消费后续样例；保留失败报告。
5. 新旧录制网关资源独立；已有 Deployment 禁止重建以重置限额。

本机已有正确镜像 `tali-litellm:protection-productization-baked-20260907`，
`sha256:50b12c8bbaee16c0677b145bcbebd5198758e42ca8fe18ab6a6669ab562f0e60`，
已通过逐文件一致性校验。没有修改或重标记用户旧 dev 镜像。

## 零外部调用结果

| 检查 | 结果 |
| --- | --- |
| 镜像门禁、隔离资源与录制网关 | 9 passed |
| 正确 baked 镜像 TCP Relay → 预编译 Runner → 可控 Provider，三模式 | 3 passed，54.75s |
| 使用真实 DeepSeek 回答 fixture 的三模式重放 | 3 passed，47.51s |

后两轮覆盖安全放行、阻断、检测故障、客户端取消；完整缓存另测首帧超时。
重放安全场景使用完整真实回答；攻击场景附加合成 marker，检测响应仍为明确的 Mock。
因此这些是工程合同验证，不是 NVIDIA 多窗口检测效果验收。NeMo 的 nim_url 弃用警告仍存在。
Node/Python 语法检查与 git diff --check 通过。

## 清理与剩余任务

记录已导出，临时真实网关已缩容到 0，其凭据 Secret 已删除，测试代理容器已清理；
原始 .env 未修改。保留隔离 Controller 测试资源用于审计，不代表停用网关仍可调用。

下一轮需要正确的 baked 镜像、新的独立预算和记录，不能覆盖本轮失败或重置其预算。
仍需跑完真实安全生成三模式、真实检测跨窗口攻击及最终检测失败后的客户端行为。
Topic 继续暂缓，JailbreakDetect 漏检继续单列，不能宣布全产品验收完成。
