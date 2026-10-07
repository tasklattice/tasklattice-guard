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
2. Guardrail 导入：追加版本、版本上限与孤儿清理。
3. 签名契约改造：同一份内容在不同环境的 checksum 一致。

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
7. **紧急生效**：无人可审批时，管理员可对待审批变更单执行紧急生效，必须填写理由和
   负责经理的联系方式，并在审计和变更记录中标记为紧急。
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
| `emergency_reason`、`emergency_contact` | 紧急生效理由与经理联系方式 |
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
| `POST` | `.../:changeId/emergency-apply` | 紧急生效，`reason` 与 `managerContact` 必填 |
| `POST` | `.../:changeId/revert` | 预批准回退到基线 revision，`reason` 必填 |

原有立即生效的 `POST /routers/:id/publish` 与 `POST /routers/:id/rollback` 已移除。
恢复历史 revision 的方式是把它复制成草稿，再走变更单。

### 本部分不包含

- Endpoint 与 Router 的绑定变更仍由管理员直接生效，后续纳入变更单。
- 独立的审批权限与 RBAC。
- `guardctl` 命令行入口（API 已可直接用于脚本化实施）。

## 第二部分：Guardrail 导入（待实现）

- **同一个 Guardrail 按 ID 判断**：首次导入在生产创建并保留 UAT 的 ID；之后的导入
  只追加不可变版本。同名不同 ID 视为冲突，不按名称合并。同一版本重复导入且
  checksum 相同时不做任何事，不同则拒绝。导入的 Guardrail 在生产只读。
- **版本上限**：每个 Guardrail 默认最多保留 10 个版本。导入超出上限时自动清理最旧的
  孤儿版本，清理计划在导入预览中列出，与导入一起确认。
- **孤儿版本**：没有被任何 Routing 引用的版本。引用包括：当前生效快照、服务端草稿、
  待审批变更单、当前生效变更的预批准回退目标。历史 revision 的引用不算；被清理版本
  对应的历史 revision 保留用于审计，但不能再恢复。
- Artifact 与遥测在版本删除后保留，审计证据不丢失。

## 第三部分：签名契约（待实现）

- 把 `generation` 移出 Artifact 签名内容，增加 `signing_key_id`。
- 生产登记 UAT 的签名公钥作为可信来源；导入时先用 UAT 公钥验签，再用生产私钥对
  同一个 checksum 重新签名。生产 Runner 只信任生产的密钥。
- 导出改为发布包：manifest、Artifact、测试集、UAT 验证证据与源配置快照。
