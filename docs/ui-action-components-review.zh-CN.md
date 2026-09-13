# UI 操作组件审查与规范

日期：2026-09-12。以本轮用户确认的蓝色创建、黄色编辑、红色删除为准，替代此前绿色创建约定。

## 审查结论

系统已有共享 Button、DropdownMenu、EntitySheet、ConfirmationSheet，基础形态复用充分。缺口在于操作语义、强调层级和风险等级没有统一约定；继续增加 CreateButton、EditButton、DeleteButton 等薄包装并不能自动解决问题。

### 已确认的问题与本轮修正

| 位置 | 问题 | 修正 |
| --- | --- | --- |
| ui/button.tsx | create 使用绿色，而默认创建入口使用品牌蓝 | create 与 default 共用同一 primary 样式定义，使用主题色变量 |
| Router、Guardrail 创建入口 | 依赖默认 variant，代码无法表达创建意图 | 明确使用 create |
| Router、Guardrail、Policy 详情编辑 | outline/default 混用 | 明确使用 edit，采用深色文字的浅黄色样式 |
| ui/dropdown-menu.tsx | 仅支持普通、删除语义，编辑菜单没有对应表达 | 增加 edit；Route 菜单显式使用，省略号触发器保持中性 |
| Guardrail、Policy 删除入口 | 页面通过 className 拼接删除色，默认状态可能仍为中性 | 使用 destructive，移除对应页面颜色覆盖 |
| confirmation-sheet.tsx | warning 仅改变图标，确认按钮仍为蓝色 | warning 确认采用黄色样式；destructive 保持红色 |

## 操作颜色与强调层级

| 操作 | 组件表达 | 视觉 |
| --- | --- | --- |
| Create、Add、Duplicate 的创建确认 | Button variant=create | 品牌蓝 |
| Edit、Apply changes | Button variant=edit | 浅黄色底、深黄色文字 |
| Delete、Revoke 的执行或确认 | Button variant=destructive | 红色 |
| Review、Publish、运行测试等主要流程动作 | Button 默认 variant | 品牌蓝；蓝色不只代表创建 |
| Cancel、Close、Back、Copy、查看详情 | outline / ghost / link，按场景选择 | 中性或链接样式 |
| 行尾操作入口 | ghost 图标按钮 + DropdownMenu | 中性省略号；菜单内部表达操作语义 |

颜色不是风险等级，也不是确认流程。创建不应因蓝色自动要求确认；编辑草稿与发布线上配置影响不同；删除本地表单行与删除持久化对象也不同。状态徽标中的绿色成功、黄色告警不属于操作按钮，不应批量替换。

## 抽象边界

1. **主题与视觉基础层**：Button / DropdownMenuItem 负责颜色、hover、focus、disabled；保留现有 primary/destructive 主题变量。后续扩展主题时，将 amber 编辑色集中成主题 token，而不是各页面重复颜色。
2. **组合交互层**：EntitySheet 负责侧栏框架；ConfirmationSheet 负责取消/确认、pending 和关闭保护。此层不决定对象能否删除、是否影响线上。
3. **业务动作层**：GuardrailRowActions、Router 的操作处理负责权限、影响查询、API 调用和缓存刷新。业务层选择语义 variant，不手写按钮颜色。

不建议现在增加一个覆盖所有对象的通用 CRUD 组件：Guardrail 删除需查询依赖，Route 删除只改变草稿，Endpoint 凭据撤销可能立即生效，硬塞进同一个组件会引入大量开关。

## 后续收敛范围

本轮是全局共享定义修正及核心路径迁移，不代表每个页面都已完成语义标注。剩余创建向导、Policy 编辑器、Models、Settings 等提交入口需要按动作逐项分类；不能根据按钮文案或是否含 Plus/Pencil 图标自动替换。

统一高度也应单独处理：当前 size=default 为 36px，很多控制台入口自行加 min-h-11。建议为控制台密度建立清晰尺寸约定后再迁移，而不是本轮全局放大所有按钮，破坏紧凑表格和编辑器。

Route 目前使用 EntitySheet 自行实现删除确认，Guardrail 使用业务删除侧栏，其他页面复用 ConfirmationSheet。可以优先将简单确认接入 ConfirmationSheet，保留业务影响内容插槽；本轮不改动删除行为。

## 验收约定

新增页面必须显式选择创建、编辑、删除语义；className 用于布局，不覆盖操作颜色。行尾只保留省略号菜单，不恢复多枚彩色图标常驻。只读用户不获得写入操作；pending 禁止重复提交；敏感动作确认必须说明对象和实际影响。

## 后续修复记录

已继续迁移 Router 创建确认、增加/删除 Route、Selector 条件/分组/值、GuardRail 目标删除、GuardRail 副本创建、草稿编辑、Endpoint 注册/删除/凭据撤销、Models 新增/移除、测试用例新增/删除与防护绑定移除。均使用现有共享 variant，不改变操作权限或确认行为。12 项相关回归测试、前后端构建通过。38184 预览已恢复，但后端拒绝该预览来源登录（Invalid origin），本轮未完成登录后的视觉复核。

## Router 详情页与列表操作

详情页标题区使用显式、等高、可换行的按钮组：Edit routing 与 Rename Router 使用 `edit` 黄色，View revisions 使用 `outline` 中性色。查看动作不使用创建色。创建保持 `create` 蓝色，删除保持 `destructive` 红色。

列表行尾使用省略号菜单，提供查看详情、编辑路由、查看版本；编辑操作仅管理员可见。详情页直接按钮与列表菜单是不同信息密度下的呈现方式，复用同一套语义颜色，不再把详情页操作藏到省略号内。
