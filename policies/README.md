# Policy 开发与回归测试

一条 Policy 是一个目录，一条 Rule 是一个 YAML 文件。`policy.yaml` 是包的入口，明确列出规则、执行顺序、测试和资源。内建策略与自建策略经过同一套加载器、校验器和编译器；开发者选择注册检测器和处理方式，不必编写 Colang。

规则只有一个契约：`stages` 指定检查阶段，`detector.ref/version/parameters` 定义检测，`risk_level` 标记命中的风险等级，`on_match` 声明处理要求。编译产物也不再带 `form` 分类。正则、关键词、校验位、代码块等是检测器能力，不是不同的 Rule 文件格式；新增业务规则通常只需要引用已有检测器并增加测试。`detectors.yaml` 限定每个检测器实际接受的参数，未知参数和不可用版本会在构建阶段报错。平台内部的 `execution` 只用来选择本地、平台能力或可编程 Flow 适配路径，开发者不在 Rule 中填写它。


这套组织方式借鉴 OPA 的策略包与测试共存方式，运行引擎仍是 TaskLattice Guard 的 Controller → Runner → NeMo。这里没有引入 Rego 或 OPA 运行时。

## Policy、Rule、检测器和 Gateway 的边界

Policy 是多条 Rule 的集合，同时保存名称、描述、版本、测试和资源。Rule 是最小业务处理单元：定义检查阶段、检测器及参数、安全分级，以及匹配后要求 Gateway 执行的处理。

- 检测器只返回匹配结果和证据，不接收 Policy ID、风险等级或处理动作。修改处理动作不会改变同一输入是否匹配。
- `risk_level` 必须在每条源 Rule 中声明，可选 `critical`、`high`、`medium`、`low`、`informational`；发布计划固定此值，事件分级从对应 Rule 的快照读取。
- `on_match` 是给 Gateway 的处理要求。Runner 可以计算替换文本，供后续检查和最终 Decision 使用；应用或 Gateway 负责真正停止模型调用、采用替换内容或停止交付。
- 匹配结果和风险等级不等于模型置信度。确定性字词或正则匹配不虚构一个概率值。

当前注册表按技术能力组织：

| 检测器 | 技术职责 |
| --- | --- |
| `text/keyword` | 字词、短语匹配及字面参数展开 |
| `text/regex` | 正则候选提取、上下文距离和可选校验 |
| `text/conditions` | 组合字词、正则、同句及排除条件；业务词表由 Rule 提供 |
| `code/fenced-block` | 代码围栏及语言标签识别，可附加上下文条件 |
| `model/classifier` | 使用兼容的模型分类契约；`profile` 选择 topic、safety、jailbreak 或 PII 分类适配 |
| `model/grounding` | 根据问题、来源材料和回复返回依据核验结果 |
| `service/formal-verification` | 向已配置的推理服务提交版本化约束，读取证明或反例 |

`profile` 固定技术适配契约，具体 Provider/Model 仍由平台绑定；不是任意聊天模型都支持每个契约。Company Policy 与 Topic Control 复用 `topic-classification`，业务含义留在 Policy 和 Rule。原 `text/category` 和竞品检测已迁为 `text/conditions` 的数据配置，不再在 Python 中维护航空业词表。

代码围栏与“请求执行命令”是两条独立业务 Rule。配置式短语入口在 Controller 编译时展开为普通 `text/keyword` Rules：每个条目有独立 ID、处理动作和风险等级，按顺序执行。展开后的每条 Rule 固定继承源 Rule 的等级，Guardrail 参数不能覆盖风险等级；需要不同等级时应在 Policy 中编写独立 Rule。检测器不再执行一组隐藏的处理动作。

平台模型能力的既有执行计划仍保留专用适配路径（例如内建 PII 的本地检查与语义升级），本轮未开放自建包的模型检测器注册。自建目录包当前可复用已注册的本地检测器。

## 从一个完整例子开始

[客服信息保护](examples/customer-information/policy.yaml) 处理两个要求：回复中客户编号要遮盖，内部密钥标签要阻断。

```text
customer-information/
├── policy.yaml
├── rules/
│   ├── customer-id.yaml
│   └── internal-secret.yaml
└── tests/
    ├── acceptance.yaml
    └── regression.yaml
```

`policy.yaml` 组织包的内容。以下是入口的精简示意；可直接运行的完整定义见上面的文件链接。

```yaml
schema_version: 2
kind: Policy
metadata:
  id: customer-information
  name: 客服信息保护
  description: 遮盖客户编号，阻断内部密钥标签。
  source: custom
  version: 1.0.0
  # 完整示例还声明保护分类及输出交付方式。
execution:
  mode: sequential
  input: previous_output
  stop_on: block
rules:
  - rules/customer-id.yaml
  - rules/internal-secret.yaml
tests:
  - tests/acceptance.yaml
  - tests/regression.yaml
```

[第一条 Rule](examples/customer-information/rules/customer-id.yaml) 说明“查什么、在哪里查、发现后怎么办”：

```yaml
id: customer-id
name: 遮盖客户编号
stages: [output]
detector:
  ref: text/regex
  version: 1.0.0
  parameters:
    expression: '\bCUS-\d{6}\b'
risk_level: medium
on_match:
  action: transform
  replacement: '[客户编号已隐藏]'
metadata:
  taxonomy_ids: [TALI-PRIVACY-PII]
```

[第二条 Rule](examples/customer-information/rules/internal-secret.yaml) 使用 `text/keyword` 查找 `INTERNAL_SECRET`，风险级别为高，处理为 `block`。风险与处理独立：高风险也可以仅记录，遮盖也不意味着低风险。

规则按 **manifest 中 `rules` 的顺序**运行，不依赖文件名或文件系统顺序。下一条读取前一条处理后的文本；`block` 结束本 Policy 的检查，`allow` 记录匹配并继续。Guardrail Binding 仍可调整启用的 Rule、顺序、处理和参数，不能覆盖 Policy 的风险级别。

## 格式匹配与候选值校验

检测器按技术机制组织，业务对象由 Policy 和 Rule 定义。身份证、统一社会信用代码、卡号都使用 `text/regex`：正则先找候选文本，`validators` 再检查候选值。未配置 `validators` 就是普通正则匹配；配置多个时必须全部通过才算命中，然后才执行 `on_match`。

| Rule 的业务用途 | 技术配置 |
| --- | --- |
| 身份证号 | 正则格式 + `date` + `weighted_checksum` |
| 统一社会信用代码 | 正则格式和附近标签 + `weighted_checksum` |
| 卡号 | 正则格式和附近标签 + `luhn` |

例如，业务只允许识别带标签、通过校验的卡号：

```yaml
# Rule 的 detector 部分；其余元数据、阶段、风险与处理照常填写。
detector:
  ref: text/regex
  version: 1.0.0
  parameters:
    expression: '(?<![0-9])62(?:[\s-]?[0-9]){14,17}(?![0-9])'
    context_expression: '银行卡号|卡号'
    context_max_gap_words: 4
    validators:
      - type: luhn
```

`date` 检查 `start` 位置开始的八位 `YYYYMMDD` 是否为有效日期，位置从 0 计数。`weighted_checksum` 将候选值转成大写，按 `alphabet` 中的索引给每位赋值，与 `weights` 逐位相乘后求和；以 `check_characters` 的长度取模，选出预期校验字符，与候选值最后一位比较。候选长度必须为权重数量加一。格式、日期位置、字母表、权重和校验字符映射均由 Rule 指定，不在执行器中硬编码国家或证件名。`luhn` 检查数字序列，允许空格或连字符分隔。

Rule 配置示例：[居民身份证号](builtin/china-personal-identifiers/rules/cn-personal-information-resident-identity-card.yaml)、[统一社会信用代码](builtin/china-organization-identifiers/rules/cn-business-identifier-unified-social-credit-code.yaml)。校验通过只说明格式与数学关系成立，不证明证件或账户真实存在。

## 编写与修改的流程

1. 写明 Policy 的用途、适用范围、版本和保护分类。
2. 把要求拆成独立 Rule，每个文件只放一个 Rule，使用稳定的 ID。
3. 选择注册检测器及版本，填写参数。格式检查用 `text/regex`，需要时附加候选值校验；字词检查用 `text/keyword`，语义判断可选择平台注册的模型能力适配器。
4. 分别确定检查阶段、风险级别与命中后处理。
5. 添加 Rule 测试和完整 Policy 场景，先测试，再导入和构建。

字词表、正则样例或大段测试文本可以放在包内 `resources/` 或 `fixtures/`，并列入 manifest 的 `resources`。引用从包根目录解析，例如：

```yaml
# policy.yaml
resources:
  - resources/terms.yaml
  - fixtures/request.txt
```

```yaml
# rules/example.yaml 内的 detector.parameters
keywords:
  $ref: resources/terms.yaml
```

YAML／JSON 资源按结构读取，其他资源按 UTF-8 文本读取。资源不能跨包引用；未声明的文件、重复引用、循环引用、符号链接和路径越界会被拒绝。可选 `documents` 列表保存随包交付的说明。每个文件最多 2 MB，包最多 32 MB、4096 个文件。

## 两层测试，避免“某条规则通过了，但组合行为不对”

| 范围 | 运行内容 | 用途 |
| --- | --- | --- |
| `scope: rule` | 只启用 `covered_rule_ids` 指定的规则，保持 manifest 顺序 | 精确验证一条规则，避免被其他规则提前阻断 |
| `scope: policy`（默认） | 按顺序启用整条 Policy | 验证正常输入、边界、规则之间的影响 |

每条 Rule 的每个声明阶段，必须有 `required: true` 的 `kind: rule_acceptance` 用例覆盖，内建策略也遵守同一门槛。测试运行时还会检查声明的 Rule 确实被命中，不能靠其他 Rule 的阻断冒充通过。

示例有四个用例：客户编号遮盖、密钥阻断、正常订单回复放行，以及同时包含编号和密钥时先遮盖再阻断。组合用例如下：

```yaml
- id: combined-reply
  name: 先遮盖编号，再阻断密钥
  scope: policy
  phase: output
  content: CUS-123456 INTERNAL_SECRET
  expected_decision: block
  covered_rule_ids: [customer-id, internal-secret]
  expected_matched_rules: [customer-id, internal-secret]
```

`expected_decision` 检查最终处理；`expected_text` 检查精确替换文本；`expected_matched_rules` 检查有序的实际 Rule ID。这些扩展断言由源包回归命令执行，控制台现有 Test Case 流程仍使用自己的检查契约。

回归调用真实 Controller 计划构建、Runner 编译和 NeMo 执行。报告记录包哈希、检测器版本与定义哈希、编译器版本、运行配置、每个用例结果和耗时。执行异常及 fail-closed 都算失败。

## 命令

先运行 `npm run sync` 安装依赖。在仓库根目录执行：

```bash
# 校验目录结构、检测器和测试覆盖
npm run policies:validate -- policies/examples/customer-information

# 回归单条 Policy（直接读取源文件，不必先 build）
npm run policies:test -- policies/examples/customer-information --output /tmp/customer-information-tests.json

# 回归全部当前内建和自建 Policy，报告写入 output/policy-regression.json
npm run policies:regression

# 导入非平台策略，或导入其他环境导出的 ZIP
npm run policies:import -- policies/examples/customer-information
npm run policies:export -- policies/custom/customer-information --output /tmp/customer-information.zip
# 在目标仓库：npm run policies:import -- /tmp/customer-information.zip

# 更新并校验生成的运行目录与 Schema
npm run policies:build
npm run policies:check
```

测试参数使用 `policy.yaml` 的 `testing.parameters`，只填写合成值；命令行 `--parameters /path/to/values.json` 可覆盖这些字符串值。优先级是命令行、测试配置、Policy 默认值。必填参数缺失会拒绝运行。

含模型检测器的 Policy 在本地回归中标记为 `not_run`，原因写入报告；不会把未调用模型当作测试通过。加 `--require-all` 可让任何未执行用例导致命令失败。真实模型效果仍需在配置好模型的环境中执行产品测试流程。

CI 的 `test:control-plane` 先检查生成内容，再运行全部源包回归，最后执行原有编译与控制面测试。任一本地用例失败会阻断 CI，报告作为 `policy-regression` 构建产物保存。

## 导入导出的边界

只允许导入导出 `source: custom`。包不能冒用内建 Policy ID、平台运行身份或合规审查结果。导入写入 `policies/custom/<id>/`，生成共享 Catalog；内容改变必须升版本，覆盖已有包还须显式 `--replace`。校验或生成失败会恢复原来源目录和生成文件。

ZIP 保留元数据、Rule、测试、资源与说明，附带 `manifest.json`，校验每个文件和检测器依赖。校验哈希用于发现内容损坏及依赖变化，**不是发布者签名或信任认证**。导出不携带运行环境的凭据、账户权限、发布状态或 Guardrail Binding。测试配置会随源文件导出，因此必须使用合成值。Secret 参数不允许声明默认值。

重新构建并启动 Controller 后，可在 Policy Library 查看和绑定导入策略。导入本身不发布 Guardrail 或改变线上路由，仍需 Guardrail 测试／发布、Router 发布和 Runner 收敛。已发布的本地 Rule 定义保存在计划快照中，不受后续目录版本替换影响。

旧的单文件 Policy YAML 不再支持。控制台 Policy Studio 的可编程 Colang／JSON 流程仍独立存在，本轮未改造为目录编辑器；从本命令导入的声明式策略在控制台只读，通过源文件修改和重新导入。

## 仓库组织与自举

| 路径 | 职责 |
| --- | --- |
| `builtin/<policy-id>/` | 71 条当前内建 Policy，各自拥有 Rule、测试、资源 |
| `custom/<policy-id>/` | 非平台策略，使用与内建策略相同的包契约 |
| `examples/customer-information/` | 完整开发示例，不自动加入运行目录 |
| `catalog.yaml` | 列出平台包与生成产物的归属；自建目录由构建发现 |
| `detectors.yaml` | 平台管理的检测器名称、版本、底层适配器 |
| `schemas/` | 从加载模型生成的 manifest、Rule、Test JSON Schema |

当前内建包包含 **455 条 Rule、873 个用例**：本地回归执行 863 个，另 10 个依赖模型。历史 Topic Control 1.0.0 放在所属 Policy 的 `history/1.0.0/`，由该 Policy 的 manifest 声明，保留产品历史版本查询，不计入当前版本回归。相同 ID／版本的重复来源已去除。

不要直接编辑 `runner/toolkit/policy_library/assets/` 中的生成 Catalog。`runtime_adapter` 只允许内建策略维护现有运行身份，自建 Rule 的身份由 Policy ID 与 Rule ID 生成。当前自建包支持已注册的本地检测器，不开放任意代码上传或新的模型检测器注册。八种处理指令沿用现有协议；每个适配器支持的参数与替换方式都会校验，重新生成、澄清等仍需集成方执行相应处理。

### Rule handling contract

`on_match.action` accepts only `allow`, `block`, or `transform`. Risk level remains independent. An allow records evidence without bypassing another Rule's block. Transform requires explicit replacement content or valid patches; local Rules declare `on_match.replacement`. Partial masking and whole-content replacement share the same action. Missing transformation output fails closed. Gateway/Agent code owns retries, clarification and fallback workflows. Removed action names are rejected, not aliased.
