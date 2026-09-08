# OrbStack Topic Mock 实机回归

日期：2026-09-08。用户已授权更新本地 OrbStack、独立部署 Topic Mock。
本轮不新增真实模型 API 调用，不替换 NVIDIA Provider 的地址，不发布用户 Default 草稿。

## 部署结果

- 原 `tali/tali-guard` 已用 `make helm-install HELM_VALUES_ARGS=--reuse-values` 升级到 revision 33。
  保留现有 Helm 配置、数据库和凭据。Controller 与两个 Runner 均 Ready。
- Controller 镜像：`sha256:c3d2207178fffb3fbdfe3cfeeddb9cfa2707bcc836a6390f6b6bce9e40b8d2c2`。
- Runner 镜像：`sha256:ad91e568b73cde590c0750b4f1c4bb5f6e92f188df38c49f2bff2099c2797eef`。
- 主 namespace 新增独立 Deployment/Service `topic-control-mock`，仅 ClusterIP，未暴露公网。
  Endpoint：`http://topic-control-mock.tali.svc.cluster.local:8098/v1`。
- 新增 Provider **Topic Control — MOCK ONLY** 和 Model **Topic Control — synthetic test only**。
  Model ID：`b8414e55-2519-47a6-951b-f35446b76d03`。
  已保存到 `topic_control.input` 并通过真实 Runner 的 NeMo 正常/越界用例验证。
- 主草稿 `e956d1f0-3eb6-4be7-8b68-eb1e850d42b9` 的其他绑定未改动。
  主激活版本仍为 `494e5fe1-132a-4b10-bc46-2295b0a881fa`，**未将整份主草稿激活**。
  该草稿缺少其他检测项的当前验证证据，不能只因 Topic 通过就宣布整份配置通过。

## 完整发布链路：同一 OrbStack 的独立验收 namespace

为保留主草稿且不重新调用真实模型，在 `tali-topic-e2e` namespace 部署同版本
Controller、两个 Runner、独立数据库/Redis及独立 Topic Mock。
没有复制真实 Provider 或密钥。Helm release `tali-topic-e2e` revision 1。
Chart要求至少两个 Runner；最初单副本配置被 schema 拒绝后改为两副本，没有绕过校验。

Mock-only 模型修订 `084b1c3d-c7cf-4e1f-8bf1-950ef10ee33c` 正常验证并激活。
两套 Guardrail 从 Controller API 保存，沿数据库、验证任务、NeMo 编译、签名、分发到
Runner HTTP执行，不是直接向Mock发请求后宣称产品链路通过。

| 允许范围 | Guardrail | 版本 | 产物 |
| --- | --- | --- | --- |
| Product support | `82107d96-3625-437a-a43c-1cdb77e9161e` | `20260908-023306.858Z` | `1d577191-4c7a-4d5f-88b6-df0fa9c13b7f` |
| Cooking and recipes only | `bbf78fa4-0523-4db5-96fa-0ce4b75f0359` | `20260908-023417.028Z` | `f00f54a2-ef72-49b2-a033-fcf011937ccd` |

各自1条继承合同通过，无排除或改写Policy；发布后各4条实际Runtime检查通过：

1. 同一密码重置问题：产品支持范围allow，烹饪范围redirect。
2. 明确越界样本：执行该Policy的redirect动作，核对完整安全替代文本。
3. 未登记Mock样本：HTTP409在执行链路中失败关闭，不伪造成unsafe分类命中。
4. Output：正常放行、模型调用0，不能把Input-only Topic检测冒充Output检测。

此Policy原始动作为redirect，不是reject。继承验证使用内部`intervene`结果，公开Runtime协议
返回`decision=transform, action=redirect`及安全替代文本。脚本最初误把内部枚举用于HTTP断言，
依据已有`runtime/interventions.py`合同修正，并增加完整替代文本断言；未改变Policy或Mock分类。
原A候选中要求reject的Topic样本仍应使用reject配置单独计分，不能混同为同一行为。

产物SHA256分别为：

- `e50d9769a62026a65bf770ae92f33d374e9a77b9966f4beedb39f0a2d0e9a265`
- `af005f71b62a7bb96654764335d6c2755af358d4e31ff8a74da235ecb8f8f0f0`

末次Mock健康统计：主namespace 7请求/7匹配；验收namespace 15请求/13匹配/2明确未匹配，
包括中断后恢复的尝试，不等于独立用例数量。Mock没有HTTP客户端或真实服务回退，
所有注册、检测请求都指向上述集群内地址。此证据不证明真实NVIDIA语义准确率。
相关本地Mock/编译运行测试12通过，Kubernetes manifest客户端校验及脚本语法检查通过。

## 主 Default 的实际差异（首次回归，后续已修复）

以下为首次实测记录。用户随后确认修复并发布，主Default最新修订6已通过483条运行时回放
及26个真实代理场景，见[Default发布回归](default-orbstack-release-20260908.zh-CN.md)。

主 Default 最新草稿为5，当前发布来源草稿为4：
`20260904-085158.755Z`，产物`9c1d47cf-7259-4b6d-bc09-f16704853ce9`。
当前发布配置仍为`window_buffered`，不能当成已验收的最新完整缓存Default。
完整483回放脚本在执行前检测版本不一致并拒绝继续；没有自动发布草稿5。

对当前已发布版本另外做了6条Input/Output基础检查，5通过、1未满足新要求，全部模型调用0：

- 普通咨询两方向allow；邮箱两方向完整脱敏文本正确。
- 人工访问密钥Input为block，符合要求。
- 同一访问密钥Output为transform/redact，**不符合新验收要求的block**。

当时保留该失败及原发布状态；主 Default 需要审核草稿、验证并发布，不能仅升级镜像就认为
已升级不可变的Guardrail产物。没有把旧产物的动作变更隐藏在测试期望中。

## 已发现但未掩盖的限制

空API key可完成模型注册探测，但专用Topic Runtime将空的credential引用视为缺失。
本次Mock采用固定的`synthetic-mock-only`测试占位凭据继续，非真实密钥。
这证明带占位凭据的链路，不证明无认证的专用Topic端点已完整支持。
Mock明确使用合成样本；新增两条现有Topic Policy继承合同的精确响应，不扩展成语义分类器。

## 复现及保留资源

部署定义：`tests/fixtures/kubernetes/topic-control-mock.yaml`、`topic-e2e-values.yaml`。
Mock脚本默认仍仅监听loopback；Pod显式使用`--host 0.0.0.0`。
部署前从脚本及`tests/fixtures/model_responses/topic-control-synthetic.json`创建
`topic-control-mock-code` ConfigMap。配置修改后应滚动重启Mock。

主集群仅注册/保存/逐项验证，不激活其他绑定：

```sh
GUARD_TOPIC_ALLOW_WRITES=1 node scripts/regress_topic_orbstack.mjs
```

验收release使用`values-dev.yaml`叠加`tests/fixtures/kubernetes/topic-e2e-values.yaml`。
Controller/Runtime Service分别以port-forward映射38181/38182后运行：

```sh
GUARD_TOPIC_ALLOW_WRITES=1 GUARD_TOPIC_RUN_ID=orbstack-20260908 \
  node scripts/regress_topic_orbstack.mjs --lifecycle
```

脚本只允许固定OrbStack目标，凭据从对应Kubernetes Secret读入进程内存，不输出凭据。
验收模式拒绝包含其他Provider/模型绑定的环境。复用显式run ID及已有成功版本，
不会为恢复一次HTTP检查而重复激活模型配置或重复发布。
主Mock和独立验收namespace本轮均保留，便于检查；未提交或推送代码。
