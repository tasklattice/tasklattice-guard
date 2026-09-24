# Document 文档

文档正文在仓库根目录维护。`docs/document/<locale>/<category>/` 中的目录名是稳定的分类 ID，每个分类包含多篇 MDX 文章。`zh-CN` 和 `en` 保持相同的分类、文章 ID 与章节锚点，便于切换语言及保留深链接。

```text
docs/document/
  zh-CN/
    overview/
      _category.json
      01-quickstart-protection.mdx
      03-term-guardrail.mdx
      ...
    operator/
    admin/
    developer/
    api/
  en/
    ...
```

分类顺序由各目录的 `_category.json` 中的 `order` 定义；`title` 是侧边栏展示名，`description` 简述分类。当前阅读路径为**核心产品概念 → 操作指南 → 平台管理 → 集成参考 → API 参考**。核心产品概念介绍 Guardrails、Policy Library、Playground、Traffic Routers 和 Endpoints；Rule、Binding、Decision、Selector、版本和状态机作为相关对象的章节解释，不再设独立术语表。操作指南解释配置和发布步骤；平台管理说明 Runner、模型、账户、运行日志与审计日志。集成参考先区分控制面（Controller API 接入自建编辑与发布流程）和数据面（LiteLLM、自研 AI Gateway 或 Agent 接入运行时检查），再介绍数据面协议。目录按任务组织，写入操作仍受控制台账户权限限制。文章按 frontmatter 的 `order` 排序，建议文件名也使用相同的两位序号。每个分类至少保留两篇文章。

文章使用以下格式，标题只写在 frontmatter，不在正文重复写 `#` 标题。正文从导语或 `##` 小节开始；需要稳定深链接时，在标题前写一个锚点。

```mdx
---
id: "quickstart-protection"
title: "快速开始：完成一条保护链路"
summary: "用一个场景理解产品对象如何协作并完成接入。"
order: 0
---

这里是文章导语。

<a id="overview-boundary" />

## 产品负责什么

这里是小节正文。
```

文章 `id` 对应 `/document#<id>`；编译插件把小节锚点移到标题上，并从同一份 MDX 生成右侧“本页目录”和搜索索引。左侧按目录名分组展示文章，默认只展开当前分类。旧版术语和状态深链接改为相应对象文章的章节锚点；旧分类锚点由 `controller/src/routes/help.tsx` 映射到对应文章。

正文使用普通 Markdown 的段落、标题、列表、链接、引用、代码块和表格。结构化状态卡片、资源地图与流程图仍可使用 `controller/src/components/help/` 导出的 MDX 组件。站内链接使用绝对路径，例如 `[API 文档](/api/docs)`；代码块中的 `{controllerOrigin}` 在渲染时替换为当前站点地址。

`controller/src/content/help/<locale>/interface.json` 只保留搜索、目录等界面标签，不存放文章正文。文章加载逻辑在 `controller/src/features/help-content.ts`，目录和文章布局在 `controller/src/routes/help.tsx`，MDX 标题索引由 `controller/scripts/remark-help-index.mjs` 在构建时生成。新增文章后运行 `npm run build:ui` 与 `npm test -- src/features/help-content.test.ts`；修改 Controller 容器构建时还要确认根目录 `Dockerfile.controller` 把本目录复制进构建阶段。
