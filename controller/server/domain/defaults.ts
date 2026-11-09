import type { GuardrailDraftConfig } from "./guardrail-plan.js";
import type { PolicyDto } from "../policy-catalog/catalog.js";
import { platformDefaultDraft } from "./platform-default.js";

export const DEFAULT_GUARDRAIL_ID = "guardrail-default";
export const DEFAULT_GUARDRAIL_NAME = "Default Guardrail";

/** The reserved baseline is exactly the platform Default Profile's selection. */
export function defaultGuardrailDraft(policies: readonly PolicyDto[]): GuardrailDraftConfig {
  return platformDefaultDraft(policies);
}
