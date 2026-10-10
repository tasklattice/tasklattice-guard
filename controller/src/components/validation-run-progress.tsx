import { useEffect, useState } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Progress } from "@/components/ui/progress";
import type { ValidationRun } from "@/lib/api";

export function isValidationRunning(run?: ValidationRun | null) {
  return run?.execution_status === "queued" || run?.execution_status === "running";
}

export function ValidationRunProgress({ run, startedAt, interrupted = false }: {
  run: ValidationRun | null; startedAt: number; interrupted?: boolean;
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
    <p className="mt-2 text-sm text-muted-foreground">{t(`guardrails.testProgress.${interrupted ? "interrupted" : phase}Detail`)}</p>
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
    <p className="mt-5 text-xs text-muted-foreground">{t(run?.subject === "version" ? "immutableVersions.testingInPlace" : "guardrails.testingInPlace")}</p>
  </section>;
}
