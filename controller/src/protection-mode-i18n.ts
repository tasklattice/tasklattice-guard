export const protectionModeEn = {
  observation: "Detection result: {{result}}. Original content was allowed.",
  title: "Protection mode", change: "Change mode", apply: "Apply mode", enableBypass: "Enable emergency bypass",
  requested: "Requested", reason: "Reason (optional)", submitted: "Protection mode submitted to Runners.",
  scope: "Applies to every online version and Endpoint using this Guardrail. Endpoint authentication stays enabled. Publication and version tests are unchanged.",
  notReady: "Publish an executable version before changing the protection mode.", unavailable: "Protection settings are unavailable. Refresh to retry.",
  switching: "Switching to {{mode}}", progress: "{{applied}}/{{total}} Runners applied", retry: "Retry rollout", details: "Runner application details",
  updated: "Changed {{time}} by {{actor}}", system: "System", reasonValue: "Reason: {{reason}}",
  states: { applied: "Applied", applying: "Applying", partial: "Partially applied", failed: "Needs attention", waiting: "Waiting for a Runner" },
  runners: { applied: "Applied", pending: "Pending", offline: "Offline", unsupported: "Upgrade Runner to support protection modes", failed: "Rejected" },
  descriptions: { enforce: "Inspect content and enforce the published policies.", monitor: "Inspect and record results; allow original content without blocking or changing it.", bypass: "Skip detection and allow content. Runtime records identify emergency bypass." },
};

export const protectionModeZh = {
  observation: "检测结果：{{result}}。实际请求已按原文放行。",
  title: "防护模式", change: "切换运行模式", apply: "应用模式", enableBypass: "启用应急放行",
  requested: "目标", reason: "变更原因（选填）", submitted: "防护模式已提交，等待 Runner 确认。",
  scope: "作用于该 Guardrail 的所有线上版本及其 Endpoint 引用。Endpoint 身份校验继续有效，版本发布和测试流程保持不变。",
  notReady: "发布一个可执行版本后，即可修改防护模式。", unavailable: "防护配置暂不可用，请刷新重试。",
  switching: "正在切换到 {{mode}}", progress: "{{applied}}/{{total}} Runner 已生效", retry: "重试下发", details: "Runner 生效详情",
  updated: "{{actor}} 于 {{time}} 修改", system: "系统", reasonValue: "原因：{{reason}}",
  states: { applied: "已生效", applying: "正在生效", partial: "部分生效", failed: "需要处理", waiting: "等待 Runner 连接" },
  runners: { applied: "已生效", pending: "等待确认", offline: "离线", unsupported: "请升级 Runner 以支持防护模式", failed: "应用失败" },
  descriptions: { enforce: "执行检测，按已发布的策略阻断、修改或放行。", monitor: "执行检测并记录结果，原文放行，不阻断也不修改内容。", bypass: "跳过检测，直接放行，运行记录标记为应急放行。" },
};
