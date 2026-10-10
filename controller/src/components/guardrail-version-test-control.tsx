import { useRef, useState } from "react";
import { LoaderCircle, Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EntitySheet } from "./entity-sheet";
import { Button } from "./ui/button";
import { isValidationRunning } from "./validation-run-progress";
import type { GuardrailVersion, ValidationRun } from "@/lib/api";

/** The report list has one entry point; test targets are shown as rows, never a filter. */
export function GuardrailVersionTestControl({ versions, runs, loading, error, submitting, onRun, onRetry, draft, guardrailName }: {
  guardrailName: string; versions: GuardrailVersion[]; runs: ValidationRun[]; loading: boolean; error: unknown;
  submitting: boolean; onRun: (version: string) => Promise<unknown>; onRetry: () => void;
  draft?: { running: boolean; reason: string | null; onReview: () => void };
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [pendingVersion, setPendingVersion] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const reason = error ? t("immutableVersions.noDetail") : loading ? t("immutableVersions.loading") : null;
  const ordered = [...versions].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.version.localeCompare(a.version));
  return <>
    <Button ref={opener} className="min-h-11 shrink-0" onClick={() => setOpen(true)}><Play />{t("guardrails.runReviewed")}</Button>
    <EntitySheet eyebrow={guardrailName} returnFocusRef={opener} open={open} onOpenChange={value => { if (!submitting) setOpen(value); }} closeDisabled={submitting} width="lg"
      title={t("guardrails.runReviewed")} description={t(draft ? "immutableVersions.chooseTestTarget" : "immutableVersions.chooseVersionTestTarget")}
      footer={<Button variant="outline" disabled={submitting} onClick={() => setOpen(false)}>{t("common.close")}</Button>}>
      {reason ? <div className="space-y-3"><p role="status" className="text-sm text-muted-foreground">{reason}</p>{error ? <Button variant="outline" onClick={onRetry}>{t("immutableVersions.retry")}</Button> : null}</div> : null}
      <div className="divide-y border bg-card">
        {draft ? <div className="flex items-center justify-between gap-6 p-4">
          <div><p className="text-sm font-medium">{t("immutableVersions.currentDraft")}</p><p className="mt-1 text-xs text-muted-foreground">{draft.reason ?? t("immutableVersions.reviewDraftTests")}</p></div>
          <Button variant="outline" disabled={submitting || Boolean(draft.reason)} onClick={() => { setOpen(false); draft.onReview(); }}>
            {draft.running ? <LoaderCircle className="animate-spin" /> : <Play />}{t(draft.running ? "guardrails.viewTestProgress" : "guardrails.testDraft")}
          </Button>
        </div> : null}
        {ordered.map(version => {
          const running = runs.some(run => run.subject === "version" && run.guardrail_version === version.version && isValidationRunning(run));
          return <div key={version.version} className="flex items-center justify-between gap-6 p-4">
            <div className="min-w-0"><p className="font-mono text-sm">{version.version}</p><p className="mt-1 text-xs text-muted-foreground">{version.test_suite_count ? t("guardrailPackage.testSuiteCases", { count: version.test_suite_count }) : t("immutableVersions.noTestSuite")}</p></div>
            <Button variant="outline" className="shrink-0" aria-label={t("immutableVersions.runVersionTests", { version: version.version })}
              disabled={Boolean(reason) || !version.test_suite_count || running || submitting}
              onClick={() => { setPendingVersion(version.version); void onRun(version.version).then(() => setOpen(false)).catch(() => {}).finally(() => setPendingVersion(null)); }}>
              {running || pendingVersion === version.version ? <LoaderCircle className="animate-spin" /> : <Play />}{t(running || pendingVersion === version.version ? "guardrails.runningValidation" : "immutableVersions.runTests")}
            </Button>
          </div>;
        })}
        {!reason && !versions.length && !draft ? <p className="p-4 text-sm text-muted-foreground">{t("guardrails.noPublishedVersion")}</p> : null}
      </div>
    </EntitySheet>
  </>;
}
