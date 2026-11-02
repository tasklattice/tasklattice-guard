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

分类顺序由各目录的 `_category.json` 中的 `order` 定义；`title` 是侧边栏展示名，`description` 简述分类。当前阅读路径为**核心产品概念 → 操作指南 → 平台与观测 → 集成参考 → API 参考**。核心产品概念介绍 Guardrails、Policy Library、Playground、Routers 和 Endpoints；Rule、Binding、Decision、Selector、版本和状态机作为相关对象的章节解释，作为对象内部概念解释。操作指南解释配置和发布步骤；平台与观测说明 Runner、模型、账户、运行日志与审计日志。集成参考先区分控制面（Controller API 接入自建编辑与发布流程）和数据面（LiteLLM、自研 AI Gateway 或 Agent 接入运行时检查），再介绍数据面协议。目录按任务组织，写入操作仍受控制台账户权限限制。文章按 frontmatter 的 `order` 排序，建议文件名也使用相同的两位序号。每个分类至少保留两篇文章。

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

文章路径为 `/document/<category>/<id>`，其中 `category` 来自目录名，`id` 来自 frontmatter。例如快速开始的路径是 `/document/overview/quickstart-protection`，其中“六步完成保护链路”的链接是 `/document/overview/quickstart-protection#quickstart-steps`。`/document` 入口跳转到第一篇文章；不存在的文章显示找不到文档，不会自动回到第一篇。

所有文档均可通过链接匿名访问，无需登录。`/document`、文章与章节深链接、旧 `/help` 链接，以及 `/api/docs`、`/api/openapi.json`、`/api/llms.txt` 均公开；文档阅读不等待登录状态查询。

编译插件把小节锚点移到标题上，并从同一份 MDX 生成右侧“本页目录”和搜索索引。左侧按目录名分组展示文章，默认只展开当前分类。路径选择文章，`#` 只定位该文章内的章节；章节 ID 只需在文章内唯一。两种语言共用文章路径与章节 ID，由语言选择器切换正文。

正文使用普通 Markdown 的段落、标题、列表、链接、引用、代码块和表格。结构化状态卡片、资源地图与流程图仍可使用 `controller/src/components/help/` 导出的 MDX 组件。同篇文章内使用 `[六步完成保护链路](#quickstart-steps)`；跨文章链接必须带目标文章路径，例如 `[Rule 检测器](/document/overview/glossary-definition#term-rule-implementation)`。其他站内链接使用绝对路径，例如 `[API 文档](/api/docs)`；代码块中的 `{controllerOrigin}` 在渲染时替换为当前站点地址。

`controller/src/content/help/<locale>/interface.json` 只保留搜索、目录等界面标签，不存放文章正文。文章加载逻辑在 `controller/src/features/help-content.ts`，目录和文章布局在 `controller/src/routes/help.tsx`，MDX 标题索引由 `controller/scripts/remark-help-index.mjs` 在构建时生成。新增文章后运行 `npm run build:ui` 与 `npm test -- src/features/help-content.test.ts`；修改 Controller 容器构建时还要确认根目录 `Dockerfile.controller` 把本目录复制进构建阶段。

## 内容审阅约定

先按当前代码和公开契约核对行为，再修改措辞。优先检查角色权限、接口字段与默认值、发布和审批条件、运行模式，以及界面入口。区分已实现能力、已知限制和高级实现细节，不把计划写成当前行为。不保留未上线版本的编辑入口、迁移步骤或兼容指南。

每篇文章只承担一项主要阅读任务。概念文章先说明对象与边界，操作文章按准备、配置、验证、发布组织，协议文章按接口类型、认证、请求、响应、错误处理组织。较长文章用二级标题划分主题、三级标题展开步骤，保留已有稳定锚点。中英文同步更新章节结构与技术含义。

技术写作使用明确主语、短句和一致术语。一个句子只给一个操作指令，说明文字一段只讲一个主题。英文参考 ASD-STE100 Skill 的结构规则：指令不超过 20 词，说明句不超过 25 词，避免分号和多层从句。保留必要的条件、例外与不确定性，不能为缩短句子改变技术含义。这不等同于通过 ASD 官方词典认证。

HTTP 示例同时展示请求方法、路径、所需 Header、Body，以及响应状态、Header 和 Body。省略自动生成的 Header 时说明省略范围。字段表分别列出必填性、数据类型和默认值。WebSocket 握手与消息体分开说明。

修改后运行文档加载、双语锚点和页面导航测试，以及 UI 构建。使用真实桌面页面核对目录分组、长标题、表格和代码示例，不执行移动端回归。
