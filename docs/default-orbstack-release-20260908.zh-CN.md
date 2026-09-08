# 主集群 Default 修复、发布及回归

2026-09-08，用户确认继续修复 Default 后执行。目标为 OrbStack `tali/tali-guard`。
本轮真实模型 API 调用预算仍为0。源Policy、其他Guardrail及模型绑定未调整。

## 修复内容

原草稿5仍为18个旧Policy组合，含混合型PII规则，输出交付为`window_buffered`；
当前发布还停留在来源草稿4。此前Output访问密钥被redact而非reject的问题属于该旧产物。

按此前已验证的Default定义，更新为32个完整的本地Policy绑定，保留全部规则和继承测试，
使用已审核的Default测试期望覆盖。凭据先于PII脱敏处理，Input/Output均reject；
PII按各自Policy合同脱敏。没有修改Policy库定义、按动作强弱重新排序或排除失败测试。
完整值脱敏使用`full_buffered`，不在检查前交付流式文本。

原草稿备份：`/tmp/guard-default-orbstack-backup.9S0yoJ/default-draft-5.json`。
旧签名发布版本仍保留，未删除历史产物。临时目录备份不应视为长期持久备份。

## 实際发布身份

- 草稿/发布来源修订：6。
- 验证ID：`validation-bd1e05a2-5c3f-48ea-a2ce-a75528881fcb`。
- 发布版本：`20260908-024342.826Z`。
- 产物：`ac1c751e-31b2-4d92-8b95-7edf06946919`。
- 产物SHA256：`08414cabe9a5320d67aa4a9144f5127677df00ba8e887b425e1855f42772cdc8`。
- Runtime配置SHA256：`a1f889a3534586002779b9fe18bcd28be77183232371294883f3dbaccac727d6`。
- 编译器：`tasklattice-nemo-config-v18-selected-policy-dependencies`。
- `deployment-default`已启用并指向该版本；两个实际Runner均Ready、连接且同步，末次代次16。
- 本轮为数据库中的Guardrail配置/产物发布，无需再次升级未变化的应用镜像；Helm仍为revision33。

## 实测结果

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| 发布前控制面验证 | 321/321通过 | 当前草稿、无排除、无模型调用、通过后才发布 |
| 已发布Default回放 | 483/483通过 | 321继承+140冻结旧样本+22明确断言；123条完整输出核对；模型调用0 |
| 实际Relay/LiteLLM代理 | 26/26通过 | HTTP及SSE、真实集群Runner执行；受控业务响应，不模拟安全判定 |
| 主健康API | healthy | basicProtection ready；32个Policy、Input/Output各32检查，requiredModelBindings为空 |

新增的凭据代理用例同时覆盖：Input阻断后业务端调用数0、Output阻断、非流式及SSE。
Output测试将访问密钥拆成多个业务响应分片；被阻断时最终客户端内容长度为0。
这次关闭了上一轮已记录的Output凭据行为缺口，不通过改变期望把redact当作reject。

其余代理检查包括注入输出、尾部攻击、完整缓存首内容时间、邮箱跨缓冲区完整脱敏、
上游异常/无正常终止、检测链路503，以及客户端取消后上游停止消费。
最后一项观察到仅发送2个上游分片、2ms关闭延迟、保护文本零释放；
211个客户端字节是协议帧，不是已释放的回答文本。

代理镜像为`sha256:50b12c8bbaee16c0677b145bcbebd5198758e42ca8fe18ab6a6669ab562f0e60`。
保留测试Integration `e1dfb9cb-ce45-4983-a4f5-62aa2530c0c0`、
Deployment `d1b60efa-2b53-4e57-803c-68ee07c51099`，只匹配本轮独立测试Integration。
临时代理容器已由脚本清理。

## 可复现入口和边界

新增`release_default_orbstack.mjs`要求显式授权及原草稿备份，更新前验证草稿未被他人修改。
它使用现有Default构建器，验证321条且模型调用0后才发布，支持复用同一成功验证/产物。
发布后使用`regress_default_runtime.mjs`及`regress_business_proxy.mjs`核对真正的运行产物。
两个回归脚本均在流量执行前拒绝含模型检测步骤的配置，防止越过零真实调用预算。

本轮通过意味着**主集群Default的这组工程验收已通过**，不是所有真实模型的语义质量验收。
Topic Mock链路此前已在独立集群namespace通过；主模型草稿尚未全局激活，其他模型没有被
重新探测或切换。没有在本轮重跑整个源码测试矩阵，也不把不同轮的测试数相加冒充一次全量测试。
代码未提交或推送。

## 后续当前工作区全量自动化门槛

同日再以当前HEAD `e399861` 加未提交修改执行一次 `make test`，退出0：

| 分层 | 通过 | 默认条件跳过 |
| --- | --- | --- |
| 协议/Helm合同 |55 |1 Kubernetes |
| Python控制面 |671 |0 |
| Controller服务及UI |763 |9 PostgreSQL |
| 数据面 |403 |18 Redis |
| E2E |5 |3 Relay镜像 |
| 合计 |1897 |31 |

类型检查、生产构建、协议生成一致性、冻结产物一致性、Helm lint/template及`git diff --check`通过。
随后对全部31条条件测试分别补跑，均通过：

- PostgreSQL：9条，使用`tali-topic-e2e`数据库的随机独立schema，测试后删除该schema。
- Kubernetes保留Secret重装与Redis副本/租约：19条，使用独立验收Redis随机键及临时Helm namespace。
  测试自行清理临时键和namespace，不清空数据库、不改主集群资源。
- 实际烘焙Relay镜像三种流式模式：3条，48.31秒。包含interruptible、window_buffered、full_buffered，
  镜像代码与本地Relay集成代码哈希匹配检查也执行。

补跑是独立执行记录，不把它们写成`make test`单次零跳过。临时38379/38432端口转发已停止；
主Topic Mock和独立验收release仍保留。没有新增真实模型API调用。
警告包含NeMo已弃用字段、测试中的旧配置警告和前端bundle体积提示，不属于本轮失败。
上述结果仍是工程回归，不证明真实模型的误报/漏报率或未授权的真实质量验收通过。
