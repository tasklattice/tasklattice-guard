# Policy 调度优化：第一阶段契约与验收

更新：2026-10-27。

## 1. 结论与范围

方向可行：把检查的输入视图、Transform 顺序、测试证据要求固定下来，再优化独立检查的执行顺序。收益首先是可解释、可回归的组合行为；本地 Block 前置和模型检查并行的延迟收益需要另行测量。

第一阶段现在实现了显式视图、完整证据测试、严格 Rule 证据判定、统一执行契约，并增加了多调度差分测试。**这不等于证明任意 Policy、任意模型和任意调度都语义等价。**

当前验证范围是：当前编译器生成的内置 Policy、完整缓冲的 input/output、固定检测器响应，以及保持 Transform 顺序和 trigger 依赖的合法调度。自定义 Colang、窗口流式、模型随机性、有状态检测器和完整的故障时序空间不在这个保证范围内。

测试失败仍可发布。报告如实记录失败，发布独立检查产物是否能够编译；签名、固定版本和执行环境有效性检查继续有效。

## 2. 原实现的缺口与修复

| 缺口 | 修复 |
| --- | --- |
| 任意其他 Block 或 Transform 命中，就把目标 Rule 验收算通过 | 目标必须在计划中存在、启用、版本和阶段正确，并有自己的实际证据；取代关系只解释失败 |
| 在原文上重跑目标 Rule，混同于它在实际变换视图上执行 | 本地复算仅用于诊断 `shadowed_by`，不进入 verified Rule，也不能使测试通过 |
| Validator 请求 `full`，Runtime 仍因 Block 短路或取消并行成员 | 支持的计划在 full 模式收集所有可达步骤；多 Rule content-filter Action 内部也不因 Block 丢弃后续 Rule，最后统一返回 Block；快速模式继续短路 |
| 同一审阅约定要求 mask + block，作者序通过而 Block 前置失败 | 完整证据模式下两条 Rule 都真实运行，三种合法调度比对实际 findings 和断言 |
| 精确/语义步骤共享参数数组，追加元数据相互污染 | 每个 step 分配独立参数数组，precedence 唯一且不重复 |
| 缺少 evaluation_view 时静默使用线程化文本 | 编译和执行要求明确且唯一的视图；Controller 与 Runner 采用统一契约，不做新旧能力协商 |
| 不变性测试只跑两个顺序，且有 `or True` 无效断言 | 三种不同合法顺序，严格比较决策、输出、证据和测试结论；无恒真断言 |

## 3. 计划、调度与视图

Controller 在调度前为每个 step 写入：

```json
[["precedence", "0"], ["evaluation_view", "original"]]
```

- `precedence` 是作者顺序，调度不能改写它。
- 每个 step 必须声明且只能声明一个 `evaluation_view`，值为 `original` 或 `previous_output`；缺失、重复或未知值直接报错。自定义 Flow 的绑定由编译器明确写为 `previous_output`。
- 只读 Block / Allow 检查看本阶段输入 `original`。
- Transform 和继承 Transform 前置依赖的步骤看 `previous_output`。
- Transform 保持作者顺序，串行累积输出；trigger 的前置条件必须先完成。
- 存在自定义 Colang 时，整个计划保守保序，步骤保留线程化文本语义。
- 窗口输出仍检查实际收到的 pending 窗口，不能用完整输出替代它。

显式视图由 `NeMoActionBridge._evaluation_text()` 在 Action、Evaluator、PII 和并行成员的入口统一兑现。`precedence` 当前不是独立仲裁器；最终决策仍由 Runtime 累积，Block 优先于 Transform，Allow 不覆盖其他步骤。

只读检查看原文是一项明确的行为约定。若某个检查必须先看到归一化或脱敏文本，需要明确表达依赖；不能靠偶然的作者位置推断。外部模型是否能收到原文，也不能靠 action 优先级充当数据出站约定。

## 4. 两种证据范围

| 请求范围 | 执行行为 | 可承诺内容 |
| --- | --- | --- |
| `interventions`（线上默认） | Block 后允许早退；并行组可取消未完成成员 | 安全决策；不保证完整 findings、调用次数或执行集 |
| `full`（Validator 使用） | 支持的计划不因 Block 早退或取消兄弟检查；仍遵循 trigger | 对可达步骤收集结果，最后决策；未达到或不确定的目标不能当作未命中 |

流程把单步实际的 `blocked` 和控制流的 `stop` 分开。full 模式中 `stop=false` 不代表放行：Runtime 保留 Block，所有可达检查完成后，最终 resolver 返回 Block，不交付被拦截文本。

条件为假的步骤不会被强行执行。错误、超时也不能伪造为 matched。任意自定义流和流式计划仍保留自己的短路行为，即使请求 full，也不会强行收集不可达步骤。这是执行类型的限制，不是按版本保留旧行为。它们的报告可能因此出现 `not_reached` / `preempted_by`，而不是虚构验收成功。

完整证据模式可能增加模型调用、延迟和成本。这是测试证据的成本，不是线上快速路径的性能回归指标。

## 5. Rule 证据判定

先校验源 Policy 身份、固定版本、当前阶段、全部 covered Rule 的启用状态与实际编译步骤/flow。不能先看一条 finding 就绕过结构校验，也不能把 Rule acceptance 的“任意一个命中”当作“全部满足”。目录原生策略的唯一 Rule 通过固定 Policy/version 与真实 native step 关联，与 Runtime 的身份映射一致；缺少显式 `rule_id` 不等于缺少可执行目标。

| 状态 | 含义 | 默认满足 Rule 验收 |
| --- | --- | --- |
| `not_required` | 用例没有 covered Rule | 是；仍需决策、输出和故障断言通过 |
| `observed` | covered Rule 实际产生 matched finding | Rule acceptance 需全部目标命中；scenario 需覆盖集合内的实际命中；Allow 用例命中则失败 |
| `absent` | 覆盖步骤有明确执行结果，目标均未命中 | 仅 Allow 用例通过 |
| `not_matched` | 目标执行了，在声明视图上未命中 | 否 |
| `not_reached` | 没有取得每个目标的明确执行结果 | 否 |
| `preempted_by` | 缺少目标明确结果，同时有已声明的 Block 命中 | 否；只能解释最终 Block，不能证明目标能力 |
| `shadowed_by` | 目标在变换视图未命中，本地冻结定义在原文匹配，且有实际 Transform | 否；这是反事实诊断，不是目标实际命中 |
| `missing` | 版本、阶段、启用状态或可执行目标缺失 | 否，并保留具体原因 |
| `unverifiable` | covered Rule 缺少固定来源身份 | 否 |

`scenario` 的覆盖集合可以表达备选检测类型，例如“任一种凭据”，不能要求私钥样本同时命中 bearer token。它仍然需要固定源 Policy 覆盖范围内的实际命中，不能接受其他 Policy 的拦截代替。`rule_acceptance` 则逐目标验收。两者都先验证全部声明目标存在；`verifiedRuleIds` 只记录本次实际匹配的目标 Rule。没有模型执行证据时，报告不会声称“模型检测器不匹配”。本地复算与生产共用 `content_filter.evaluate_parameters()` 及冻结 step 参数，但复算仍不属于实际执行证据。

证据状态经过 Protobuf、Controller 存储和前端 API 传递：

- `evidence_status`：字段 41。
- `superseded_by`：字段 42，解释关联 Rule，不自动认可取代。
- `verified_rule_ids`：字段 43，仅实际匹配。
- `evidence_detail`：字段 44，具体解释。
- `rule_contract_satisfied`：字段 45，包括有效审阅约定的最终 Rule 断言结果。

`preempting_matches` 和 `evidence_contract` 已删除，Proto 字段编号 38、46 保留为 reserved，防止未来误复用。报告统一携带证据状态和 Rule 断言结果；控制台直接显示后端判定，不从部分命中或取代关系重新推断通过。本地测试中跳过的模型用例明确记录 `not_reached`、`ruleContractSatisfied=false` 和跳过原因，不计入已执行用例。

### 5.1 显式审阅组合期望

如果业务接受其他策略承担保护，应配置已有的 expectation override，写明原因、对应源版本、预期决策和实际需要的 Policy/Rule matches。Transform 约定还必须明确完整输出。

例如两条脱敏规则都处理同一 token，第一条先消耗 token，第二条无法匹配：

1. 默认第二条的验收失败，状态 `shadowed_by`。
2. 审阅后可以明确要求第一条匹配且输出精确等于 `[FIRST] beta`。
3. 这个组合约定可以通过，但报告仍记录第二条未实际命中，verified 列表不会伪造第二条。

override 不会使已删除、禁用、版本不符的目标变得有效。也不能根据实际结果自动生成期望值。

## 6. 统一契约与产物标识

Controller 与 Runner 按同一套契约部署，不支持混合旧版本。编译、测试、加载和 desired-state 分发不再协商显式视图能力标签；Runtime 不根据计划版本选择另一套执行语义。**加载前仍必须检查产物契约**：这是明确拒绝不支持的输入，不是新旧能力协商或语义兜底。完整证据支持范围仅由执行类型决定：完整缓冲且没有任意自定义流。

| 对象 | 当前标识 |
| --- | --- |
| Controller plan | `tasklattice-controller-plan-v16-explicit-views` |
| NeMo 编译器 | `tasklattice-nemo-config-v29-single-contract` |

只有上表两个当前标识组合可以加载；每个 Step 和 Action 还必须声明且仅声明一个合法 `evaluation_view`。即便标识改成当前值，缺失、重复或无效的视图仍会被拒绝。版本不用于切换旧行为。Policy 的固定版本仍用于核对真实目标；checksum、签名、依赖、模型配置同步和执行环境检查继续有效。签名正确只能证明产物完整、来源可信，不能证明升级后的 Runner 支持其执行契约。

v16 之前的 Controller plan，以及不符合当前 NeMo 编译器契约的产物，都需要重新编译。拒绝理由统一带 `artifact_recompile_required`，明确要求使用当前 Controller / Runner 重新编译并发布新版本：

- Controller 环境检查和 desired-state 分发先检查契约。历史 `compatible` 缓存不能授权旧产物预加载；未被 Router 引用的旧产物不阻塞其他发布，被引用的旧产物则使 rollout 明确失败，不能直接丢掉保护配置。
- Runner 在 checksum、签名和 NeMo 版本验证后，进入 Registry 或激活前校验契约。批次中存在不支持的产物时发送 NACK，当前有效 release 和持久化状态保持不变，不会先加载后对每条请求 fail-closed。
- 冷启动读取旧的 last-known-good 缓存时同样拒绝恢复，保留原文件用于排查，记录重编译原因并保持未就绪。这个 gate 不承诺旧产物在新 Runner 上继续服务。
- 已发布版本的复测使用同一加载 gate；拒绝后不执行用例，也不偷偷重编译或改变被测内容。

升级时部署配套 Controller / Runner，再对需要使用的 Guardrail 草稿重新请求发布。即使草稿没有改动，旧契约的已发布版本和测试候选也不会复用，会编译成新版本；通过环境检查后再切换 Router。若要求服务不中断，应在替换部署就绪前保留原服务部署，而不能直接用新 Runner 启动旧缓存。要取得当前证据则重新测试，但测试并非发布前置条件。旧签名 artifact 和旧报告保持不变，不会把原失败结果改成通过。

## 7. 测试和发布独立

- 未测试、排队中、测试失败的 Guardrail 都可以请求发布。
- 已有可用候选产物时直接固定该产物；否则使用离线编译，不需要先通过测试。
- 失败报告及其结构化证据保留，发布不会把 failed 改成 passed。
- 缺失模型配置可以影响环境就绪或执行，但不是用测试通过率阻止创建发布版本。
- 编译失败、产物损坏、签名错误、视图或执行依赖无效仍是执行有效性问题，需要修复；它们与测试不通过是不同的判定。

Default、full-feature-baseline 和普通用户创建的 Guardrail 使用同一流程。PostgreSQL 回归把 `preempted_by + ruleContractSatisfied=false` 报告写入后，验证 full-feature Profile 仍能发布，原报告继续 failed。

## 8. 验收证据

### 8.1 调度不变性

`tests/control_plane/test_schedule_invariance.py` 通过真实 Controller 生成计划，再经真实 NeMo 编译执行。对九种两动作组合加独立观察步骤，在单 Policy / 跨 Policy、input / output 上分别运行三个不同合法顺序：优化顺序、作者顺序、固定随机种子的合法拓扑排列；去重后不足三个则测试失败。

比较 `actualDecision / outputContent / passed / assertionFailures / evidenceStatus / verifiedRuleIds / supersededBy / ruleContractSatisfied` 以及全部 finding 的 Policy/Rule、verdict、action 与 taxonomy 身份，不比较耗时、执行顺序和首个 veto 的描述文本。Transform 顺序、视图和 trigger 依赖保持不变。

额外用例证明：

- 审阅要求 mask + block 时，不同顺序都能看到两个实际 findings。
- 目标从计划中省略，或冻结检测条件变得不匹配，不能被其他 Transform 掩盖。
- 原文复算匹配不等于实际变换视图匹配。
- 正常文本的 Allow 断言必须有明确执行证据。
- 同一个多 Rule Action 内部，full 收集全部命中；快速模式仍在第一个 Block 停止。

### 8.2 其他边界

- 证据单测：缺失 Policy、过期版本、错误阶段、禁用/部分覆盖、未执行、实际未命中、未知/error verdict、失效 override 和完整输出断言；原生 Rule 的 exact/semantic 升级链使用已完成的终端结果，不能把中间 unknown 当作完成。
- 并行回归：C1/C2、input/output、full/快速范围；快速模式仍取消，full 模式保留兄弟结果；模型 HTTP 成功、超时和 503 的确定性响应下，串行与并行的执行结果一致。
- 协议和控制面：结构化字段真实 wire 往返、明确的 true/false Rule 判定、无需视图能力标签即可编译/测试/加载/分发，以及视图缺失或歧义时拒绝执行。
- 发布：实际 PostgreSQL 写入失败证据后发布，测试与版本状态独立。
- 升级加载：冻结提交 `1df5c899` 中真实的旧签名 Artifact（`tests/fixtures/unsupported-artifacts/pre-v16-local-secrets`），验证签名和 checksum 有效且缺少视图，再验证环境检查、apply/admit/verify、NACK、旧缓存重启和已发布版本复测均拒绝。夹具不经过当前编译器重建。另测当前标识下的视图缺失、重复、无效值，以及原有效 release 不被失败更新替换。
- 升级恢复：PostgreSQL 覆盖过期 `compatible` 缓存、被 Router 引用的旧产物保留至分发 gate、未修改草稿重新发布生成新版本、原 Artifact/失败报告不被改写，以及新版本重复发布的幂等性。
- 前端：真实桌面页面展开报告，部分命中显示 Rule 不匹配；满足组合约定的决策失败不会再误报 Rule 不匹配。

本次清理后的本机验证记录（2026-10-27）：

| 验证 | 结果 |
| --- | --- |
| 动作组合矩阵 | 1008 passed |
| Default、历史用例、Profile 组合与本地测试范围 | 33 passed |
| 其余 Python 回归 | 3451 项通过，15 skipped，含修复后定向复测 |
| Controller 全量，含本机临时 PostgreSQL | 2432 项通过，27 skipped，含数据库环境补齐后的复测 |
| CLI 回归 | 23 passed |
| 类型检查、Controller/CLI 构建 | 通过 |
| Protobuf、OpenAPI、artifact/default baseline 生成一致性 | 通过 |
| 真实桌面报告展开与失败诊断 | 通过 |

Python 按组执行，避免重复运行已通过的动作矩阵。其余套件首次完成时为 3316 passed、135 failed、15 skipped；失败全部来自三个模型集成夹具在替换参数时丢弃 `evaluation_view`，修复后这三个文件的 161 项测试全部通过。上述 3451 不重复计算复测中的重叠用例。模型能力探测计划也已显式声明视图，其 24 项回归通过。

Controller 初次运行有三个套件因临时 PostgreSQL 缺少 public schema 未执行；建立所需 schema 后，32 项定向复测通过。失败报告仍可发布的 PostgreSQL 测试通过。

这些测试不是模型准确率评估。生产 p95、取消率、调用费用和随机模型的重复稳定性尚未测量。

### 8.3 复现命令

```sh
.venv/bin/python -m pytest -q \
  tests/control_plane/test_schedule_invariance.py \
  tests/control_plane/test_validation_expectations.py \
  tests/control_plane/test_parallel_checks.py

(cd controller && node node_modules/vitest/vitest.mjs run --environment jsdom \
  server/domain/guardrail-plan.test.ts \
  server/control-channel/control-server.test.ts \
  server/control-channel/protocol-codec.test.ts \
  src/routes/validation.test.tsx)

# 使用本机临时 PostgreSQL URL；套件建立并销毁独立 schema。
(cd controller && GUARD_TEST_POSTGRES_URL="$TEST_DATABASE_URL" \
  node node_modules/vitest/vitest.mjs run \
  server/services/guardrail-publication.postgres.test.ts)

npm run proto:check
.venv/bin/python scripts/generate_test_artifacts.py --check
.venv/bin/python -m scripts.generate_default_baseline --check
```

## 9. 后续阶段与收益边界

后续可以增加声明式 reads/mutates/cost 属性、纯函数仲裁器、稳定的阻断解释、影子差分运行和流式证据契约。应先补相应依赖与证据测试，再扩大允许重排的范围。

本阶段的确定收益是消除缺失证据导致的假通过、避免测试结论随合法调度变化、消除新旧契约分支，并保留失败后发布的顺畅流程。**不承诺生产延迟改善比例，也不宣称所有场景的语义保持已经完成。**
