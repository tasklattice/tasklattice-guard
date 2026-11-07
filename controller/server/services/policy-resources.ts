import { currentProjectId, projectOwnerForCreate, resourceReadPredicate, policyWritePredicate } from "./project-context.js";
import { ReportResults, type ReportUploadIdentity } from "./report-results.js";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql, inArray } from "drizzle-orm";
import type { PolicyTestEnvironment, PolicyVersionTestRun } from "../../shared/policy-version-test.js";
import type { PreparedPolicyVersionTest } from "../domain/policy-version-test.js";
import { canonicalJson } from "../../shared/canonical-json.js";
import { guardrailVersionId } from "../../shared/guardrail-version.js";
import { definitionIssues, policyDefinitionSchema, type PolicyDefinition, type PolicyResource, type ResourceValidation, type DefinitionTest, type PolicyTestAssessment } from "../../shared/policy-definition.js";
import type { ControllerDatabase } from "../db/client.js";
import { advisoryTransactionLock } from "../db/postgres-locks.js";
import { policyResources as resources, policyResourceVersions as versions, policyResourceValidations as runs, outboxEvents, auditEvents, policyRecords, policyImportedVersions } from "../db/schema.js";
import { ConflictError, NotFoundError, ValidationError } from "../domain/errors.js";
import { buildGuardrailPlan, normalizeGuardrailDraft } from "../domain/guardrail-plan.js";
import { frozenBuiltInDefinition, policyNodeDigest } from "../domain/policy-node.js";
import type { ValidationCaseResult } from "../domain/models.js";
import type { PolicyDto } from "../policy-catalog/catalog.js";
import { DeclarativeCompiler } from "../policy-studio/declarative.js";
import { definitionTestCases } from "../policy-studio/definition-tests.js";
import { materializePolicyRules } from "../domain/policy-rules.js";
import { limitValidationWrite } from "./validation-write-limits.js";
import { reportSaveStage, withReportSaveDiagnostics } from "../db/diagnostics.js";

/** Draft ownership, provenance and publication are independent of where a Policy was delivered. */
export class PolicyResourceService {
  readonly compiler: DeclarativeCompiler;
  constructor(private db: ControllerDatabase, directory: string, private catalog: () => PolicyDto[], private reports = new ReportResults(db)) { this.compiler = new DeclarativeCompiler(directory); }

  async get(id: string): Promise<PolicyResource> {
    const [row] = await this.db.select().from(resources).where(and(eq(resources.id, id), resourceReadPredicate("policy", resources.id, resources.projectId)));
    const [published] = await this.db.select().from(versions).where(eq(versions.policyId, id)).orderBy(desc(versions.createdAt)).limit(1);
    if (row) return { ...row, published_version: published?.version ?? this.catalog().find(p => p.id === id)?.version ?? null, validation: await this.report(id) };
    const [imported] = await this.db.select().from(policyImportedVersions).where(and(eq(policyImportedVersions.policyId, id), resourceReadPredicate("policy", policyImportedVersions.policyId, policyImportedVersions.projectId))).orderBy(desc(policyImportedVersions.importedAt)).limit(1);
    const definition = this.compiler.shipped(id) ?? (imported ? this.compiler.fromSnapshot(imported.definition) : null);
    if (!definition) throw new NotFoundError("Policy definition", id);
    return { id, definition, revision: 0, maintainer: "Platform administrators", published_version: imported?.version ?? definition.metadata.version };
  }

  async save(input: { definition: PolicyDefinition; maintainer: string; expectedRevision: number; actorId: string; create?: boolean | undefined }): Promise<PolicyResource> {
    const definition = policyDefinitionSchema.parse(input.definition);
    const id = definition.metadata.id;
    // Drafts may be incomplete; detector references/parameter fields must still be executable contracts.
    this.compiler.compile(definition);
    await this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, `policy-resource:${id}`);
      const [current] = await tx.select().from(resources).where(eq(resources.id, id)).for("update");
      if (currentProjectId() && current && current.projectId !== currentProjectId()) throw new NotFoundError("Policy draft", id);
      const [legacy] = await tx.select({ id: policyRecords.id, projectId: policyRecords.projectId }).from(policyRecords).where(eq(policyRecords.id, id));
      if (currentProjectId() && legacy && legacy.projectId !== currentProjectId()) throw new NotFoundError("Policy draft", id);
      const importedVersions = await tx.select({ id: policyImportedVersions.policyId, projectId: policyImportedVersions.projectId }).from(policyImportedVersions).where(eq(policyImportedVersions.policyId, id));
      if (currentProjectId() && importedVersions.some(imported => imported.projectId !== currentProjectId())) throw new NotFoundError("Policy draft", id);
      const imported = importedVersions[0];
      if (legacy) throw new ConflictError("This ID belongs to a programmable Policy.", "policy_identity_conflict");
      if (input.create && (current || imported || this.catalog().some(p => p.id === id))) throw new ConflictError("Policy ID already exists.", "policy_identity_conflict");
      if ((current?.revision ?? 0) !== input.expectedRevision) throw new ConflictError("Policy changed. Reopen its current draft before saving.", "policy_draft_conflict");
      if (current && canonicalJson(current.definition) === canonicalJson(definition) && current.maintainer === input.maintainer) return;
      const revision = (current?.revision ?? 0) + 1;
      if (current) await tx.update(resources).set({ definition, maintainer: input.maintainer, revision, updatedAt: new Date() }).where(eq(resources.id, id));
      else await tx.insert(resources).values({ id, projectId: projectOwnerForCreate(), definition, maintainer: input.maintainer, revision });
      await tx.insert(auditEvents).values({ id: randomUUID(), kind: "policy.updated", actorId: input.actorId, resourceType: "policy", resourceId: id, detail: { revision } });
    });
    return this.get(id);
  }

  async views(base: PolicyDto[], db: Pick<ControllerDatabase, "select"> = this.db, id?: string): Promise<PolicyDto[]> {
    const rows = await db.select().from(resources).where(and(id ? eq(resources.id, id) : undefined, resourceReadPredicate("policy", resources.id, resources.projectId)));
    const published = await db.select().from(versions).where(id ? eq(versions.policyId, id) : undefined).orderBy(desc(versions.createdAt));
    const result = new Map(base.map(policy => {
      // Plan bundled declarative model Policies from their authored definitions.
      // Retain their definition so planning and dependency discovery use the
      // authored detector, including runtime parameters such as on_unknown.
      return [policy.id, this.compiler.catalogView(policy)];
    }));
    for (const row of rows) {
      const history = published.filter(v => v.policyId === row.id).map(v => v.view);
      const existing = result.get(row.id);
      const head = history[0] ?? existing ?? this.compiler.compile({ ...row.definition, metadata: { ...row.definition.metadata, version: "0" } });
      result.set(row.id, { ...head, project_id: row.projectId, maintenance: { revision: row.revision, maintainer: row.maintainer }, published_versions: [...history.slice(1), ...(history.length && existing ? [existing] : []), ...existing?.published_versions ?? []] });
    }
    return [...result.values()];
  }

  async validate(id: string, actorId: string, compilerAvailable: boolean): Promise<ResourceValidation> {
    if (!compilerAvailable) throw new ConflictError("A healthy compiler Runner in the project runtime group is required to run Policy tests.", "default_runner_unavailable");
    const runId = `policy-report-${randomUUID()}`;
    await this.db.transaction(async tx => {
      const [row] = await tx.select().from(resources).where(and(eq(resources.id, id), policyWritePredicate(resources.id, resources.projectId))).for("update");
      if (!row) throw new NotFoundError("Policy draft", id);
      const issues = definitionIssues(row.definition);
      if (issues.length) throw new ValidationError(issues.join("\n"), { issues });
      const compiled = this.compiler.compile({ ...row.definition, metadata: { ...row.definition.metadata, version: `draft-${row.revision}` } });
      const parameterValues = { ...Object.fromEntries(row.definition.parameters.flatMap(p => p.default == null ? [] : [[p.name, p.default]])), ...row.definition.testing?.parameters };
      const expansion = normalizeGuardrailDraft({ policyBindings: [{ policyId: id, policyVersion: compiled.version, enabledRuleIds: compiled.rules.map(r => r.id), parameterValues }] }).policyBindings[0]!;
      const policy = materializePolicyRules(compiled, expansion);
      const cases = definitionTestCases(row.definition, parameterValues);
      await tx.insert(runs).values({ id: runId, policyId: id, revision: row.revision, status: "queued", tests: cases });
      const groups = new Map<string | null, DefinitionTest[]>();
      for (const test of cases) {
        const key = test.scope === "rule" ? test.covered_rule_ids[0]! : null;
        groups.set(key, [...groups.get(key) ?? [], test]);
      }
      for (const [ruleId, tests] of groups) {
        const jobId = `policy-job-${randomUUID()}`;
        const candidateVersion = guardrailVersionId();
        const draft = normalizeGuardrailDraft({ safetyLevel: policy.safety_level, outputDelivery: policy.output_delivery, policyBindings: [{
          policyId: id, policyVersion: policy.version, action: null, parameterValues,
          enabledRuleIds: ruleId === null ? policy.rules.map(r => r.id) : [ruleId], enabledRails: policy.rails, ruleActions: {}, reasoningPolicy: null,
        }] });
        const plan = buildGuardrailPlan({ guardrailId: `policy-preview-${id}`, guardrailVersion: candidateVersion, draft, policies: [policy] });
        await tx.insert(runs).values({ id: jobId, policyId: id, parentId: runId, revision: row.revision, status: "queued", tests });
        await tx.insert(outboxEvents).values({ id: jobId, kind: "policy.validation_requested", aggregateId: id, payload: {
          runId: jobId, guardrailId: `policy-preview-${id}`, candidateVersion, sourceDraftRevision: row.revision, plan,
          runtimeProfile: "auto",
          testCases: tests.map(test => ({ id: test.id, name: test.name, policyId: id, phase: test.phase, content: test.content, expectedDecision: test.expected_decision,
            trustedInstruction: test.context?.trusted_instruction ?? "", targetSource: test.phase === "input" ? "user_input" : "model_output", query: test.context?.query ?? "", groundingSources: test.context?.grounding_sources ?? [], expectedReasoningResult: test.context?.expected_reasoning_result ?? null, caseType: "scenario", required: test.required,
            expectedFailure: null, concurrencyGroup: null, sourcePolicyId: id, sourcePolicyVersion: policy.version, sourceCaseId: test.id,
            coveredRuleIds: test.kind === "rule_acceptance" && test.expected_decision === "allow" ? [] : test.covered_rule_ids })),
        } });
      }
      await tx.insert(auditEvents).values({ id: randomUUID(), kind: "policy.validation_requested", actorId, resourceType: "policy", resourceId: id, detail: { runId, revision: row.revision } });
    });
    return (await this.report(id, runId))!;
  }

  async report(id: string, runId?: string): Promise<ResourceValidation | null> {
    if (currentProjectId()) {
      const [row] = await this.db.select({ id: resources.id }).from(resources).where(and(eq(resources.id, id), resourceReadPredicate("policy", resources.id, resources.projectId)));
      if (!row) throw new NotFoundError("Policy draft", id);
    }
    // Recheck read/share scope in the statement that reads the child as well:
    // a grant may have been revoked after the existence check above.
    const [run] = await this.db.select({ id: runs.id, policyId: runs.policyId, revision: runs.revision, status: runs.status, failureReason: runs.failureReason,
      total: sql<number>`jsonb_array_length(${runs.tests})`, passed: sql<number>`(SELECT count(*)::int FROM validation_report_case WHERE run_id="policy_resource_validation"."id" AND status='passed')`,
    }).from(runs).innerJoin(resources, eq(resources.id, runs.policyId)).where(and(resourceReadPredicate("policy", resources.id, resources.projectId), eq(runs.policyId, id), isNull(runs.version), isNull(runs.parentId), ...(runId ? [eq(runs.id, runId)] : []))).orderBy(desc(runs.createdAt)).limit(1);
    return run ?? null;
  }

  async validateVersion(prepared: PreparedPolicyVersionTest, environment: PolicyTestEnvironment, actorId: string): Promise<PolicyVersionTestRun> {
    const projectId = projectOwnerForCreate();
    const runId = `policy-report-${randomUUID()}`;
    const snapshot = { policyId: prepared.policyId, policyName: prepared.policyName, version: prepared.version,
      policyDigest: prepared.policyDigest, testSuiteDigest: prepared.testSuiteDigest, parameters: prepared.parameters, environment };
    await this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, `policy-version-test:${projectId}:${prepared.policyId}:${prepared.version}`);
      const [running] = await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.projectId, projectId), eq(runs.policyId, prepared.policyId), eq(runs.version, prepared.version), isNull(runs.parentId), inArray(runs.status, ["queued", "running"])));
      if (running) throw new ConflictError("This Policy version is already being tested.", "policy_test_running", { runId: running.id });
      const identity = { policyId: prepared.policyId, projectId, version: prepared.version, revision: 0, status: "queued" };
      await tx.insert(runs).values({ ...identity, id: runId, tests: prepared.tests, snapshot });
      for (const job of prepared.jobs) {
        const jobId = `policy-job-${randomUUID()}`;
        const candidateVersion = guardrailVersionId();
        await tx.insert(runs).values({ ...identity, id: jobId, parentId: runId, tests: job.tests });
        await tx.insert(outboxEvents).values({ id: jobId, kind: "policy.validation_requested", aggregateId: jobId,
          payload: { runId: jobId, guardrailId: job.plan.guardrail_id, candidateVersion, sourceDraftRevision: 0,
            plan: { ...job.plan, guardrail_version: candidateVersion }, runtimeProfile: "auto", testCases: job.testCases,
            testModelRules: true, testPoolId: environment.poolId, testModelRevisionId: environment.modelRevisionId } });
      }
      await tx.insert(auditEvents).values({ id: randomUUID(), actorId, kind: "policy.version_test_requested", resourceType: "policy", resourceId: prepared.policyId,
        detail: { runId, version: prepared.version, policyDigest: prepared.policyDigest, testSuiteDigest: prepared.testSuiteDigest } });
    });
    return (await this.versionReport(prepared.policyId, prepared.version, runId))!;
  }

  async versionReport(policyId: string, version: string, runId?: string): Promise<PolicyVersionTestRun | null> {
    const projectId = projectOwnerForCreate();
    const [run] = await this.db.select().from(runs).where(and(eq(runs.projectId, projectId), eq(runs.policyId, policyId), eq(runs.version, version), isNull(runs.parentId), runId ? eq(runs.id, runId) : undefined)).orderBy(desc(runs.createdAt)).limit(1);
    if (!run?.snapshot) return null;
    const { rows: [counts] } = await this.db.execute<{ passed: number; completed: number }>(sql`
      SELECT coalesce(sum((SELECT count(*) FROM validation_report_case c WHERE c.run_id=child.id AND c.status='passed')),0)::int passed,
        coalesce(sum(CASE WHEN child.status IN ('passed','failed') THEN jsonb_array_length(child.tests) ELSE 0 END),0)::int completed
      FROM policy_resource_validation child WHERE child.parent_id=${run.id}`);
    return { id: run.id, policyId, version, status: run.status, total: run.tests.length, passed: counts?.passed ?? 0,
      completed: counts?.completed ?? 0, failureReason: run.failureReason, snapshot: run.snapshot, createdAt: run.createdAt.toISOString() };
  }
  async running(id: string): Promise<boolean> {
    const [job] = await this.db.update(runs).set({ status: "running" }).where(and(eq(runs.id, id), eq(runs.status, "queued"))).returning({parentId:runs.parentId});
    if (job?.parentId) await this.db.update(runs).set({ status: "running" }).where(and(eq(runs.id, job.parentId), eq(runs.status, "queued")));
    return Boolean(job);
  }
  async complete(input: { runId: string; upload?: ReportUploadIdentity; status: string; reason?: string | undefined; executionFailed?: boolean; runtime?: import("../domain/models.js").ValidationRuntimeFingerprint | undefined }): Promise<boolean> {
    return withReportSaveDiagnostics(this.db, input.runId, () => this.persistResult(input));
  }
  private async persistResult(input: Parameters<PolicyResourceService["complete"]>[0]): Promise<boolean> {
    const [job] = await reportSaveStage("lookup_policy_run", () => this.db.select().from(runs).where(eq(runs.id, input.runId)));
    if (!job?.parentId) return false;
    if (!["queued", "running"].includes(job.status)) return true;
    let requiredFailed = false;
    if (!input.executionFailed || job.version) await reportSaveStage("assess_policy_cases", () => this.reports.assess(job.id, job.tests, (test, actual) => {
      const result = assertPolicyTest(test, actual, input.executionFailed ? input.reason ?? "Policy test execution failed." : undefined);
      if ((test.required || job.version) && !result.passed) requiredFailed = true;
      return { ...result, phase: test.phase, caseType: test.kind, required: Boolean(job.version) || test.required, expectedDecision: test.expected_decision,
        ...(job.version ? { testDefinition: test, ...(input.runtime ? { runtime: input.runtime } : {}) } : {}),
        inputContent: test.content, sourcePolicyId: job.policyId, sourcePolicyVersion: job.version ?? `draft-${job.revision}`, sourceCaseId: test.id,
        ...(!actual ? { actualFailure: "configuration_failure", executionStatus: "error", trace: [], latencyMs: 0 } : {}),
        coveredRuleIds: test.covered_rule_ids,
        ruleContractSatisfied: test.kind !== "rule_acceptance" || (test.expected_decision === "allow" ? actual?.ruleContractSatisfied === true : test.covered_rule_ids.every(id => result.matchedRuleIds.includes(id))) };
    }, input.upload));
    await this.db.transaction(async tx => {
      await reportSaveStage("set_timeouts", () => limitValidationWrite(tx));
      const [parent] = await reportSaveStage("lock_parent_run", () => tx.select({id:runs.id,status:runs.status}).from(runs).where(eq(runs.id, job.parentId!)).for("update"));
      if (!parent || ["passed", "failed"].includes(parent.status)) return;
      const [current] = await reportSaveStage("lookup_run", () => tx.select({id:runs.id,status:runs.status}).from(runs).where(eq(runs.id, job.id)));
      if (!current || ["passed", "failed"].includes(current.status)) return;
      await this.reports.assertUpload(tx, job.id, input.upload);
      const status = input.status === "passed" && !requiredFailed && !input.executionFailed ? "passed" : "failed";
      await reportSaveStage("write_report", () => tx.update(runs).set({ status, failureReason: input.reason ?? null }).where(eq(runs.id, current.id)));
      await reportSaveStage("complete_outbox", () => tx.update(outboxEvents).set({ processedAt: new Date() }).where(eq(outboxEvents.id, current.id)));
      await reportSaveStage("aggregate_policy_results", async () => {
        const children = await tx.select({ status: runs.status, failureReason: runs.failureReason }).from(runs).where(eq(runs.parentId, parent.id));
        if (children.every(r => ["passed", "failed"].includes(r.status))) {
          await this.reports.linkPolicyParent(tx, parent.id);
          const success = children.every(r => r.status === "passed");
          await tx.update(runs).set({ status: success ? "passed" : "failed", failureReason: children.find(r => r.failureReason)?.failureReason ?? null }).where(eq(runs.id, parent.id));
          await reportSaveStage("write_audit", () => tx.insert(auditEvents).values({ id: randomUUID(), kind: "policy.validation_completed", resourceType: "policy", resourceId: job.policyId, detail: { runId: parent.id, status: success ? "passed" : "failed" } }));
        }
      });
    });
    return true;
  }

  async publish(id: string, expectedRevision: number, actorId: string) {
    return this.db.transaction(async tx => {
      const [row] = await tx.select().from(resources).where(and(eq(resources.id, id), policyWritePredicate(resources.id, resources.projectId))).for("update");
      if (!row) throw new NotFoundError("Policy draft", id);
      const [existing] = await tx.select().from(versions).where(and(eq(versions.policyId, id), eq(versions.revision, expectedRevision)));
      if (existing) return existing.view;
      if (row.revision !== expectedRevision) throw new ConflictError("The draft changed. Test it again before publishing.", "policy_draft_conflict");
      const [report] = await tx.select().from(runs).where(and(eq(runs.policyId, id), isNull(runs.version), isNull(runs.parentId))).orderBy(desc(runs.createdAt)).limit(1);
      if (report?.revision !== row.revision || report.status !== "passed") throw new ConflictError("The current draft must pass every required test before publication.", "policy_validation_required");
      const issues = definitionIssues(row.definition);
      if (issues.length) throw new ValidationError(issues.join("\n"));
      const version = `r${row.revision}-${randomUUID().slice(0, 8)}`;
      const definition = { ...row.definition, metadata: { ...row.definition.metadata, version } };
      const view = this.compiler.compile(definition);
      const digest = policyNodeDigest(frozenBuiltInDefinition(view));
      await tx.insert(versions).values({ policyId: id, revision: row.revision, definition, view, version, digest });
      await tx.insert(auditEvents).values({ id: randomUUID(), kind: "policy.version_published", actorId, resourceType: "policy", resourceId: id, detail: { version, revision: row.revision, digest } });
      return view;
    });
  }
}

export function assertPolicyTest(test: DefinitionTest, actual?: ValidationCaseResult, failure?: string): PolicyTestAssessment {
  const reasons: string[] = [];
  if (!actual) reasons.push("Runner did not return this test.");
  if (failure) reasons.push(failure);
  if (actual && (actual.actualFailure ?? null) !== (actual.expectedFailure ?? null)) reasons.push(actual.reason || "Runtime evaluation failed.");
  if (actual && (test.expected_decision === "intervene" ? actual.actualDecision === "allow" : actual.actualDecision !== test.expected_decision)) reasons.push(`Expected ${test.expected_decision}, received ${actual.actualDecision}.`);
  const matches = [...new Set((actual?.findings ?? []).filter(f => f.verdict === "matched" && f.policy_id === actual?.sourcePolicyId).map(f => String(f.rule_id)))];
  if (test.kind === "rule_acceptance" && test.expected_decision !== "allow" && test.covered_rule_ids.some(id => !matches.includes(id))) reasons.push("The target Rule did not match.");
  if (test.expected_matched_rules && canonicalJson([...test.expected_matched_rules].sort()) !== canonicalJson([...matches].sort())) reasons.push("Matched Rules differ from the expectation.");
  if (test.expected_text != null && actual?.outputContent !== test.expected_text) reasons.push("Output text differs from the expectation.");
  if (test.context?.expected_reasoning_result && actual?.actualReasoningResult !== test.context.expected_reasoning_result) reasons.push(`Expected proof ${test.context.expected_reasoning_result}, received ${actual?.actualReasoningResult ?? "none"}.`);
  if (actual && !actual.passed && !reasons.length) reasons.push(actual.reason || "Runtime evaluation failed.");
  return { caseId: test.id, name: test.name, passed: reasons.length === 0, reason: reasons.join(" ") || "Passed", actualDecision: actual?.actualDecision ?? "unknown", outputContent: actual?.outputContent ?? "", matchedRuleIds: matches, modelInvocations: actual?.modelInvocations ?? 0, actualReasoningResult: actual?.actualReasoningResult ?? null, findings: actual?.findings ?? [] };
}
