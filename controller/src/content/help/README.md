# Help 文档维护

Help 正文在此目录维护，使用 MDX，不在 TypeScript 中写文案数组。

- `en/`、`zh-CN/`：对应语言的文档。
- `api.mdx`：Help 顶部 API 入口。
- `overview.mdx`：系统概览。
- `user.mdx`、`developer.mdx`、`operator.mdx`：角色指南。
- `glossary.mdx`：概念词典。
- `interface.json`：搜索、目录、空状态等界面标签，不存放文档正文。

每份 MDX 的 YAML frontmatter 定义 `kind`、`id`、`title`、`summary` 和 `order`，角色指南还定义 `audience`、`label`、`outcome`。正文使用普通 Markdown 的段落、标题、列表、链接、引用、代码块和表格。

需要稳定目录锚点时，在 Markdown 标题前写：

```mdx
<a id="developer-api-access" />

### 调用 Controller API

这里写正文。
```

构建插件会把 ID 移到标题上，同时从标题和正文生成目录与搜索索引。每种语言内的 ID 必须唯一；语言之间保留相同 ID，便于切换。无需手写搜索词或修改 TS 来新增正文小节。

链接使用当前服务的绝对路径，例如 `[API 文档](/api/docs)`。渲染器将应用页面交给 SPA 路由，`/api/*` 和 `/metrics` 使用普通 HTTP 链接。代码块中的 `{controllerOrigin}` 由渲染器替换成当前站点地址，不固定开发机端口。Frontmatter 和代码块之外若需字面量 `{`、`}`、`<`，使用 Markdown 转义或行内代码，避免被 MDX 当作表达式/JSX。

渲染职责分别位于：

- `src/routes/help.tsx`：页面布局、Markdown 元素样式、链接、当前地址替换和搜索跳转。
- `src/features/help-content.ts`：按语言加载文档、排序和搜索生成的索引。
- `scripts/remark-help-index.mjs`：编译期间从 MDX AST 生成锚点及搜索信息。
- `vite.config.ts`：接入 MDX、frontmatter 和 GFM 编译。浏览器不运行 MDX 编译器。

修改后执行 `npm run build:ui`。涉及目录、搜索或 Action 契约时，执行 `npm test -- src/features/help-content.test.ts`。Action 的展示顺序、名称和冲突优先级应与 shared 中的生成契约一致，测试会检查两种语言。

结构化内容可以直接在 MDX 中写组件。含义、迁移条件、下一步以及状态名称和代码均在 MDX 维护：

```mdx
<StateCards>
  <StateCard title="已生效" code="active">
    <StateDetail label="含义">所有目标 Runner 已确认且心跳有效。</StateDetail>
    <StateDetail label="下一步">观察流量和运行日志。</StateDetail>
  </StateCard>
</StateCards>

<FlowSteps>
  <FlowStep title="Endpoint">认证调用方身份。</FlowStep>
  <FlowStep title="Router">匹配路由并选择目标版本。</FlowStep>
</FlowSteps>
```

`src/components/help/document-blocks.tsx` 只负责卡片、徽标和流程布局，复用系统 StateBadge。可选 `state` 属性控制徽标样式（例如 code="compiling" state="distributing"）；`code` 保留原始状态代码。索引插件自动提取 title、code、label 及 Markdown 子内容，不索引样式属性。卡片是静态解释，不读取实时运行状态。

API 链接显示在紧凑标题栏；搜索及结果显示在左侧目录，正文保持可见。窄屏从目录按钮展开搜索与导航，定位后收起。
