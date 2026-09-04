import { randomUUID } from "node:crypto";

import { z } from "zod";

import { ControllerError, ValidationError } from "../domain/errors.js";
import { providerFetch } from "../model-config/provider-fetch.js";
import { isGuardrailVersionId } from "../../shared/guardrail-version.js";

type Fetch = typeof globalThis.fetch;
const guardrailVersion = z.string().refine(isGuardrailVersionId);

const modelEnvelope = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});

const traceStep = z.object({
  id: z.string(),
  kind: z.string().optional(),
  name: z.string(),
  status: z.string(),
  detail: z.string(),
  duration_ms: z.number().default(0),
  parent_id: z.string().nullable().optional(),
  contract_ref: z.string().nullable().optional(),
  verdict: z.string().nullable().optional(),
  route: z.string().nullable().optional(),
  capability: z.string().nullable().optional(),
  confidence: z.number().nullable().optional(),
  policy_id: z.string().nullable().optional(),
  policy_version: z.string().nullable().optional(),
  rail_type: z.string().nullable().optional(),
  flow_name: z.string().nullable().optional(),
  action_name: z.string().nullable().optional(),
  action_version: z.string().nullable().optional(),
  outcome: z.string().nullable().optional(),
  engine: z.string().nullable().optional(),
}).passthrough();

const runnerDecision = z.object({
  decision: z.enum(["allow", "transform", "block"]),
  action: z.string(),
  reason: z.string().nullable().optional(),
  texts: z.array(z.string()).default([]),
  guardrail_id: z.string().nullable().optional(),
  guardrail_version: guardrailVersion.nullable().optional(),
  findings: z.array(z.object({
    risk: z.string(),
    taxonomy_id: z.string(),
    verdict: z.string(),
    confidence: z.number().nullable(),
    evidence: z.string(),
    recommended_action: z.string(),
    policy_id: z.string().nullable().optional(),
    rule_id: z.string().nullable().optional(),
  }).passthrough()).default([]),
  trace: z.array(traceStep).default([]),
  usage: z.object({
    runtime_engine: z.string().default(""),
    runtime_profile: z.string().default(""),
  }).passthrough().nullable().optional(),
}).passthrough();

export type PlaygroundModel = {
  id: string;
  provider: string;
  name: string;
  icon: string;
};

export type PublishedPlaygroundTarget = {
  kind: "published";
  version: string;
};

export type DraftPlaygroundTarget = {
  kind: "draft";
  previewId: string;
  draftRevision: number;
  candidateVersion: string;
  plan: Record<string, unknown>;
  runtimeProfile: string;
};

export type PlaygroundTarget = PublishedPlaygroundTarget | DraftPlaygroundTarget;

export type PlaygroundDraftPreview = DraftPlaygroundTarget & {
  actorId: string;
  guardrailId: string;
  guardrailName: string;
  compilerVersion: string;
  expiresAt: Date;
};

export class PlaygroundDraftPreviewStore {
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #items = new Map<string, PlaygroundDraftPreview>();

  constructor(ttlMs = 15 * 60 * 1_000, maxEntries = 128) {
    this.#ttlMs = ttlMs;
    this.#maxEntries = Math.max(1, maxEntries);
  }

  create(input: Omit<PlaygroundDraftPreview, "kind" | "previewId" | "expiresAt">): PlaygroundDraftPreview {
    this.#prune();
    const preview: PlaygroundDraftPreview = {
      ...input,
      kind: "draft",
      previewId: randomUUID(),
      expiresAt: new Date(Date.now() + this.#ttlMs),
    };
    this.#items.set(preview.previewId, preview);
    while (this.#items.size > this.#maxEntries) {
      const oldest = [...this.#items.values()].sort((left, right) => left.expiresAt.getTime() - right.expiresAt.getTime())[0];
      if (oldest) this.#items.delete(oldest.previewId);
    }
    return preview;
  }

  get(previewId: string, actorId: string): PlaygroundDraftPreview {
    this.#prune();
    const preview = this.#items.get(previewId);
    if (!preview || preview.actorId !== actorId) {
      throw new ControllerError("Draft preview expired. Prepare it again before testing.", 409, "playground_draft_preview_expired");
    }
    return preview;
  }

  delete(previewId: string): void {
    this.#items.delete(previewId);
  }

  #prune(): void {
    const now = Date.now();
    for (const [id, item] of this.#items) {
      if (item.expiresAt.getTime() <= now) this.#items.delete(id);
    }
  }
}

export class OpenAICompatiblePlaygroundModel {
  readonly descriptor: PlaygroundModel;
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #fetch: Fetch;

  constructor(input: {
    provider: string;
    baseUrl: string;
    model: string;
    apiKey: string;
    skipTlsVerify?: boolean;
    timeoutMs?: number;
    fetcher?: Fetch;
  }) {
    this.descriptor = {
      id: input.model,
      provider: input.provider,
      name: input.model,
      icon: input.provider.toLocaleLowerCase("en-US"),
    };
    this.#baseUrl = input.baseUrl.replace(/\/+$/, "");
    this.#apiKey = input.apiKey;
    this.#timeoutMs = input.timeoutMs ?? 45_000;
    this.#fetch = providerFetch(input.skipTlsVerify, input.fetcher);
  }

  async complete(input: {
    modelId: string;
    message: string;
    history: Array<{ role: "user" | "assistant"; content: string }>;
  }): Promise<{ content: string; latencyMs: number }> {
    if (input.modelId !== this.descriptor.id) throw new ValidationError(`Unknown Playground model ${input.modelId}.`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    const started = performance.now();
    try {
      const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.descriptor.id,
          messages: [
            { role: "system", content: "You are the model under evaluation in TaskLattice Guard Playground. Answer the user directly." },
            ...input.history,
            { role: "user", content: input.message },
          ],
          temperature: 0,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new ControllerError("The Playground model request failed.", 502, "playground_model_failed");
      const parsed = modelEnvelope.parse(await response.json());
      return { content: parsed.choices[0]!.message.content, latencyMs: Math.max(0, Math.round(performance.now() - started)) };
    } catch (error) {
      if (error instanceof ControllerError || error instanceof ValidationError) throw error;
      throw new ControllerError("The Playground model request failed.", 502, "playground_model_failed");
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class RunnerPlaygroundClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: Fetch;

  constructor(input: { baseUrl: string; token: string; fetcher?: Fetch }) {
    this.#baseUrl = input.baseUrl.replace(/\/+$/, "");
    this.#token = input.token;
    this.#fetch = input.fetcher ?? globalThis.fetch;
  }

  async evaluate(input: {
    guardrailId: string;
    target: PlaygroundTarget;
    phase: "input" | "output";
    text: string;
    callId: string;
    history: Array<{ role: "user" | "assistant"; content: string }>;
  }) {
    const started = performance.now();
    const draft = input.target.kind === "draft" ? input.target : null;
    const response = await this.#fetch(
      draft
        ? `${this.#baseUrl}/internal/v1/playground/draft-previews/${encodeURIComponent(draft.previewId)}/evaluate`
        : `${this.#baseUrl}/internal/v1/guardrails/${encodeURIComponent(input.guardrailId)}/evaluate`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
        body: JSON.stringify({
          phase: input.phase,
          texts: [input.text],
          ...(input.target.kind === "draft" ? {
            preview_id: input.target.previewId,
            draft_revision: input.target.draftRevision,
            candidate_version: input.target.candidateVersion,
            plan: input.target.plan,
            runtime_profile: input.target.runtimeProfile,
          } : { guardrail_version: input.target.version }),
          call_id: input.callId,
          protocol: "playground",
          messages: input.history,
          attributes: {
            "target.environment": "playground",
            "playground.target_kind": input.target.kind,
          },
          mode: "enforce",
        }),
      },
    );
    if (!response.ok) {
      throw new ControllerError(
        response.status === 404
          ? (draft ? "The prepared Guardrail draft preview expired." : "The selected Guardrail Version has not reached GuardRails 0 yet.")
          : "GuardRails 0 could not evaluate the Playground request.",
        response.status === 404 ? 409 : 502,
        response.status === 404 ? "playground_artifact_not_ready" : "playground_runner_failed",
      );
    }
    return {
      decision: runnerDecision.parse(await response.json()),
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
    };
  }

  async prepareDraft(input: {
    previewId: string;
    guardrailId: string;
    draftRevision: number;
    candidateVersion: string;
    plan: Record<string, unknown>;
    runtimeProfile: string;
  }) {
    const response = await this.#fetch(
      `${this.#baseUrl}/internal/v1/playground/draft-previews/${encodeURIComponent(input.previewId)}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
        body: JSON.stringify({
          preview_id: input.previewId,
          guardrail_id: input.guardrailId,
          draft_revision: input.draftRevision,
          candidate_version: input.candidateVersion,
          plan: input.plan,
          runtime_profile: input.runtimeProfile,
        }),
      },
    );
    if (!response.ok) {
      throw new ControllerError(
        "GuardRails 0 could not prepare the draft preview.",
        response.status === 409 ? 409 : 502,
        response.status === 409 ? "playground_draft_preview_stale" : "playground_draft_preview_failed",
      );
    }
    return z.object({
      draft_revision: z.number().int().positive(),
      compiler_version: z.string(),
      runtime_profile: z.string(),
      ttl_seconds: z.number().int().positive(),
    }).parse(await response.json());
  }
}

export async function runPlaygroundInteraction(input: {
  guardrail: {
    id: string;
    name: string;
    version: string;
    publishedAt: Date | string | null;
    compilerVersion: string;
    targetKind: "published" | "draft";
    draftRevision: number | null;
  };
  target: PlaygroundTarget;
  model: OpenAICompatiblePlaygroundModel;
  runner: RunnerPlaygroundClient;
  modelId: string;
  message: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
}) {
  const interactionId = randomUUID();
  const callId = `playground:${interactionId}`;
  const inputResult = await input.runner.evaluate({
    guardrailId: input.guardrail.id,
    target: input.target,
    phase: "input",
    text: input.message,
    callId,
    history: input.history,
  });
  const effectiveMessage = transformedText(inputResult.decision, input.message);
  const inputCheck = checkResult(input.guardrail, "input", effectiveMessage, inputResult);
  if (inputResult.decision.decision === "block") {
    return {
      interaction_id: interactionId,
      state: "input_blocked" as const,
      user_message: input.message,
      effective_user_message: null,
      assistant_message: null,
      model: { ...input.model.descriptor, latency_ms: null },
      input_check: inputCheck,
      output_check: null,
    };
  }

  const completion = await input.model.complete({
    modelId: input.modelId,
    message: effectiveMessage,
    history: input.history,
  });
  const outputResult = await input.runner.evaluate({
    guardrailId: input.guardrail.id,
    target: input.target,
    phase: "output",
    text: completion.content,
    callId,
    history: [...input.history, { role: "user", content: effectiveMessage }],
  });
  const assistantMessage = transformedText(outputResult.decision, completion.content);
  return {
    interaction_id: interactionId,
    state: outputResult.decision.decision === "block" ? "output_blocked" as const : "completed" as const,
    user_message: input.message,
    effective_user_message: effectiveMessage,
    assistant_message: outputResult.decision.decision === "block" ? null : assistantMessage,
    model: { ...input.model.descriptor, latency_ms: completion.latencyMs },
    input_check: inputCheck,
    output_check: checkResult(input.guardrail, "output", assistantMessage, outputResult),
  };
}

function transformedText(decision: z.infer<typeof runnerDecision>, fallback: string): string {
  return decision.decision === "transform" && decision.texts[0] ? decision.texts[0] : fallback;
}

function checkResult(
  guardrail: { id: string; name: string; version: string; publishedAt: Date | string | null; compilerVersion: string; targetKind: "published" | "draft"; draftRevision: number | null },
  phase: "input" | "output",
  outputContent: string,
  result: { decision: z.infer<typeof runnerDecision>; latencyMs: number },
) {
  const matchedPolicies = new Set(result.decision.findings.map((item) => item.policy_id).filter((item): item is string => Boolean(item)));
  const policySteps = new Map<string, z.infer<typeof traceStep>>();
  for (const step of result.decision.trace) if (step.policy_id && !policySteps.has(step.policy_id)) policySteps.set(step.policy_id, step);
  const policies = [...new Set([...policySteps.keys(), ...matchedPolicies])].map((policyId) => {
    const step = policySteps.get(policyId);
    return {
      id: policyId,
      name: policyId,
      risk: step?.capability ?? "policy",
      status: (matchedPolicies.has(policyId) ? "matched" : step?.status === "error" ? "error" : "not_matched") as "matched" | "error" | "not_matched",
      duration_ms: step?.duration_ms ?? 0,
    };
  });
  const firstFinding = result.decision.findings[0];
  return {
    check_id: randomUUID(),
    trace_id: randomUUID(),
    evidence_id: null,
    guardrail: {
      id: guardrail.id,
      name: guardrail.name,
      version: guardrail.version,
      target_kind: guardrail.targetKind,
      draft_revision: guardrail.draftRevision,
      published_at: guardrail.publishedAt ? new Date(guardrail.publishedAt).toISOString() : null,
      compiler_version: guardrail.compilerVersion,
    },
    phase,
    decision: result.decision.decision,
    action: result.decision.action,
    output_content: outputContent,
    latency_ms: result.latencyMs,
    reason: result.decision.reason ?? "",
    runtime: result.decision.usage?.runtime_engine || "NeMo Guardrails",
    triggered_policy: firstFinding?.policy_id ? { id: firstFinding.policy_id, name: firstFinding.policy_id } : null,
    triggered_rule: firstFinding?.rule_id ? { id: firstFinding.rule_id, name: firstFinding.rule_id } : null,
    policies,
    findings: result.decision.findings.map((finding, index) => ({
      id: `finding-${index + 1}`,
      severity: (finding.verdict === "unsafe" ? "high" : finding.verdict === "uncertain" ? "medium" : "low") as "high" | "medium" | "low",
      title: finding.taxonomy_id,
      taxonomy_id: finding.taxonomy_id,
      detail: finding.evidence,
      confidence: finding.confidence,
      recommended_action: finding.recommended_action,
      policy_id: finding.policy_id ?? null,
      rule_id: finding.rule_id ?? null,
    })),
    trace_summary: {
      steps: result.decision.trace.length,
      matched_steps: result.decision.trace.filter((step) => step.verdict === "unsafe" || step.outcome === "unsafe").length,
    },
    trace: result.decision.trace,
  };
}
