# tali 真实模型与保存恢复验收（2026-09-08）

## 结论与边界

本轮三个**限定检查**通过：内容安全开发样例 16/16、真实业务模型 Window-buffered Streaming 3/3、桌面端保存成功但响应丢失后的人工核对恢复。

这不是生产准确率承诺，也不是主环境模型配置激活验收。移动端不在产品验收范围；没有调用 Topic 或 JailbreakDetect。

## 环境与预算

- 只使用 OrbStack `tali`，未操作其他 namespace。
- 主 Controller 经 Helm 升级到 `acceptance-20260908-ui-final`，release revision 35。
- 正式与临时验收 Runner 的镜像摘要相同：`sha256:ad91e568b73cde590c0750b4f1c4bb5f6e92f188df38c49f2bff2099c2797eef`。
- Relay 使用已核对内置代码的镜像：`sha256:50b12c8bbaee16c0677b145bcbebd5198758e42ca8fe18ab6a6669ab562f0e60`。
- 凭据来自当前 `.env`，没有写入测试结果。NVIDIA 网关在 SQLite/PVC 中先预留额度再调用，Pod 重建不会清零。
- NVIDIA **32/40**：首次传输/响应失败 1 次、用户明确批准的复测 1 次、Input/Output 探针 4 次、效果检查 16 次、Streaming 检测 10 次。
- DeepSeek **3/3**：一次正常生成、一次客户端取消、一次流中检测服务故障。无自动重试。

## 主配置激活检查中发现的限制

Safety Guard v3 首次注册调用经网关返回 502；DNS/TLS 握手正常，记录不足以进一步区分上游超时与响应解析问题。用户批准的一次显式复测成功，随后两个方向的安全/不安全探针成功。

纯内容安全绑定不能替换主环境的全部绑定：已有 `Model Rail E2E` 发布产物依赖 `jailbreak -> tali.guard.jailbreak.v1 (input)`。Runner 因缺少该绑定拒绝激活，返回 409。这是依赖保护生效，不能通过跳过验证或删掉原保护来获取通过结果。

因此后续在同一个 `tali` 内启动**同镜像的临时验收 Runner**，加载真实 Controller plan builder + Runner compiler 生成并签名的 Input/Output 产物，连接限定额度的真实 NVIDIA Endpoint。数据面只接收编译产物，不访问 Controller 数据库。没有把此路径记作主配置激活成功。

## 实际结果

| 检查 | 证据 | 结果 |
| --- | --- | --- |
| 内容安全 Input | 4 条正常 + 4 条危险中英文样例；每条检查真实模型 trace、版本、`fail_closed=false` | 8/8 |
| 内容安全 Output | 同样的平衡样例，独立 Output 执行证据 | 8/8 |
| 正常真实 Streaming | DeepSeek 返回 9473 字符；5 次 Output 检查；客户端文本严格等于 Runner 允许释放的文本，且最终完整等于真实上游文本 | 通过 |
| 提前释放 | 首个非空白内容比真实上游结束早 15767 ms | 通过；不代表总体 TTFT/SLO |
| 用户中断 | 收到首个内容后取消；上游仍未生成结束，2 ms 后观察到本地转发连接关闭并触发 AbortController | 通过；不等于厂商 GPU/计费立即停止 |
| 流中故障 | 已释放一段后注入检测传输 503；客户端收到明确 502 SSE 错误，未释放未检查内容；真实 DeepSeek 上游被取消 | 通过；这是故障拦截，不是模型识别危险内容 |

效果样例是预先固定的开发集，不是独立盲测或统计充分的生产评测。本轮不重新验收其他 delivery mode，也不证明所有内容安全类别和语言的模型效果。

## 保存结果不确定：桌面真实 UI

1. 创建银行客服预设草稿，17 个 Policy、38 条 Rule。
2. 测试代理先完整收到 Controller 的 201 和草稿 ID，再故意丢弃浏览器响应。
3. UI 展示错误并保留选择，明确提示“先检查列表，草稿可能已创建；重新连接不会自动提交”。
4. 从正式地址的列表打开已有草稿，确认仅一份，且没有自动发布或部署。

草稿 ID：`a0da58dc-e3a1-435a-bb68-b325cdbc528e`，名称 `Regression save outcome uncertain 20260908 tali`。代理记录提交次数为 1。

这里通过的是**提示 + 人工核对恢复**，不是服务端幂等重试保证。测试代理有独立的防重复提交保护，但本轮没有触发它，不能将其归功于产品。

Vibe Designing 仅评估此桌面恢复路径：产品目的（草稿不发布）、信息层级（错误与恢复提示分开）、组件反馈（错误固定可见）、领域语义（承认保存结果未知）、交互恢复（保留选择并能打开已存草稿）、视觉可读性（截图无错误信息截断）六个限定子检查均为 2/2。等权结果 10/10，仅表示上述检查全部有证据，不是整站 UI 评分；通过门槛是六项均通过且无恢复阻断。移动端明确排除。

## 回归与证据

- `tests/data_plane/test_tali_acceptance_artifact.py`：4 个离线 Input/Output 产物执行检查。
- `tests/data_plane/test_tali_acceptance_recordings.py`：完整重放 32 个真实 NVIDIA 返回，包括首次失败；禁止真实网络和未录制请求回退。
- 与限额网关、模型结果判定测试一起运行：**35 passed**；NeMo 配置兼容字段产生 4 条弃用警告，无测试失败。
- NVIDIA 可移植录制：`tests/fixtures/model_responses/20260908-tali-acceptance.json`。
- 正常 DeepSeek SSE 录制：`tests/fixtures/model_responses/20260908-tali-deepseek-sse.json`，后续回归可直接重放，不必再次生成。
- 本机完整私有结果：`/tmp/guard-tali-live-acceptance-20260908.json`、`/tmp/guard-tali-save-uncertainty-20260908.json`。不要公开完整私有报告中的旧配置/内部测试凭据。

## 收尾状态

- 原活动模型 revision `494e5fe1-132a-4b10-bc46-2295b0a881fa` 未改变。
- Default 草稿 revision 6、发布版本 `20260908-024342.826Z`、32 个本地 Policy 均未改变。
- 最终 `/api/v1/system/status` 返回 healthy；Default `modelIndependent=true`；两台正式 Runner 均健康且收敛到 generation 19。
- 临时 NVIDIA 网关和验收 Runner 均缩容到 0；本轮 API-key Secret 已删除。录制 PVC 保留，额度不会清零。
- 本轮注册的未启用测试模型及失败激活记录保留作审计；不应被选入实际流量。保存恢复测试草稿也保留，未发布。
- 没有提交 Git；保留此前工作区修改。
