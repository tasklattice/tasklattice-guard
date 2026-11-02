import { useEffect, useState } from "react";
import { Check, LoaderCircle, Square } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ErrorNotice } from "@/components/product-shell";
import { queryKeys } from "@/features/query-keys";
import { cancelValidationRun } from "@/lib/api";
import { useTranslation } from "react-i18next";
import { Progress } from "@/components/ui/progress";
import type { ValidationRun } from "@/lib/api";

export function isValidationRunning(run?: ValidationRun | null) {
  return run?.execution_status === "queued" || run?.execution_status === "running";
}

export function hasValidationReportResults(run: ValidationRun) {
  // The execution state takes precedence over any provisional outcome. Older
  // reports without an execution state retain their recorded terminal outcome.
  const state = run.execution_status ?? run.status;
  return state === "passed" || state === "failed";
}

export function ValidationRunProgress({ run, startedAt, interrupted = false, canCancel = false, showContext = true }: {
  run: ValidationRun | null; startedAt: number; interrupted?: boolean; canCancel?: boolean; showContext?: boolean;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const progress = run?.progress;
  const phase = !run ? "submitting" : progress?.phase ?? (run.execution_status === "queued" ? "queued" : "starting");
  const phases = ["queued", "preparing", "executing", "finalizing"];
  const step = phase === "submitting" ? -1 : phase === "starting" ? 1 : phases.indexOf(phase);
  const origin = run?.created_at ? Date.parse(run.created_at) : startedAt;
  const elapsed = Math.max(0, Math.floor((now - origin) / 1000));
  const duration = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
  const total = run?.metrics.total ?? 0;
  const completed = progress?.completedCases ?? 0;
  const determinate = Boolean(progress && (phase === "executing" || phase === "finalizing") && total > 0);
  const stalledFor = Math.max(0, Math.floor((now - Date.parse(progress?.updatedAt ?? run?.created_at ?? new Date(startedAt).toISOString())) / 1000));

  return <section className="validation-run-progress" aria-label={t("guardrails.testProgress.title")}>
    <div className="flex items-center justify-between gap-4">
      <p role="status" className="flex items-center gap-2 font-medium"><LoaderCircle aria-hidden className={`size-4 ${interrupted ? "" : "animate-spin motion-reduce:animate-none"}`} />{t(`guardrails.testProgress.${interrupted ? "interrupted" : phase}`)}</p>
      <span className="text-sm tabular-nums text-muted-foreground">{t("guardrails.testProgress.elapsed", { duration })}</span>
    </div>
    <p className="mt-2 text-sm text-muted-foreground">{t(`guardrails.testProgress.${interrupted ? "interrupted" : phase === "preparing" && run?.subject === "version" ? "preparingVersion" : phase}Detail`)}</p>
    <div className="my-5 space-y-2">
      <div className="flex items-center justify-between gap-4 text-sm tabular-nums">
        <span>{t(determinate ? "guardrails.testProgress.completed" : run ? "guardrails.testProgress.total" : "guardrails.testProgress.requesting", { completed, total })}</span>
        {determinate ? <span className="font-medium">{Math.floor(completed / total * 100)}%</span> : null}
      </div>
      <Progress aria-label={t("guardrails.testProgress.caseProgress")} value={determinate ? completed : undefined} max={total || 100} />
      {determinate ? <p className="text-xs text-muted-foreground">{t("guardrails.testProgress.outcomes", { passed: progress!.passedCases, failed: completed - progress!.passedCases })}</p> : null}
    </div>
    <ol className="validation-run-progress__steps" aria-label={t("guardrails.testProgress.stages")}>
      {phases.map((item, index) => <li key={item} aria-current={index === step ? "step" : undefined} data-complete={index < step || undefined}>
        <span className="validation-run-progress__marker" aria-hidden>{index < step ? <Check className="size-3" /> : index + 1}</span>
        <span>{t(`guardrails.testProgress.step_${item}`)}</span>
      </li>)}
    </ol>
    {!interrupted && stalledFor >= 30 ? <p role="status" className="mt-5 text-sm text-muted-foreground">{t("guardrails.testProgress.waitingUpdate", { seconds: stalledFor })}</p> : null}
    {showContext ? <p className="mt-4 text-xs text-muted-foreground">{t(run?.subject === "version" ? "immutableVersions.testingInPlace" : "guardrails.testingInPlace")}</p> : null}
    {canCancel && run && isValidationRunning(run) ? <StopValidationButton key={run.id} run={run} /> : null}
  </section>;
}

function StopValidationButton({ run }: { run: ValidationRun }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const stop = useMutation({ mutationFn: () => cancelValidationRun(run.id), onSuccess: async result => {
    queryClient.setQueryData(queryKeys.validationRun(run.id), result);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.allValidationRuns }),
      queryClient.invalidateQueries({ queryKey: queryKeys.validationRuns(run.guardrail_id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.guardrails }),
      queryClient.invalidateQueries({ queryKey: queryKeys.guardrail(run.guardrail_id) }),
    ]);
  } });
  return <div className="mt-4 border-t pt-3">
    <div className="flex items-center justify-between gap-6">
    <p className="text-xs leading-5 text-muted-foreground">{t("validationControl.hint")}</p>
    <Button variant="ghost" className="shrink-0 text-destructive" disabled={stop.isPending || stop.isSuccess} onClick={() => stop.mutate()}>
      {stop.isPending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <Square />}
      {t(stop.isPending ? "validationControl.stopping" : stop.isSuccess ? "validationControl.stopped" : "validationControl.stop")}
    </Button>
    </div>
    {stop.error ? <div className="mt-2"><ErrorNotice error={stop.error} /></div> : null}
  </div>;
}
