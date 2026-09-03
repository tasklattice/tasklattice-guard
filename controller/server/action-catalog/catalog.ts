export type ActionDefinition = {
  name: string;
  version: string;
  input_schema: Array<[string, string]>;
  output_schema: Array<[string, string]>;
  supported_rails: Array<"input" | "output" | "retrieval" | "dialog" | "execution">;
  timeout_ms: number;
  failure_mode: "fail_open" | "fail_closed";
  side_effects: boolean;
  concurrent: boolean;
  network_access: boolean;
  secret_names: string[];
  provider_ready: boolean;
};

const runtimeActions: Array<{
  name: string;
  rails: ActionDefinition["supported_rails"];
  network?: boolean;
  timeoutMs?: number;
}> = [
  { name: "GuardSecretsAction", rails: ["input", "output"] },
  { name: "GuardEvaluateAction", rails: ["input", "output"], network: true, timeoutMs: 30_000 },
  { name: "GuardContentFilterAction", rails: ["input", "output"] },
  { name: "GuardTopicRulesAction", rails: ["input", "output"] },
  { name: "GuardPromptSecurityAction", rails: ["input"] },
  { name: "GuardIndirectPromptAction", rails: ["input"] },
  { name: "GuardPromptLeakageAction", rails: ["output"] },
  { name: "GuardTopicJudgeAction", rails: ["input", "output"], network: true },
  { name: "GuardGroundingAction", rails: ["output"], network: true },
  { name: "GuardReasoningAction", rails: ["output"], network: true, timeoutMs: 30_000 },
];

export function actionCatalog(): ActionDefinition[] {
  return [
    ...runtimeActions.map((item) => ({
      name: item.name,
      version: "1.0.0",
      input_schema: [["request", "ActionRequest"]] as Array<[string, string]>,
      output_schema: [["result", "ActionResult"]] as Array<[string, string]>,
      supported_rails: item.rails,
      timeout_ms: item.timeoutMs ?? 5_000,
      failure_mode: "fail_closed" as const,
      side_effects: false,
      concurrent: true,
      network_access: item.network ?? false,
      secret_names: [],
      provider_ready: true,
    })),
    {
      name: "GuardCustomerIdentifierAction",
      version: "1.0.0",
      input_schema: [["text", "string"]],
      output_schema: [["detected", "boolean"], ["redacted", "string"]],
      supported_rails: ["input", "output"],
      timeout_ms: 100,
      failure_mode: "fail_closed",
      side_effects: false,
      concurrent: true,
      network_access: false,
      secret_names: [],
      provider_ready: true,
    },
    {
      name: "GuardRecordPolicyAction",
      version: "1.0.0",
      input_schema: [["binding_id", "string"], ["safe", "boolean"], ["text", "string"], ["replacement", "string|null"]],
      output_schema: [["verdict", "string"]],
      supported_rails: ["input", "output"],
      timeout_ms: 100,
      failure_mode: "fail_closed",
      side_effects: false,
      concurrent: true,
      network_access: false,
      secret_names: [],
      provider_ready: true,
    },
  ];
}

export function registeredAction(name: string, version: string): ActionDefinition | undefined {
  return actionCatalog().find((item) => item.name === name && item.version === version);
}
