import * as controllerApi from "@/lib/controller-api";
import type {
  DeploymentRuntimeTrace,
  DeploymentTraceFinding,
} from "@/lib/api-types";

export function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function enumValue<T extends string>(value: unknown, values: readonly T[]): T | null {
  return typeof value === "string" && values.includes(value as T) ? value as T : null;
}

export function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

export function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function normalizeOutcome(decision: string): "allow" | "transform" | "block" | "error" | string {
  const value = decision.toLowerCase();
  if (["allow", "allowed", "pass", "passed"].includes(value)) return "allow";
  if (["transform", "transformed", "redact", "redacted", "rewrite", "rewritten", "intervene", "intervened"].includes(value)) return "transform";
  if (["block", "blocked", "reject", "rejected", "deny", "denied"].includes(value)) return "block";
  if (["error", "failed", "failure", "timeout", "timed_out"].includes(value)) return "error";
  return decision;
}

export function isTimedOut(event: controllerApi.RuntimeEvent): boolean {
  const decision = event.decision.toLowerCase();
  return decision === "timeout" || decision === "timed_out" || event.metadata.timedOut === true || event.metadata.timed_out === true;
}

export function runtimeFindings(event: controllerApi.RuntimeEvent): DeploymentTraceFinding[] {
  return arrayOfRecords(event.metadata.findings).map((finding, index) => {
    const verdict = stringValue(finding.verdict) ?? "unknown";
    const confidence = numberValue(finding.confidence) ?? 0;
    const risk = stringValue(finding.risk) ?? "unknown";
    return {
      id: stringValue(finding.id) ?? `${event.id}:finding:${index + 1}`,
      trace_id: event.requestId,
      created_at: event.occurredAt,
      guardrail_id: event.guardrailId,
      guardrail_version: event.guardrailVersion,
      deployment_id: event.deploymentId,
      integration_id: event.integrationId,
      phase: event.direction === "incoming" ? "input" : "output",
      severity: findingSeverity(verdict, confidence),
      risk,
      verdict,
      confidence,
      recommended_action: stringValue(finding.recommendedAction) ?? stringValue(event.metadata.action) ?? event.decision,
      policy_id: stringValue(finding.policyId),
      rule_id: stringValue(finding.ruleId),
      detail: `Runner reported a ${verdict} ${risk.replaceAll("_", " ")} finding. Raw protected content was not retained.`,
      protocol: stringValue(event.metadata.protocol),
    };
  });
}

export function runtimeTraceSteps(event: controllerApi.RuntimeEvent): DeploymentRuntimeTrace["steps"] {
  return arrayOfRecords(event.metadata.trace).map((step, index) => ({
    id: stringValue(step.id) ?? `${event.id}:step:${index + 1}`,
    trace_id: event.requestId,
    created_at: event.occurredAt,
    guardrail_id: event.guardrailId ?? "",
    guardrail_version: event.guardrailVersion ?? 0,
    deployment_id: event.deploymentId,
    integration_id: event.integrationId,
    protocol: stringValue(event.metadata.protocol) ?? "unknown",
    phase: event.direction === "incoming" ? "input" : "output",
    kind: stringValue(step.kind) ?? "action",
    name: stringValue(step.name) ?? "Runtime step",
    risk: stringValue(step.risk),
    stage: stringValue(step.stage),
    outcome: stringValue(step.outcome) ?? stringValue(step.status) ?? "unknown",
    latency_ms: numberValue(step.durationMs) ?? 0,
    timed_out: step.timedOut === true,
    runtime_engine: stringValue(step.engine) ?? "unknown",
    config_checksum: stringValue(step.configChecksum) ?? "",
    policy_id: stringValue(step.policyId),
    policy_version: stringValue(step.policyVersion),
    rail_type: stringValue(step.railType),
    flow_name: stringValue(step.flowName),
    action_name: stringValue(step.actionName),
    action_version: stringValue(step.actionVersion),
    parallel_group: stringValue(step.parallelGroup),
    timeout_ms: numberValue(step.timeoutMs),
    provider_latency_ms: numberValue(step.providerLatencyMs) ?? 0,
  }));
}

function findingSeverity(verdict: string, confidence: number): DeploymentTraceFinding["severity"] {
  if (verdict === "error") return "critical";
  if (verdict === "unsafe" && confidence >= 0.9) return "high";
  if (verdict === "unsafe" || confidence >= 0.7) return "medium";
  return "low";
}

export function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
