export type DeletionImpact = {
  resourceId: string;
  windowMinutes: number;
  incomingRequestCount: number;
  lastRequestAt: Date | null;
  activeDeploymentCount: number;
  telemetryFresh: boolean;
  telemetryWatermark: Date | null;
  requiresSecondConfirmation: boolean;
};

export type CompiledArtifactInput = {
  id: string;
  guardrailId: string;
  guardrailVersion: number;
  generation: number;
  compilerVersion: string;
  nemoVersion: string;
  runtimeProfile: string;
  plan: Record<string, unknown>;
  configYaml: string;
  colangContent: string;
  prompts: unknown[];
  actionBindings: unknown[];
  dependencyManifest: unknown[];
  checksum: string;
  signature: string;
};

export type RuntimeEventInput = {
  id: string;
  occurredAt: Date;
  requestId: string;
  runnerId: string;
  guardrailId?: string | undefined;
  guardrailVersion?: number | undefined;
  integrationId?: string | undefined;
  deploymentId?: string | undefined;
  direction: "incoming" | "outgoing";
  decision: string;
  durationMs: number;
  metadata: Record<string, unknown>;
};

export type ValidationMetrics = {
  total: number;
  passed: number;
  complianceRate: number;
  falsePositiveRate: number;
  falseNegativeRate: number;
  escalationRate: number;
  p95LatencyMs: number;
};

export type ValidationCaseResult = {
  expectationOverride?: import("./guardrail-plan.js").ValidationExpectationOverride;
  templateExpectedDecision?: string;
  assertionFailures?: string[];
  caseId: string;
  name: string;
  policyId: string;
  expectedDecision: string;
  actualDecision: string;
  passed: boolean;
  evaluatorIds: string[];
  latencyMs: number;
  reason: string;
  phase: "input" | "output";
  inputContent: string;
  action: string;
  outputContent: string;
  findings: Array<Record<string, unknown>>;
  trace: Array<Record<string, unknown>>;
  trustedInstruction: string;
  targetSource: string;
  query: string;
  groundingSources: string[];
  expectedReasoningResult: string | null;
  actualReasoningResult: string | null;
  caseType: string;
  required: boolean;
  expectedFailure: string | null;
  actualFailure: string | null;
  concurrencyGroup: string | null;
  sourcePolicyId: string | null;
  sourcePolicyVersion: string | null;
  sourceCaseId: string | null;
  coveredRuleIds: string[];
  matchedRuleIds: string[];
  evaluationContracts: string[];
  escalated: boolean;
  modelInvocations: number;
};
