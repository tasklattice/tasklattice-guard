import type { TokenModule } from "../shared/access-tokens";

type ModuleTranslations = Record<TokenModule, { name: string; description: string }>;

export const accessTokensEn = {
  "revokedToast": "Token revoked",
  "readWrite": "Read and write",
  "readOnly": "Read only",
  "title": "Personal access tokens",
  "description": "Let scripts and integrations call the system as you. Each token is limited to its selected modules and your current account permissions.",
  "create": "Create token",
  "loading": "Loading tokens…",
  "emptyTitle": "No access tokens yet",
  "emptyDescription": "Create a separate token for each integration and select only the permissions it needs.",
  "revoked": "Revoked",
  "expired": "Expired",
  "scope": "Scope: all resources in selected modules",
  "createdAt": "Created: ",
  "expiresAt": "Expires: ",
  "lastUsedAt": "Last used: ",
  "usageTitle": "Use a token",
  "usageDescription": "Send the token in the Authorization: Bearer header. This endpoint returns your identity and token permissions.",
  "createTitle": "Create access token",
  "createDescription": "Bind a token to your account, choose an expiration and grant module permissions. Unselected modules are inaccessible.",
  "creating": "Creating…",
  "name": "Name",
  "namePlaceholder": "e.g. CI deployment",
  "expiration": "Expiration",
  "permissionsTitle": "Module permissions",
  "permissionsDescription": "Access covers all resources in each selected module, including future resources. Read and write includes creation, changes, publication and deletion.",
  "readOnlyHint": "Your tokens can access Guardrail design and integrations. Platform settings, Runner management and audit logs require an administrator.",
  "noAccess": "No access",
  "selectPermissionHint": "Select at least one module permission.",
  "issuedTitle": "Token created",
  "issuedDescription": "Copy and store it now. You cannot view the full token again after closing.",
  "done": "Done",
  "copied": "Token copied",
  "copyFailed": "Copy failed. Select and copy the token manually.",
  "copy": "Copy token",
  "revokeTitle": "Revoke {{name}}?",
  "revokeDescription": "Subsequent requests using this token will be rejected. This cannot be undone; create a new token if needed.",
  "revoking": "Revoking…",
  "revokeToken": "Revoke token",
  "days_one": "{{count}} day",
  "days_other": "{{count}} days",
  "revoke": "Revoke",
  "revokeLabel": "Revoke {{name}}",
  "selectedModules_one": "{{count}} module selected. The token will be shown only once after creation.",
  "selectedModules_other": "{{count}} modules selected. The token will be shown only once after creation.",
  "tokenLabel": "Access Token",
  "modules": {
    "guardrails": {
      "name": "GuardRails",
      "description": "Configuration, versions, publication, rollback and validation"
    },
    "routers": {
      "name": "Routers",
      "description": "Routing rules, revisions, publication and Endpoint bindings"
    },
    "endpoints": {
      "name": "Endpoints",
      "description": "Integration settings and access credentials"
    },
    "policies": {
      "name": "Policy Library",
      "description": "Policy configuration, validation and publication"
    },
    "playground": {
      "name": "Playground",
      "description": "Read models; read and write access can run interactions"
    },
    "models": {
      "name": "Model configuration",
      "description": "Models, providers and configuration activation"
    },
    "runners": {
      "name": "Runners",
      "description": "Runner status, capacity and instance management"
    },
    "runtime": {
      "name": "Runtime logs",
      "description": "Runtime events, traffic metrics and captured content (read only)"
    },
    "settings": { "name": "Platform settings", "description": "Provider management, model assignments and platform configuration" },
    "audit": {
      "name": "Audit log",
      "description": "System activity records (read only)"
    }
  }
} satisfies { modules: ModuleTranslations } & Record<string, unknown>;

export const accessTokensZh: typeof accessTokensEn = {
  "revokedToast": "Token 已撤销",
  "readWrite": "读写",
  "readOnly": "只读",
  "title": "个人 Access Tokens",
  "description": "让脚本或集成以你的身份调用系统。每个 Token 仅能访问你授权的模块，且不会超过你当前的账户权限。",
  "create": "创建 Token",
  "loading": "正在加载 Tokens…",
  "emptyTitle": "尚无 Access Token",
  "emptyDescription": "为每个集成创建独立的 Token，仅选择它需要的权限。",
  "revoked": "已撤销",
  "expired": "已过期",
  "scope": "范围：所选模块中的全部资源",
  "createdAt": "创建于：",
  "expiresAt": "到期：",
  "lastUsedAt": "最近使用：",
  "usageTitle": "调用方式",
  "usageDescription": "通过 Authorization: Bearer 请求头传入 Token。以下接口返回身份和 Token 授权范围。",
  "createTitle": "创建 Access Token",
  "createDescription": "绑定当前账户，选择有效期和模块权限。未选择的模块无法访问。",
  "creating": "正在创建…",
  "name": "名称",
  "namePlaceholder": "例如：CI 发布",
  "expiration": "有效期",
  "permissionsTitle": "模块权限",
  "permissionsDescription": "范围覆盖所选模块的全部资源，包括未来新增资源。读写包括创建、修改、发布和删除。",
  "readOnlyHint": "你的令牌可以访问 Guardrail 设计、集成和运行观测功能。平台设置、Runner 管理和审计日志需要管理员权限。",
  "noAccess": "无权限",
  "selectPermissionHint": "至少选择一个模块权限。",
  "issuedTitle": "Token 已创建",
  "issuedDescription": "现在复制并妥善保存。关闭后将无法再次查看完整 Token。",
  "done": "完成",
  "copied": "已复制 Token",
  "copyFailed": "复制失败，请手动选中并复制。",
  "copy": "复制 Token",
  "revokeTitle": "撤销 {{name}}？",
  "revokeDescription": "撤销后，使用此 Token 的后续请求将被拒绝。此操作不可撤回，需要时可创建新的 Token。",
  "revoking": "正在撤销…",
  "revokeToken": "撤销 Token",
  "days_one": "{{count}} 天",
  "days_other": "{{count}} 天",
  "revoke": "撤销",
  "revokeLabel": "撤销 {{name}}",
  "selectedModules_one": "已选择 {{count}} 个模块。Token 明文仅在创建后展示一次。",
  "selectedModules_other": "已选择 {{count}} 个模块。Token 明文仅在创建后展示一次。",
  "tokenLabel": "Access Token",
  "modules": {
    "guardrails": {
      "name": "GuardRails",
      "description": "配置、版本、发布、回滚与验证"
    },
    "routers": {
      "name": "Routers",
      "description": "路由规则、版本、发布与 Endpoint 绑定"
    },
    "endpoints": {
      "name": "Endpoints",
      "description": "接入配置与访问凭据"
    },
    "policies": {
      "name": "策略库",
      "description": "策略配置、验证与发布"
    },
    "playground": {
      "name": "Playground",
      "description": "读取模型；读写权限可运行交互"
    },
    "models": {
      "name": "模型配置",
      "description": "模型、提供商与配置发布"
    },
    "runners": {
      "name": "Runners",
      "description": "Runner 状态、容量与实例管理"
    },
    "runtime": {
      "name": "运行日志",
      "description": "运行事件、流量指标与调用内容（只读）"
    },
    "settings": { "name": "平台设置", "description": "提供商管理、模型分配和平台配置" },
    "audit": {
      "name": "审计日志",
      "description": "系统操作记录（只读）"
    }
  }
};
