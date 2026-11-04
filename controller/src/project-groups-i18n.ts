export const projectGroupsEn = {
  runtimeModels: "Model access",
  modelsUnavailable:
    "The current Model policy is unavailable. Reload it before making changes.",
  modelsApply: "Apply Model policy",
  modelsCurrent: "Current policy",
  modelsPolicyVersion: "Version",
  modelsGranted: "Granted Models",
  modelsMode: "Model access",
  modelsPlatform: "Platform defaults",
  modelsScoped: "Validated configuration",
  modelsBlocked: "Blocked",
  modelsPlatformHint:
    "The default shared Runner follows the platform runtime bindings and can retrieve their Provider credentials. Changes to platform defaults also affect the shared Runner.",
  modelsScopedHint:
    "Grant a validated runtime configuration to the displayed Runner scope. Runtime settings and encrypted Provider credentials are captured together; later edits require a new grant.",
  modelsBlockedHint:
    "Remove runtime Model assignments and deny future active credential retrieval. This does not stop every request already running.",
  modelsCredentialLimit:
    "A saved policy changes future configuration and credential retrieval. Keys already delivered to Runners require separate rotation or fencing. Platform administrator validation jobs use their own short-lived grants.",
  modelsSource: "Validated source",
  modelsChooseSource: "Choose a validated revision",
  modelsNoSource:
    "No eligible validated configuration is available. Validate runtime bindings in the Guardrail Catalog, then refresh and review here.",
  modelsSettings: "Guardrail Catalog",
  modelsBindings: "Runtime bindings to grant",
  modelsValidatedAt: "Validated",
  modelsConflict:
    "Reload and review before retrying. Changes are never retried with a newer policy version automatically.",
  groups: "Runner", loading: "Loading model access…", cancel: "Cancel", saving: "Saving…", review: "Refresh and review", empty: "None",
};
export type ProjectGroupsCopy = typeof projectGroupsEn;
export const projectGroupsZh: ProjectGroupsCopy = {
  runtimeModels: "模型授权",
  modelsUnavailable: "当前模型策略不可用。请重新加载后再进行更改。",
  modelsApply: "应用模型策略",
  modelsCurrent: "当前策略",
  modelsPolicyVersion: "版本",
  modelsGranted: "已授权模型",
  modelsMode: "模型访问权限",
  modelsPlatform: "平台默认配置",
  modelsScoped: "已验证的配置",
  modelsBlocked: "阻止访问",
  modelsPlatformHint:
    "default 共享 Runner 使用平台运行时绑定及对应的提供方凭证，并跟随平台默认配置更新。",
  modelsScopedHint:
    "为上述 Runner 授权已验证的配置，同时保存运行时设置及加密的提供方凭证；后续修改需重新授权。",
  modelsBlockedHint:
    "移除上述 Runner 的模型绑定，并拒绝今后的活动凭证获取。这不会停止全部已在执行的请求。",
  modelsCredentialLimit:
    "保存策略会改变今后的配置下发与凭证获取。Runner 已收到的密钥需另行轮换或通过可靠隔离措施撤销。平台管理员的验证任务使用独立的短期授权。",
  modelsSource: "已验证的来源",
  modelsChooseSource: "选择已验证的配置版本",
  modelsNoSource:
    "暂无符合条件的已验证配置。请先在 Guardrail 目录中验证运行时绑定，再在此刷新并确认。",
  modelsSettings: "Guardrail 目录",
  modelsBindings: "待授权的运行时绑定",
  modelsValidatedAt: "验证时间",
  modelsConflict:
    "重试前请重新加载并确认。系统不会自动使用较新的策略版本重试。",
  groups: "Runner", loading: "正在加载模型授权…", cancel: "取消", saving: "保存中…", review: "刷新并重新确认", empty: "无",
};
