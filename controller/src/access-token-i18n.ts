import type { TokenModule } from "../shared/access-tokens";

export const accessTokenModuleCopy: Record<TokenModule, [string, string, string, string]> = {
  guardrails: ["GuardRails", "GuardRails", "配置、版本、发布、回滚与验证", "Configuration, versions, publication, rollback and validation"],
  routers: ["Routers", "Routers", "路由规则、版本、发布与 Endpoint 绑定", "Routing rules, revisions, publication and Endpoint bindings"],
  endpoints: ["Endpoints", "Endpoints", "接入配置与访问凭据", "Integration settings and access credentials"],
  policies: ["策略库", "Policy Library", "策略配置、验证与发布", "Policy configuration, validation and publication"],
  playground: ["Playground", "Playground", "读取模型；读写权限可运行交互", "Read models; read and write access can run interactions"],
  models: ["模型配置", "Model configuration", "模型、提供商与配置发布", "Models, providers and configuration activation"],
  runners: ["Runners", "Runners", "Runner 状态、容量与实例管理", "Runner status, capacity and instance management"],
  runtime: ["运行日志", "Runtime logs", "运行事件、流量指标与调用内容（只读）", "Runtime events, traffic metrics and captured content (read only)"],
  audit: ["审计日志", "Audit log", "系统操作记录（只读）", "System activity records (read only)"],
};
