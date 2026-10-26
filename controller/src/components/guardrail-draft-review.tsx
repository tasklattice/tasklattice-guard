import { TestModelRulesSwitch, ValidationScopeNotice } from "./validation-model-scope";
import { MAX_GUARDRAIL_VERSIONS } from "../../shared/guardrail-version-limit";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FlaskConical, LoaderCircle, Pencil, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EntitySheet } from "@/components/entity-sheet";
import { ErrorNotice, StateBadge } from "@/components/product-shell";
import { GuardrailValidationReadiness, useGuardrailValidationReadiness } from "@/components/guardrail-validation-readiness";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/notifications";
import { queryKeys } from "@/features/query-keys";
import { createValidationRun, getValidationRun, resumeValidationRun, publishGuardrail, type Guardrail, type GuardrailVersion, type Policy, type ValidationRun } from "@/lib/api";
import { isValidationRunning, ValidationRunProgress } from "@/components/validation-run-progress";
import { ValidationCaseResults } from "@/routes/validation";

import { draftStateKey } from "@/lib/guardrail-draft-state";
export { draftStateKey, hasUnpublishedDraft } from "@/lib/guardrail-draft-state";

/** Tests and publication stay in the same drawer, over the user's current tab. */
export function GuardrailDraftReviewSheet({ guardrail, policies, versions, policiesReady = true, policiesError = false, onRetryPolicies, initialPublish = false, initialTestModelRules = true, justSaved = false, readOnly = false, onClose, onEdit, onChanged, onPublished }: {
  guardrail: Guardrail; policies: Policy[]; versions: GuardrailVersion[];
  policiesReady?: boolean; policiesError?: boolean; onRetryPolicies?: () => void;
  initialPublish?: boolean; initialTestModelRules?: boolean; justSaved?: boolean; readOnly?: boolean;
  onClose: () => void; onEdit?: (() => void) | undefined; onChanged: () => Promise<void>;
  onPublished: (version: GuardrailVersion) => void;
}) {
  const { t } = useTranslation();
  const [testModelRules, setTestModelRules] = useState(initialTestModelRules);
  const [publishRevision, setPublishRevision] = useState<number | null>(initialPublish ? guardrail.draft_revision ?? null : null);
  const [observedRun, setObservedRun] = useState<ValidationRun | null>(null);
  const resumedRun = useRef<string | null>(null);
  const observeRun = (value: ValidationRun) => { resumedRun.current = value.id; setObservedRun(value); };
  const readiness = useGuardrailValidationReadiness({ bindings: guardrail.policy_bindings, policies, policiesReady, policiesError });
  const run = useMutation({
    mutationFn: (runId?: string) => {
      if (runId) return resumeValidationRun(runId, { onProgress: observeRun });
      if (readiness.blocked) throw new Error(readiness.reason ?? t("protection.validationReadiness.blockedTitle"));
      setObservedRun(null);
      return createValidationRun(guardrail.id, { onProgress: observeRun }, testModelRules);
    },
    onSuccess: async () => { await onChanged(); },
    onError: async () => { await onChanged(); },
  });
  useEffect(() => {
    const latest = guardrail.latest_validation_run;
    if (!readOnly && !initialPublish && latest && latest.source_draft_version === guardrail.draft_revision
      && isValidationRunning(latest) && resumedRun.current !== latest.id && !run.isPending) {
      resumedRun.current = latest.id;
      setObservedRun(latest);
      run.mutate(latest.id);
    }
  }, [guardrail.latest_validation_run, guardrail.draft_revision, readOnly, initialPublish, run.isPending, run.mutate]);
  const versionLimitReached = versions.length >= MAX_GUARDRAIL_VERSIONS;
  const publish = useMutation({
    mutationFn: () => {
      if (versionLimitReached) throw new Error(t("immutableVersions.capacityReached", { limit: MAX_GUARDRAIL_VERSIONS }));
      if (publishRevision === null || publishRevision !== guardrail.draft_revision || guardrail.published_current) {
        throw new Error(t("guardrails.draftChangedBeforePublish"));
      }
      return publishGuardrail(guardrail.id, publishRevision);
    },
    onSuccess: async version => {
      await onChanged();
      toast.success(t("guardrails.publishSucceeded", { version: version.version }));
      onPublished(version);
    },
  });
  const pending = publish.isPending;
  const reconnect = Boolean(run.error && isValidationRunning(observedRun));
  const result = run.data ?? guardrail.latest_validation_run;
  const currentSummary = result?.source_draft_version === guardrail.draft_revision ? result : null;
  const detailQuery = useQuery({ queryKey: queryKeys.validationRun(currentSummary?.id ?? ""),
    queryFn: () => getValidationRun(currentSummary!.id),
    enabled: Boolean(currentSummary && currentSummary.details_loaded === false && !isValidationRunning(currentSummary) && !run.isPending && publishRevision === null),
    staleTime: Infinity, gcTime: 0 });
  const currentResult = detailQuery.data ?? currentSummary;
  const canPublish = !readOnly && !guardrail.published_current;
  const reviewingPublish = !readOnly && publishRevision !== null;

  return <EntitySheet open width="xl" density="compact" closeDisabled={pending}
    onOpenChange={open => { if (!open && !pending) onClose(); }}
    eyebrow={guardrail.name}
    title={readOnly ? t("guardrails.draftRevisionLabel", { revision: guardrail.draft_revision ?? "—" }) : t(reviewingPublish ? "guardrails.confirmPublishTitle" : justSaved ? "guardrails.draftSaved" : "guardrails.reviewDraft")}
    description={t(readOnly ? "guardrails.draftReviewReadOnly" : reviewingPublish ? "guardrails.confirmPublishImpact" : "guardrails.savedDraftNextStep")}
    footer={readOnly ? <Button variant="outline" onClick={onClose}>{t("common.close")}</Button> : reviewingPublish ? <>
      <Button variant="outline" disabled={pending} onClick={() => { setPublishRevision(null); publish.reset(); }}>{t("common.back")}</Button>
      <Button disabled={pending || versionLimitReached || !canPublish || publishRevision !== guardrail.draft_revision} onClick={() => publish.mutate()}>{publish.isPending ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}{t(publish.isPending ? "guardrails.publishingVersion" : "guardrails.publishVersion")}</Button>
    </> : <>
      {onEdit ? <Button variant="ghost" className="mr-auto" disabled={pending} onClick={onEdit}><Pencil />{t("guardrails.continueEditing")}</Button> : null}
      <Button variant="outline" disabled={pending} onClick={onClose}>{t(currentResult ? "common.close" : "guardrails.skipTest")}</Button>
      <Button variant="testing" disabled={pending || run.isPending || (!reconnect && readiness.blocked)} onClick={() => run.mutate(reconnect ? observedRun!.id : undefined)}>{run.isPending ? <LoaderCircle className="animate-spin" /> : <FlaskConical />}{t(run.isPending ? "guardrails.runningValidation" : reconnect ? "guardrails.testProgress.reconnect" : currentResult ? "validation.runAgain" : "guardrails.testNow")}</Button>
      {canPublish ? <Button disabled={pending} onClick={() => setPublishRevision(guardrail.draft_revision ?? null)}><ShieldCheck />{t("guardrails.publishVersion")}</Button> : null}
    </>}>
    <div className="space-y-5">
      {!readOnly && !reviewingPublish ? <TestModelRulesSwitch checked={testModelRules} onChange={setTestModelRules} disabled={pending} /> : null}
      <div className="flex items-center justify-between gap-4 border-b pb-4" aria-live="polite">
        <div><p className="text-sm font-medium">{t("guardrails.draftRevisionLabel", { revision: guardrail.draft_revision ?? "—" })}</p><p className="mt-1 text-xs text-muted-foreground">{t("guardrails.policyCheckDetail", { count: guardrail.policy_bindings.length })}</p></div>
        <span className="text-sm font-medium">{t(run.isPending || reconnect ? "guardrails.draftTesting" : draftStateKey(guardrail))}</span>
      </div>
      {versionLimitReached ? <p role="status" className="text-sm text-muted-foreground">{t("immutableVersions.capacityReached", { limit: MAX_GUARDRAIL_VERSIONS })}</p> : null}
      {run.error || publish.error ? <ErrorNotice error={run.error ?? publish.error} /> : null}
      {reviewingPublish && publishRevision !== guardrail.draft_revision ? <p role="alert" className="text-sm text-destructive">{t("guardrails.draftChangedBeforePublish")}</p> : null}
      {!reviewingPublish ? <GuardrailValidationReadiness readiness={readiness} onRetry={() => { onRetryPolicies?.(); readiness.refresh(); }} /> : null}
      {run.isPending || reconnect ? <ValidationRunProgress run={observedRun} startedAt={run.submittedAt} interrupted={reconnect} /> : currentResult ? <>
        <div className="flex items-center justify-between gap-4"><div><p className="text-sm font-medium">{t("guardrails.testReportsTab")}</p><p className="mt-1 font-mono text-xs text-muted-foreground">{currentResult.id}</p></div><StateBadge state={currentResult.status} /></div>
        <ValidationScopeNotice run={currentResult} />
        <p className="text-sm">{t("guardrails.testResultSummary", { passed: currentResult.metrics.passed, total: currentResult.metrics.executed ?? currentResult.metrics.total, rate: currentResult.metrics.compliance_rate })}</p>
        {currentResult.failure_reason ? <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">{currentResult.failure_reason}</p> : null}
        {!reviewingPublish ? detailQuery.error ? <div className="space-y-3"><ErrorNotice error={detailQuery.error} /><Button variant="outline" onClick={() => void detailQuery.refetch()}>{t("common.retry")}</Button></div>
          : currentResult.details_loaded === false ? <Skeleton className="h-72" />
          : <ValidationCaseResults key={currentResult.id} results={currentResult.results} defaultFilter={currentResult.status === "passed" ? "all" : "failed"} /> : null}
      </> : <p className="text-sm text-muted-foreground">{t(result ? "guardrails.validationEvidenceStale" : "guardrails.savedDraftUntested")}</p>}
    </div>
  </EntitySheet>;
}
