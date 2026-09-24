export type Tone = "neutral" | "change" | "healthy" | "error";
export type HelpVisualLocale = "en" | "zh-CN";

export function resourceMapCopy(locale: HelpVisualLocale) {
  const zh = locale === "zh-CN";
  return {
    title: zh ? "Guardrail 资源互联地图" : "Guardrail resource relationship map",
    implementation: zh ? "实现形式" : "implementation",
    testCases: zh ? "Test Case 验证行为" : "Test Cases verify behavior",
    caption: zh
      ? "Policy 包含多条 Rule 和 Test Cases，每条 Rule 选择一种实现形式；Guardrail 通过 Binding 固定多个 Policy Version。上下两排的 Guardrail Version 是同一个不可变版本。"
      : "A Policy contains Rules and Test Cases; each Rule selects an implementation form. A Guardrail pins multiple Policy Versions through Bindings. Guardrail Version is the same immutable version in both lanes.",
    lanes: [
      { title: zh ? "定义与发布" : "Define and publish", nodes: [
        { title: "Policy", detail: zh ? "可复用的检测能力" : "Reusable detection capability" },
        { title: "Policy Version", detail: zh ? "不可变能力快照" : "Immutable capability" },
        { title: "Guardrail", detail: zh ? "绑定多个 Policy Version" : "Binds Policy Versions", logo: true },
        { title: "Guardrail Version", detail: zh ? "验证后发布的快照" : "Validated snapshot", logo: true },
      ] },
      { title: zh ? "接入与执行" : "Route and execute", nodes: [
        { title: "Endpoint", detail: zh ? "认证调用方" : "Authenticates caller" },
        { title: "Router Revision", detail: "Routes → Targets" },
        { title: "Guardrail Version", detail: zh ? "固定执行内容" : "Pinned behavior", logo: true },
        { title: "Runner", detail: zh ? "执行 Rails / Actions" : "Runs Rails / Actions" },
        { title: "Decision + Evidence", detail: zh ? "调用方执行决策" : "Caller enforces decision" },
      ] },
    ],
  };
}

export function stateLegendCopy(locale: HelpVisualLocale): { title: string; items: Array<{ tone: Tone; label: string }> } {
  const zh = locale === "zh-CN";
  return {
    title: zh ? "状态颜色图例" : "State color legend",
    items: [
      { tone: "neutral", label: zh ? "灰色：草稿／历史／已停用／尚未开始" : "Gray: draft, historical, disabled, or not started" },
      { tone: "change", label: zh ? "黄色：排队／验证／下发中" : "Amber: queued, validating, or distributing" },
      { tone: "healthy", label: zh ? "绿色：验证通过／已就绪／保护中／已生效" : "Green: passed, ready, protected, or active" },
      { tone: "error", label: zh ? "红色：失败／离线／需处理" : "Red: failed, offline, or action required" },
    ],
  };
}

export type StateMachineKind = "guardrail-readiness" | "guardrail-lifecycle" | "validation" | "guardrail-version" | "router" | "endpoint" | "runner" | "model-probe" | "model-revision";
type Node = { id: string; x: number; y: number; tone: Tone };
type Edge = { path: string; x: number; y: number; label: string };
type Graph = { title: string; caption: string; height: number; nodes: Node[]; edges: Edge[] };

export function graph(kind: StateMachineKind, zh: boolean): Graph {
  const label = (chinese: string, english: string) => zh ? chinese : english;
  const node = (id: string, x: number, y: number, tone: Tone): Node => ({ id, x, y, tone });
  const edge = (path: string, x: number, y: number, chinese: string, english: string): Edge => ({ path, x, y, label: label(chinese, english) });
  switch (kind) {
    case "guardrail-readiness": return {
      title: label("Guardrail 展示状态：从待验证到保护中", "Guardrail display state: from testing to protection"),
      caption: label("状态由当前草稿、活动版本和已发布路由引用重新计算；它不是数据库生命周期。", "This projection is recomputed from the current draft, active version, and published route references; it is not the database lifecycle."),
      height: 370,
      nodes: [node("needs_validation", 370, 18, "change"), node("ready", 70, 230, "healthy"), node("protected", 670, 230, "healthy")],
      edges: [
        edge("M405 72 Q290 150 190 230", 260, 145, "发布当前草稿", "Publish current draft"),
        edge("M495 72 Q610 150 750 230", 648, 145, "发布且已有引用", "Publish with a route"),
        edge("M230 257 L670 257", 450, 240, "已发布 Route 引用", "Published Route references it"),
        edge("M670 287 Q450 354 230 287", 450, 336, "移除最后引用", "Remove last reference"),
        edge("M115 230 Q130 100 370 45", 150, 94, "修改草稿", "Edit draft"),
        edge("M825 230 Q820 100 530 45", 750, 94, "修改草稿", "Edit draft"),
      ],
    };
    case "guardrail-lifecycle": return {
      title: label("Guardrail 资源生命周期", "Guardrail resource lifecycle"),
      caption: label("disabled 是该资源的终态；保护中属于上方的展示状态。", "Disabled is terminal for this resource. Protected belongs to the display-state diagram above."),
      height: 215,
      nodes: [node("draft", 50, 70, "neutral"), node("active", 370, 70, "healthy"), node("disabled", 690, 70, "neutral")],
      edges: [edge("M210 97 L370 97", 290, 78, "发布版本", "Publish version"), edge("M530 97 L690 97", 610, 78, "停用", "Disable"), edge("M130 124 Q450 212 770 124", 450, 181, "草稿可直接停用", "Draft can be disabled")],
    };
    case "validation": return {
      title: label("验证任务状态机", "Validation run state machine"),
      caption: label("queued 可以直接完成；passed 和 failed 是本次验证的终态。", "Queued may complete directly. Passed and failed are terminal for this run."),
      height: 285,
      nodes: [node("queued", 40, 105, "change"), node("running", 345, 105, "change"), node("passed", 700, 22, "healthy"), node("failed", 700, 205, "error")],
      edges: [edge("M200 132 L345 132", 273, 114, "开始执行", "Start"), edge("M505 124 Q600 115 700 65", 605, 95, "通过", "Pass"), edge("M505 140 Q600 155 700 232", 605, 177, "失败", "Fail"), edge("M120 105 Q300 18 700 50", 440, 30, "队列可直接完成", "Direct completion"), edge("M120 159 Q300 270 700 232", 440, 262, "派发失败", "Dispatch failure")],
    };
    case "guardrail-version": return {
      title: label("不可变版本的构建状态", "Immutable version build states"),
      caption: label("ready 与 failed 都是终态；活动版本指针是独立概念。", "Ready and failed are terminal. The active-version pointer is separate."),
      height: 260,
      nodes: [node("compiling", 85, 103, "change"), node("ready", 660, 25, "healthy"), node("failed", 660, 182, "error")],
      edges: [edge("M245 122 Q450 120 660 52", 450, 88, "编译成功", "Compiled"), edge("M245 138 Q450 145 660 209", 450, 175, "编译失败", "Build failed")],
    };
    case "router": return {
      title: label("Router 发布与下发状态机", "Router publication and rollout state machine"),
      caption: label("active 取决于默认池 Runner 的有效确认；心跳或代次变化可以让状态回到 distributing。", "Active requires fresh acknowledgments from default-pool Runners. Heartbeat or generation changes can return it to distributing."),
      height: 330,
      nodes: [node("unpublished", 15, 112, "neutral"), node("distributing", 345, 112, "change"), node("active", 720, 25, "healthy"), node("failed", 720, 225, "error")],
      edges: [edge("M175 139 L345 139", 260, 121, "发布", "Publish"), edge("M505 124 Q620 110 720 68", 615, 92, "全部确认", "All ACKs fresh"), edge("M505 154 Q625 185 720 252", 610, 195, "下发错误", "Rollout error"), edge("M720 279 Q585 323 505 166", 620, 304, "重新发布", "Republish"), edge("M720 52 Q570 -2 460 112", 605, 25, "心跳失效 / 新代次", "Stale / new generation")],
    };
    case "endpoint": return {
      title: label("Endpoint 启停状态机", "Endpoint enablement state machine"),
      caption: label("主动 disabled 可以恢复；软删除是独立覆盖条件。", "Intentional disabling is reversible; soft deletion is a separate overlay."),
      height: 200,
      nodes: [node("active", 150, 75, "healthy"), node("disabled", 590, 75, "neutral")],
      edges: [edge("M310 88 Q450 25 590 88", 450, 48, "停用", "Disable"), edge("M590 116 Q450 180 310 116", 450, 166, "重新启用", "Re-enable")],
    };
    case "runner": return {
      title: label("Runner 同步、压力与失联", "Runner synchronization, pressure, and disconnection"),
      caption: label("这是同步状态与容量压力的合成投影，不是只能沿箭头单向变化的持久状态机。", "This is a projection of reconciliation and capacity, not a one-way persisted lifecycle."),
      height: 340,
      nodes: [node("syncing", 40, 112, "change"), node("ready", 315, 112, "healthy"), node("busy", 590, 25, "change"), node("saturated", 590, 205, "error"), node("offline", 40, 270, "error")],
      edges: [edge("M200 139 L315 139", 258, 121, "代次已应用", "Generation applied"), edge("M475 125 Q530 105 590 68", 535, 100, "负载升高", "Load rises"), edge("M475 153 Q530 175 590 232", 535, 192, "容量耗尽", "Capacity exhausted"), edge("M590 52 Q470 -6 395 112", 465, 27, "负载回落", "Load falls"), edge("M590 259 Q470 325 395 166", 465, 306, "容量恢复", "Capacity recovers"), edge("M100 166 L100 270", 120, 224, "失联", "Disconnect"), edge("M120 270 Q250 220 120 166", 235, 239, "重连", "Reconnect")],
    };
    case "model-probe": return {
      title: label("Provider / Model 验证状态", "Provider / Model validation states"),
      caption: label("配置变化会重新进入 pending；连接检查与能力验证仍需分别查看。", "Configuration changes reset to pending. Transport and capability validation remain separate checks."),
      height: 270,
      nodes: [node("pending", 70, 110, "change"), node("validated", 650, 25, "healthy"), node("failed", 650, 190, "error")],
      edges: [edge("M230 125 Q435 105 650 52", 430, 88, "探测通过", "Probe passed"), edge("M230 150 Q435 165 650 217", 430, 180, "探测失败", "Probe failed"), edge("M650 40 Q425 -18 155 110", 430, 20, "配置变化", "Config changed"), edge("M650 244 Q425 304 155 164", 430, 267, "配置变化", "Config changed")],
    };
    case "model-revision": return {
      title: label("模型配置 Revision 状态机", "Model configuration revision state machine"),
      caption: label("应用会创建 activating 快照；替换已生效配置要创建新 revision。", "Applying creates an activating snapshot. Replacing an active configuration creates a new revision."),
      height: 285,
      nodes: [node("draft", 10, 110, "neutral"), node("validated", 220, 110, "healthy"), node("activating", 440, 110, "change"), node("active", 715, 25, "healthy"), node("failed", 715, 205, "error")],
      edges: [edge("M170 137 L220 137", 195, 118, "验证", "Validate"), edge("M380 137 L440 137", 410, 118, "应用", "Apply"), edge("M600 125 Q660 105 715 68", 665, 95, "收敛", "Converged"), edge("M600 152 Q660 185 715 232", 665, 195, "失败", "Failed"), edge("M220 164 Q195 235 170 164", 195, 220, "修改", "Edit")],
    };
  }
}
