# Guardrail 跨环境发布与 Routing 变更审批

## 背景

首个客户是银行：UAT 与生产是两套完全隔离的部署，网络不互通。Guardrail 在 UAT
完整测试后导出素材包，经变更单（Change Request）审批进入生产。目标是让整个变更
过程步骤少、可审计、不易出错；UI、命令行和配置文件（GitOps）都可以作为入口。

## 核心原则

```
 UAT 导出包
     │  文件摆渡 + 变更单
     ▼
 生产 Guardrail 版本库   ← 素材层：只是放进去，不影响流量，不需要审批
     │  被路由引用
     ▼
 Routing 变更单          ← 生效层：唯一会改变流量的地方，必须审批
     │  批准即生效
     ▼
 Runner 处理真实流量
```

- **构建一次，原样推广**：生产使用 UAT 编译出的同一个不可变 Artifact，不重新编译。
- **素材层不生效**：导入 Guardrail 只是追加不可变版本；没有被 Routing 引用的版本
  不处理任何请求。
- **生效层必须审批**：Routing 的每一次变更（包括灰度的每一步权重调整）都是对生产
  的改变，都需要审批。

## 实施顺序

1. Routing 变更单与审批（本文第一部分，已实现）。
2. 发布包与签名契约：同一份内容在不同环境的摘要一致，并携带 UAT 来源证据。
3. Guardrail 导入：幂等追加不可变版本，生产不依赖 Policy Library、不重建、不要求重新测试。

2026-10-08 的完整设计见 [Guardrail 自包含发布包与 UAT → 生产晋级设计](./guardrail-self-contained-promotion-design.zh-CN.md)。
该设计更新下文尚未实施的导入与签名部分，不改变 Router 已有审批规则。

## 第一部分：Routing 变更单与审批

### 状态机

```
 编辑中 ──提交──▶ 待审批 ──批准──▶ 已生效
                    │                 │
                    ├──驳回──▶ 已驳回 └──回退──▶ 新的已生效变更（预批准，无需再审）
                    ├──撤回──▶ 已撤回
                    ├──紧急生效──▶ 已生效（标记为紧急）
                    └──基线变化──▶ 已失效
```

### 规则

1. **提交即冻结**：提交时把草稿解析为确切快照（`latest` 在此刻解析为具体 Guardrail
   版本），连同当时绑定的 Endpoint 集合一起冻结。批准生效的就是这份快照。
2. **提交人与审批人不能是同一人**，由服务端强制。审批权限暂时等同 admin，后续由
   RBAC 细化。
3. **每个 Router 同时最多一张待审批变更单**。
4. **基线校验**：提交时记录当前生效 revision。批准时若生效 revision、绑定的
   Endpoint 集合已变化，或快照引用的版本已不可用，变更单变为"已失效"，需重新提交。
5. **批准即生效**：批准在同一事务中创建 Router revision 并推进下发 generation。
6. **预批准回退**：批准一张变更单的同时批准"回退到它的基线 revision"。只要该变更
   仍是当前生效的变更，管理员可直接回退，无需再次审批；回退本身也记录为一张变更单。
7. **紧急生效**：无人可审批时，管理员可对待审批变更单执行紧急生效，只需填写理由，
   系统会记录理由和执行此操作的管理员，并在审计和变更记录中标记为紧急。
8. 变更单号（外部 CR 编号）可选，变更说明必填。

### 数据模型

新增 `traffic_router_change_request`：

| 字段 | 含义 |
| --- | --- |
| `id`、`router_id` | 变更单与所属 Router |
| `kind` | `publish`（发布草稿）或 `revert`（预批准回退） |
| `status` | `pending` / `applied` / `rejected` / `withdrawn` / `superseded` |
| `source_draft_revision` | 提交时的草稿 revision |
| `base_revision` | 提交时生效的 Router revision，首次发布为空 |
| `snapshot`、`endpoint_ids`、`context` | 冻结的快照、Endpoint 集合与名称上下文 |
| `ticket`、`reason` | 外部变更单号、变更说明 |
| `submitted_by/at`、`decided_by/at`、`decision_note` | 提交与审批记录 |
| `emergency_reason` | 紧急生效理由；`emergency_contact` 仅保留历史数据，新变更不再采集 |
| `applied_revision`、`reverts_change_request_id` | 生效后的 revision、回退来源 |

`router_id` 上有 `status = 'pending'` 的部分唯一索引。`traffic_router_revision`
增加 `change_request_id`，每个 revision 都能追溯到产生它的变更单。

### API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/v1/routers/:id/change-requests` | 变更记录 |
| `POST` | `/api/v1/routers/:id/change-requests` | 提交：`expectedDraftRevision`、`reviewedSnapshot`、`reviewedEndpointIds`、`reason`、可选 `ticket` |
| `GET` | `/api/v1/routers/:id/change-requests/:changeId` | 读取单张变更单 |
| `POST` | `.../:changeId/approve` | 批准并生效（审批人 ≠ 提交人） |
| `POST` | `.../:changeId/reject` | 驳回，`note` 必填 |
| `POST` | `.../:changeId/withdraw` | 提交人撤回 |
| `POST` | `.../:changeId/emergency-apply` | 紧急生效，`reason` 必填 |
| `POST` | `.../:changeId/revert` | 预批准回退到基线 revision，`reason` 必填 |

原有立即生效的 `POST /routers/:id/publish` 与 `POST /routers/:id/rollback` 已移除。
恢复历史 revision 的方式是把它复制成草稿，再走变更单。

### 本部分不包含

- Endpoint 与 Router 的绑定变更仍由管理员直接生效，后续纳入变更单。
- 独立的审批权限与 RBAC。
- `guardctl` 命令行入口（API 已可直接用于脚本化实施）。

## 最新版本指针、版本删除与导出交互（已实现）

- **最新版本（Latest）**：原来的“活动版本（Mark active）”改名为“最新版本（Mark as latest）”，数据库列、API 字段和界面统一使用 `latest`。发布新版本会自动成为最新版本；管理员也可以把指针移到任意已就绪版本。
- **Routing 引用**：Target 只有两种策略，**使用最新版本（Use latest）** 和 **固定版本（Pin version）**。使用最新版本时，提交变更单那一刻解析为 Guardrail 的最新版本指针并冻结在快照中；之后移动指针不会改变已提交或已生效的路由。
- **版本删除**：删除前调用 `GET /guardrails/{id}/versions/{version}/deletion-impact` 列出引用。引用包括：最新版本指针、当前生效 Router revision、已修改的 Router 草稿、待审批变更单、当前生效变更的预批准回退目标。历史 revision 不算引用，删除后它们保留用于审计但不可恢复，并记录在审计事件中。另外需要等待：版本仍在编译、可能仍在进行的调用、退出路由不足 5 分钟、在线 Runner 尚未应用移除该版本的 generation。
- **导出交互**：导出不再直接下载最新版本，而是打开面板选择要导出的不可变版本，默认选中最新版本；在版本详情页导出时默认选中当前查看的版本。

## 第二部分：Guardrail 导入（已实现）

- **按来源与 ID 识别**：首次导入保留 UAT 的 Guardrail 逻辑 ID，并绑定可信来源；之后
  只追加不可变版本。同名不同 ID 不自动合并，已有 ID 不允许被其他来源自动接管。
  同版本且内容摘要相同为幂等成功，不同则拒绝覆盖。
- **生产只读**：导入不产生工作 Draft，不需要再次编辑、测试或 Publish；依赖和展示
  信息来自冻结包，既不读取也不写入公共 Policy Library。
- **版本数量**：只显示实际版本数，上限以后确定；本期不自动删除旧版本。
- **入库与生效分离**：导入不改变 Router、Endpoint、流量或当前 Default 基线，也不
  自动预加载到生产 Runner。运行前自动检查本地运行时和模型依赖。
- **删除**：继续复用显式删除及影响检查，Artifact 和遥测保留用于审计。

## 第三部分：签名契约（已实现）

- 本地投递 `generation` 已与不可变内容摘要分离。实现选择原地改造 checksum 契约，
  存量 Artifact 在启动时重新封存，没有保留旧协议。
- 生产使用预先登记的 UAT 公钥验证来源，保留源包及签名，再签发本地接收/分发证明。
  生产 Runner 只信任生产密钥；原始执行内容保持不变。
- 发布包包含一个 Guardrail 的一个或多个版本、完整执行依赖、只读展示快照、环境
  要求和绑定精确内容摘要的 UAT 证据。完整测试数据与开发源快照为可选附件。
- 生产启动、模型能力检查和 Default 基线也必须移除 Library 依赖；具体存储、流程和
  验收要求以 2026-10-08 的自包含发布包设计为准。
