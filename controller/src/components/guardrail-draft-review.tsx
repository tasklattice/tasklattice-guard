import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { FlaskConical, LoaderCircle, Pencil, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EntitySheet } from "@/components/entity-sheet";
import { ErrorNotice, StateBadge } from "@/components/product-shell";
import { GuardrailValidationReadiness, useGuardrailValidationReadiness } from "@/components/guardrail-validation-readiness";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/notifications";
import { createValidationRun, resumeValidationRun, publishGuardrail, type Guardrail, type GuardrailVersion, type Policy, type ValidationRun } from "@/lib/api";
import { isValidationRunning, ValidationRunProgress } from "@/components/validation-run-progress";
import { ValidationCaseResults } from "@/routes/validation";

export function draftStateKey(guardrail: Guardrail) {
  if (!hasUnpublishedDraft(guardrail)) return "guardrails.releasePublished";
  if (guardrail.published_current) return "guardrails.releasePublished";
  if (guardrail.tested_current) return "guardrails.draftTested";
  if (guardrail.latest_validation_run && guardrail.latest_validation_run.source_draft_version === guardrail.draft_revision) {
    if (isValidationRunning(guardrail.latest_validation_run)) return "guardrails.draftTesting";
    if (guardrail.latest_validation_run.status === "failed") return "guardrails.draftTestFailed";
  }
  return "guardrails.draftUntested";
}

export function hasUnpublishedDraft(guardrail: Guardrail) {
  return guardrail.has_unpublished_changes ?? !guardrail.published_current;
}

/** Tests and publication stay in the same drawer, over the user's current tab. */
export function GuardrailDraftReviewSheet({ guardrail, policies, versions, policiesReady = true, policiesError = false, onRetryPolicies, initialPublish = false, justSaved = false, readOnly = false, onClose, onEdit, onChanged, onPublished }: {
  guardrail: Guardrail; policies: Policy[]; versions: GuardrailVersion[];
  policiesReady?: boolean; policiesError?: boolean; onRetryPolicies?: () => void;
  initialPublish?: boolean; justSaved?: boolean; readOnly?: boolean;
  onClose: () => void; onEdit: () => void; onChanged: () => Promise<void>;
  onPublished: (version: GuardrailVersion) => void;
}) {
  const { t } = useTranslation();
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
      return createValidationRun(guardrail.id, { onProgress: observeRun });
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
  const publish = useMutation({
    mutationFn: () => {
      if (!guardrail.tested_current || publishRevision === null || publishRevision !== guardrail.draft_revision || guardrail.published_current) {
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
  const pending = run.isPending || publish.isPending;
  const reconnect = Boolean(run.error && isValidationRunning(observedRun));
  const result = run.data ?? guardrail.latest_validation_run;
  const currentResult = result?.source_draft_version === guardrail.draft_revision ? result : null;
  const canPublish = !readOnly && !isValidationRunning(observedRun) && guardrail.tested_current && !guardrail.published_current;
  const reviewingPublish = !readOnly && publishRevision !== null;

  return <EntitySheet open width="xl" density="compact" closeDisabled={pending}
    onOpenChange={open => { if (!open && !pending) onClose(); }}
    eyebrow={guardrail.name}
    title={readOnly ? t("guardrails.draftRevisionLabel", { revision: guardrail.draft_revision ?? "—" }) : t(reviewingPublish ? "guardrails.confirmPublishTitle" : justSaved ? "guardrails.draftSaved" : "guardrails.testDraft")}
    description={t(readOnly ? "guardrails.draftReviewReadOnly" : reviewingPublish ? "guardrails.confirmPublishImpact" : "guardrails.savedDraftNextStep")}
    footer={readOnly ? <Button variant="outline" onClick={onClose}>{t("common.close")}</Button> : reviewingPublish ? <>
      <Button variant="outline" disabled={pending} onClick={() => { setPublishRevision(null); publish.reset(); }}>{t("common.back")}</Button>
      <Button disabled={pending || !canPublish || publishRevision !== guardrail.draft_revision} onClick={() => publish.mutate()}>{publish.isPending ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}{t(publish.isPending ? "guardrails.publishingVersion" : "guardrails.publishVersion")}</Button>
    </> : <>
      <Button variant="ghost" className="mr-auto" disabled={pending} onClick={onEdit}><Pencil />{t("guardrails.continueEditing")}</Button>
      <Button variant="outline" disabled={pending} onClick={onClose}>{t(currentResult ? "common.close" : "guardrails.skipTest")}</Button>
      <Button variant={canPublish ? "outline" : "default"} disabled={pending || (!reconnect && readiness.blocked)} onClick={() => run.mutate(reconnect ? observedRun!.id : undefined)}>{run.isPending ? <LoaderCircle className="animate-spin" /> : <FlaskConical />}{t(run.isPending ? "guardrails.runningValidation" : reconnect ? "guardrails.testProgress.reconnect" : currentResult ? "validation.runAgain" : "guardrails.testNow")}</Button>
      {canPublish ? <Button disabled={pending} onClick={() => setPublishRevision(guardrail.draft_revision ?? null)}><ShieldCheck />{t("guardrails.publishVersion")}</Button> : null}
    </>}>
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4 border-b pb-4" aria-live="polite">
        <div><p className="text-sm font-medium">{t("guardrails.draftRevisionLabel", { revision: guardrail.draft_revision ?? "—" })}</p><p className="mt-1 text-xs text-muted-foreground">{t("guardrails.policyCheckDetail", { count: guardrail.policy_bindings.length })}</p></div>
        <span className="text-sm font-medium">{t(run.isPending || reconnect ? "guardrails.draftTesting" : draftStateKey(guardrail))}</span>
      </div>
      {run.error || publish.error ? <ErrorNotice error={run.error ?? publish.error} /> : null}
      {reviewingPublish && publishRevision !== guardrail.draft_revision ? <p role="alert" className="text-sm text-destructive">{t("guardrails.draftChangedBeforePublish")}</p> : null}
      {!reviewingPublish ? <GuardrailValidationReadiness readiness={readiness} onRetry={() => { onRetryPolicies?.(); readiness.refresh(); }} /> : null}
      {run.isPending || reconnect ? <ValidationRunProgress run={observedRun} startedAt={run.submittedAt} interrupted={reconnect} /> : currentResult ? <>
        <div className="flex items-center justify-between gap-4"><div><p className="text-sm font-medium">{t("guardrails.testReportsTab")}</p><p className="mt-1 font-mono text-xs text-muted-foreground">{currentResult.id}</p></div><StateBadge state={currentResult.status} /></div>
        <p className="text-sm">{t("guardrails.testResultSummary", { passed: currentResult.metrics.passed, total: currentResult.metrics.total, rate: currentResult.metrics.compliance_rate })}</p>
        {currentResult.failure_reason ? <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">{currentResult.failure_reason}</p> : null}
        {!reviewingPublish ? <ValidationCaseResults key={currentResult.id} results={currentResult.results} defaultFilter={currentResult.status === "passed" ? "all" : "failed"} /> : null}
      </> : <p className="text-sm text-muted-foreground">{t(result ? "guardrails.validationEvidenceStale" : "guardrails.savedDraftUntested")}</p>}
    </div>
  </EntitySheet>;
}
