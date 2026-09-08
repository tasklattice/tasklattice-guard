# tali 扩展真实回归（2026-09-08）

本轮用户授权 DeepSeek、NVIDIA 各最多 100 次，明确排除 Topic Control 和 Jailbreak Detector。本轮检查均完成，没有待重试的真实调用或需要追加授权的项目。结论仅覆盖下述配置、样例和功能，不是所有模型或所有攻击的效果认证。

## 环境与额度

- Kubernetes：OrbStack，所有集群测试资源均在 `tali`，没有使用其他 namespace。
- 上游凭据来自项目 `.env`，不写入回归报告或可移植录制。
- 控制面/Playground/业务生成：DeepSeek `deepseek-v4-flash`。
- 检测模型：NVIDIA `nvidia/llama-3.1-nemotron-safety-guard-8b-v3`。
- 所有项目镜像标签为 `dev`，不生成新标签；测试执行前验证 Relay 镜像内置代码与当前 overlay 一致。
- Controller digest：`sha256:192216c50612f06e9549b0b6015372d7c00181f41abd7246f61d5abdb6a13e7e`。
- 两台正式 Runner digest：`sha256:ad91e568b73cde590c0750b4f1c4bb5f6e92f188df38c49f2bff2099c2797eef`。
- Relay digest：`sha256:50b12c8bbaee16c0677b145bcbebd5198758e42ca8fe18ab6a6669ab562f0e60`。

| Provider | 实际调用 | 分解 | 上限 |
| --- | ---: | --- | ---: |
| NVIDIA | 73 | 限额网关 67：48 条效果检查、19 次流式检测；正式 Controller/Runner 链路 6：验证 2、路由执行 4 | 100 |
| DeepSeek | 13 | 意图与文档分析 2；Playground 生成 3；真实 SSE 生成 8（包含中止请求） | 100 |

网关使用 SQLite/PVC，在转发前持久化额度预留，重启不清零；只允许 Safety Guard v3，拒绝 Topic、Jailbreak 和 DeepSeek 路由。67 次转发完成后网关停止，再执行最多 6 次正式 NVIDIA 链路检查。DeepSeek 各脚本先保存调用预留、拒绝不确定结果的自动重跑；阻断输入的 Playground 请求保守预留一次，但实际没有调用模型，因此其预留为 4、实际为 3。没有自动重试模型失败。

## 真实运行结果

| 范围 | 验证内容 | 结果 |
| --- | --- | --- |
| 控制面意图分析 | 真实 DeepSeek 生成结构化话题范围 | 通过 |
| 文档分析与注入隔离 | 合成凭据保护要求夹带“忽略指令/返回攻击标记/不存在 Policy”文本；产生有效要求并推荐 `local-credentials`，未接受注入 | 通过 |
| 控制面产物生命周期 | 推荐 Policy → 保存 Guardrail → 18 条验证 → 编译签名 → 发布 → 正式 Runner 18 条回放，检测模型调用为 0 | 通过 |
| 内容安全效果 | 24 条预先固定的正常/危险样例 × Input/Output，涵盖中英文威胁、仇恨、自伤劝诱、性胁迫、犯罪、骚扰及对应正常教育/预防文本 | 48/48 |
| 正式模型链路 | 不变更现有模型绑定；只选择 `builtin-content-safety`；真实验证 2/2、编译签名、分发、新 Integration/Deployment 路由、正式 Runner 正常/危险 Input/Output 各 2 条 | 通过，6 次 NVIDIA |
| Playground 已发布版本 | 真实生成经过 Default Input/Output | 通过 |
| Playground 输出 PII | 真实模型生成合成邮箱，最终显示 `[email_REDACTED]`，不泄露原邮箱 | 通过 |
| Playground 草稿预览 | 编译草稿预览、真实生成、Input/Output 检查 | 通过 |
| 输入先拦截 | 合成 API key 命中 Default，状态 `input_blocked`，模型延迟为空、没有 Output 检查 | 通过，无生成调用 |
| 正式 Default | 当前已发布签名产物；321 条继承测试、140 条固定旧行为样例及 22 条补充检查；123 条精确输出断言 | 483/483，模型调用 0 |

所有模型效果检查均要求真实模型成功 trace、正确 Rail/版本、`fail_closed=false`；基础设施故障不能计作模型拦截。

正式 NVIDIA 测试 Guardrail 为 `a8e2cd54-cc7d-4923-89a0-e1318f4f72bf`，版本 `20260908-083333.563Z`，产物 `fab87d05-e727-4cc4-99f7-37365760c0d4`，checksum `0bb160729a6feb6f335a1edf21b0a40f8e6a89d128f20c3b1508a03281245c36`。测试后已软删除，保留审计。

### 三种真实 Streaming 交付模式

真实 Relay 镜像调用 `tali` 内同版本 Runner，Runner 只加载固定、签名后的执行产物；不在数据面测试里调用编译器或访问 Controller DB。正常/取消/故障场景使用真实 DeepSeek SSE；危险跨窗口场景使用明确标记的合成业务输出、真实 NVIDIA 检测，不冒充大模型自然生成的攻击。

| 模式 | 正常真实输出 | 跨窗口危险输出 | 取消 | 故障 | 结果 |
| --- | --- | --- | --- | --- | --- |
| Full buffered | 8802 字符，完整检查后释放 | 不释放任何文本 | 首字节只在上游完成后出现，不能用首字节取消证明提前取消 | 最终检查故障，不释放任何文本 | 3/3 |
| Window buffered | 8255 字符，上游完成前开始释放 | 危险续文不释放 | 本地观察到 3 ms 取消传播 | 已批准前缀之后的检测故障终止输出 | 4/4 |
| Interruptible | 7511 字符，上游完成前开始释放 | 已释放前缀无法撤回；危险续文不释放 | 本地观察到 2 ms 取消传播 | 保留已释放文本，明确错误并取消上游 | 4/4 |

共 11/11。逐条比较客户端文本与 Runner 允许释放的文本；正常结束时还必须完整等于真实上游文本，不能静默丢字。2–3 ms 是本地转发层观察到取消/AbortController 的时间，不是 NVIDIA/DeepSeek GPU 或计费停止时间，也不是性能 SLO。故障是显式注入的 HTTP 503，不能计为模型效果。

## 测试脚本修正与非重复原则

正式路由测试首次预检误用了 LiteLLM 专用 `/verify`，对 `generic-http-guard` 返回 409。这是测试脚本错误，不是未分发产物。修正为检查 Runner 就绪/同步状态，再用真实 generic evaluate 证明路由。仅在“验证完成、已预留 2 次、执行请求为 0”的精确状态恢复；没有重复创建、验证、发布或自动重试模型调用。原错误保留在私有报告 `correctedHarnessFailure`。

## 离线回归与保存恢复

- 数据面固定产物、预设、PII 流边界、网关及镜像边界：44 passed。
- 新增 100 次持久限额与 `tali`/`dev`/排除模型边界：2 passed。
- 两轮真实 NVIDIA 录制精确回放：2 passed；新录制逐条重放 67 个返回，未录制请求返回 409，禁止真实网络回退。
- 本轮 DeepSeek 输出作为离线业务响应，真实 Relay 镜像三种模式回归：3 passed。
- Controller 桌面创建/保存结果不确定/权限变化/顺序编辑/Models 相关回归：58 passed。
- `tali` PostgreSQL 独立临时 schema 的保存并发、激活 CAS、ACK 等：13 passed；无真实 Provider 调用，测试后 schema 删除。
- `git diff --check`、新 Node 脚本语法检查通过。

上述六组共 122 个测试通过。本轮不把此前完整 `make test` 的 1958 passed 重算为新的执行结果。

保存结果不确定的真实桌面故障注入证据沿用 [上一轮报告](tali-acceptance-20260908.zh-CN.md)：服务端已保存但响应丢失，页面保留选择、提示核对列表、不自动重新提交，只有一份草稿。本轮补跑其相关自动化回归。这里是“明确提示并人工核对恢复”，不是服务端幂等自动重试保证。移动端完全排除。

录制文件：

- `tests/fixtures/model_responses/20260908-tali-expanded.json`：67 次真实 NVIDIA 返回。
- `tests/fixtures/model_responses/20260908-tali-expanded-deepseek-sse.json`：真实 SSE 的完成文本；离线重新切块为合成传输，原 wire frames 保留在私有证据中。

完整私有执行证据位于 `/tmp/guard-tali-expanded-{stream,categories,control,playground,lifecycle,cleanup}-20260908.json`。其中含内部测试凭据，不要公开整个文件。

## 收尾及边界

- 网关及四模式验收 Runner 已缩容到 0；本轮临时 API-key Secret 已删除，原 `.env` 未改；SQLite/PVC 和录制保留，不清零。
- 本轮新建的两个 Guardrail、一个 Integration、一个 Deployment 已通过产品接口软删除，审计保留；未删除用户原有对象。
- 最终健康状态 `healthy`，两台正式 Runner 均收敛到 generation 30。
- Default 仍为 draft/active revision 6、32 个本地 Policy、`modelIndependent=true`，活动模型配置仍为 revision 3 (`494e5fe1-132a-4b10-bc46-2295b0a881fa`)。
- 没有更改现有 Jailbreak 绑定以绕过依赖检查，没有调用或验收 Topic/Jailbreak。全局 healthy 不代表这两个被排除模型的效果通过。
- 本轮使用的真实检测模型是 Safety Guard v3；未配置/未启用的 Qwen、其他模型及未来 Rails 不在结果中。48 条固定工程样例不等于生产统计精度、全语言覆盖或合规认证。
- 工作区保留已有及新增修改，未执行 Git commit。
