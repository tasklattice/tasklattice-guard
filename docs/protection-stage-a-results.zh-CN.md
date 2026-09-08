# A阶段执行记录（2026-09-08）

状态：**主要链路通过，A仍有边界覆盖待补；不是B阶段质量验收**。
依据用户“可以先做A”的授权，复用隔离环境；真实模型新增调用为0。

## 本轮修复

发布回归发现：Runner可能先收到编译请求代次对应的旧产物集合，编译完成后
Controller仍沿用该代次，`lastReconcileGeneration`据此跳过分发；新版本返回404。

`acceptCompiledArtifact`现在在新产物首次变为ready的事务内递增分发代次并写outbox，
签名产物的编译代次、Guardrail发布排序仍保持不变。延迟完成的旧版本仅作为可用版本
分发，不覆盖当前激活版本；相同编译结果重复提交仍走原幂等返回分支。
回归脚本也不再将编译请求代次当作完成分发的证据。

相关服务/控制通道测试24通过，前后端类型检查通过。新证券、互联网、新加坡版本
在编译完成后分别于分发代次80、82、84加载并完成真实HTTP回放，无需重启Runner。
Common/Banking是中断前已编译版本，本轮重连后恢复，不能单独用来证明新代码消除了竞态。

## 实测结果（各轮独立，不合并成一次全量测试）

| 验证 | 结果 | 范围 |
| --- | --- | --- |
| 五套预配置继承用例 |599通过 |实际Controller验证、编译、签名、分发、Runner HTTP执行，模型调用0 |
| A候选样本 |128/128通过 |Default+银行/证券/互联网，Input/Output，冻结完整脱敏输出，无身份漂移 |
| 既有Default回放 |483通过 |321继承+140旧样本+22明确断言，123条完整输出核对，模型调用0 |
| Topic Mock+流式单元测试 |39通过、20按选择条件排除 |含真实TCP Mock及签名NeMo Topic执行、错误/超时/非法响应；非全量Redis覆盖 |
| 烘焙Relay镜像三种流式模式 |3测试/16场景通过 |真实代理+Runner+受控业务端，提前释放、后续阻断、错误、取消和首帧超时 |
| 已部署银行版本最终客户端回归 |22场景通过 |真实Relay→Runner，输入阻断0业务调用、脱敏、输出注入、长响应PII、断流、取消 |

第一次128样本尝试与发布流程重叠，有效发布身份发生变化，该轮无效，未算通过。
随后发布全部完成，在固定身份下重跑128条，无失败/身份漂移。
未通过修改样本期望、排除失败或改库中Policy来取得这些结果。

## 候选与部署身份

Guard HEAD `e399861ab0562000ecfe2aa3f9b1caa471309033` 加当前未提交修改，
包含本轮分发修复和回归脚本；保留其他工具对Models页面的修改。
Relay HEAD `3e6ade3590cbc1561ee15fa378bd996d774af4be` 加现有LiteLLM集成修改。
实际测试镜像：
`sha256:50b12c8bbaee16c0677b145bcbebd5198758e42ca8fe18ab6a6669ab562f0e60`，
三模式测试执行前核对了镜像内集成代码与本地源码哈希一致，未挂载替换源码。

| 配置 | Guardrail ID | Artifact ID |
| --- | --- | --- |
| Common |f4039a02-d228-46e4-beac-bef61be79d0b |cffbe078-d261-4155-adf3-925746d8b5af |
| Banking |922b9d34-65ee-4487-8832-ca504a13cd87 |dac827ee-deb5-46a2-a28d-013f4f4873ef |
| Securities |76401e92-c6f5-4be7-9875-a0e80d0c6f84 |682c92cd-ef22-4392-8e24-58a99e85e193 |
| Internet |cef1732c-e61d-41c3-96b3-8990aa8b8cba |2dca5d8d-e81d-4b86-9b92-88013affadf3 |
| Singapore |d4a85387-9ae7-4739-8260-5b1617cd651e |caa9e340-a627-4509-98f4-448f47102eba |
| 既有Default |guardrail-default |218e466e-526d-4a78-a1d3-ad7343f51532 |

五个预配置产物为编译器v18；既有Default仍为v15，未编辑/重新发布Default。
候选128条的运行ID为 `stage-a-c34c6bad-e775-4136-97cc-918fd42a257f`；
候选语料SHA256为 `c69e1615c6d7ef143b1951d09a64c3af77699d71ce7a20995dc635ab7a2e3d97`。
该轮有效发布ID为 `33c24ba814c2e6b899f07eea91e9886ef1546b75baba59b9db32c209e6577585`。
所有候选只允许本地 `GuardContentFilterAction` 依赖和 `builtin_content_filter` 步骤。
护照精确输出按合同分别冻结为Default保留标签/替换号码、行业focused规则替换标签与号码；
两种处理均去掉敏感原值，不将一种占位符强加给所有版本。

银行代理回归保留 Integration `141597b8-d58b-4995-b92d-f3900fb6e2d5`、
Deployment `06f4dd12-0d0a-4387-90a6-bc1f28088495` 供检查，临时代理容器由脚本清理。
结束时Runner控制面连接恢复、代次86同步、8个活动版本已预热。
Topic Mock运行在8098；离线回放8097仍为`offline-replay`，历史reserved/finished均为23，未增加。
未修改38081/38082用户集群，未全局激活含失败项的模型草稿，未提交或推送。

## A阶段仍需补足的证据

1. ST02要求护照/邮箱/支付值的**所有双分片边界**及UTF-8字节拆分。现有本轮代理检查覆盖
   长响应PII跨缓冲区、单字符与选定分片，并非完整枚举，不能据此标为全部完成。
2. Topic范围变更已有Mock端点对照；还需把改变范围后的编译产物与Runner执行串起来验证，
   而不是仅以端点返回不同值代替整个配置链路。
3. 本轮真实业务代理只跑新银行版本；证券、互联网完成的是真实Runner HTTP候选/继承回放。
   最终若要求三个行业各自客户端1:1代理验收，仍需分别补跑，不合并宣称已覆盖。
4. 既有Default v15成功回放不能替代当前v18候选的同配置完整验收；不得未经范围确认
   覆盖Default。可在独立测试Guardrail复制其已审核绑定进行新编译验证。

真实模型质量属于B，继续保持未执行。上述剩余A工作不需要新增真实API授权。

## 后续补验（同日，覆盖上述部分缺口）

- 证券版本 `20260908-020529.261Z`、互联网版本 `20260908-020538.962Z`
  的实际Relay/Runner代理回归各22场景通过。镜像仍为上述同一sha256，临时容器清理，
  保留证券Integration `0e398f7b-e1c7-4d0c-9e51-01a3edc47d66` /
  Deployment `589dd353-383c-43f0-82c2-3eb807a8664d`，互联网Integration
  `89e87db2-db2a-4288-b5e0-3f188b9b046f` /
  Deployment `613e6f2f-c384-4984-83e3-9d732e1dffc3`。
  三行业现在均有各自已部署版本的公共安全/流式交付代理证据；行业独有风险仍由候选及继承样本验证。
- 新增 `test_stage_a_pii_stream_boundaries.py`：12组通过，26.55秒。
  对Default及三行业的冻结签名v18产物，枚举护照、邮箱、支付固定文本全部合法双分片切点，
  加未分片、空最终分片、逐字符输出及三字节中文的两种内部字节断点。
  UTF-8分片发生在实际HTTP chunked JSON请求上，由Runner真实解析，不在测试端提前解码重组。
  每次最终文本与冻结的精确脱敏期望相同，非最终内容零释放，模型调用0。
  最初测试把空非最终分片当合法输入，按API合同修正测试（422是预期协议拒绝，不是实现缺陷）。
  这补足Runner入口的ST02枚举；并不声称穷举了业务Provider到Relay的所有SSE字节组合。
- 新增控制面 `test_stage_a_topic_scope.py`：2组通过，1.30秒。
  分别编译Product support / Cooking and recipes only，检查生成配置携带对应范围；
  同一密码问题经过实际NeMo IORails及TCP精确Mock后分别allow/block，各1次Mock调用、0外部调用。
  这补足“配置计划→编译→运行时提示→Mock→决策”的证据，但未通过UI/API保存两套Topic草稿再发布。
- 离线录制网关结束时仍为offline-replay，历史reserved/finished均23，未新增真实请求。

据此，上面的第3项已补足；第1项Runner传输边界已补足；第2项编译/执行对照已补足，
持久化配置发布对照尚未执行。第4项已由下面的隔离副本验收补足。
未把这些窄范围通过宣称为完整A/B或生产验收通过。

### Default 当前编译器隔离副本

`regress_default_copy.mjs` 完整复制原 Default 的草稿配置，逐项核对 Policy 绑定、顺序、
规则覆盖和测试覆盖；不修改库中 Policy，不编辑或发布原 Default。
副本通过321条控制面验证后，由当前v18编译器签名发布，再以
`GUARD_REGRESSION_DEFAULT_COPY_ID` 运行同一份 Default 回放脚本。

- 副本：`5975c38f-a134-4920-91d3-1af1781a3f03`，草稿修订1。
- 验证：`validation-09b43829-5743-4e6f-aec6-02a89cbd1d1a`。
- 版本：`20260908-021453.932Z`。
- 产物：`7bfa8171-03a8-4ecd-8450-47a2fae25acd`。
- 产物校验和：`64f8225ad54525c4a895cb0eca28eacf601a77b04005d1e618136b942429acf4`。
- Runner运行时配置校验和：`fbc23346ce5d14fe396035ec850f1ffffd0bfc3305003c237077fc2eb8bf9a3d`。
- 分发代次92；483检查全部通过（321继承、140冻结旧样本、22额外断言），
  其中123条核对完整输出，模型调用0。

创建/验证/发布脚本确认原 Default 的配置和发布产物未变化。
这是新编译器下的真实部署产物回放证据，不额外宣称副本完成了业务代理或真实模型质量验收。

### Topic 完整发布验收的环境前提（后续只读核对）

对隔离 Controller8093 的 `GET /api/v1/model-configuration` 实际响应核对：
`active`、`activating`、`failed` 均为 null；不能用不存在的 `activeRevision` 字段判断状态。
草稿 `d6000a8b-8a06-4bba-b66b-5c435f983d1c` 同时包含控制面、Content Safety、
Jailbreak 和 Topic 绑定，其中 Topic 指向本地 Mock。
这不构成“Topic Mock 已成为已激活运行时配置”的证据。

因此暂不对现有草稿做全局激活，也不删除其他绑定或篡改其验证状态。
完整持久化/发布对照需要独立的 Mock-only 运行时配置与隔离 Controller/Runner，
或在另行授权后完成当前整份模型配置的有效验证和激活。
现有窄范围测试仍仅证明编译及运行时范围传递，不能把这一环境前提记为通过或模型效果缺陷。

后续用户已授权改用OrbStack并部署独立Mock。持久化→验证→发布→执行的两范围对照
已在集群独立验收namespace完成；主集群Topic也已单独保存并验证。
主Default旧发布版本另发现Output凭据处理不满足新门槛。详见
[OrbStack实机回归](topic-orbstack-regression.zh-CN.md)，不能据此将主集群整体标记为已验收。

再后续经用户确认，主Default已更新并发布修订6，483条回放和26个实际代理场景通过，
关闭了上述旧产物Output凭据处理缺口。详见[Default主集群发布结果](default-orbstack-release-20260908.zh-CN.md)。
