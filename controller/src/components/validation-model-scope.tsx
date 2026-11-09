import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "./ui/switch";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import type { ValidationRun } from "@/lib/api";

export function TestModelRulesSwitch({ checked, onChange, disabled = false }: {
  checked: boolean; onChange: (value: boolean) => void; disabled?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  return <div className="mb-4 flex items-center justify-between gap-6 border p-4">
    <div><label htmlFor={id} className="text-sm font-medium">{t("validationScope.toggle")}</label>
      <p id={`${id}-help`} className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">{t("validationScope.help")}</p></div>
    <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={t("validationScope.toggle")} aria-describedby={`${id}-help`} />
  </div>;
}

export function ValidationScopeNotice({ run }: { run: ValidationRun }) {
  const { t } = useTranslation();
  if (run.test_model_rules !== false) return null;
  const scope = run.test_scope;
  return <Alert variant="warning">
    <AlertTitle>{t("validationScope.badge")}</AlertTitle>
    <AlertDescription className="text-current">
      <p>{t(scope ? "validationScope.summary" : "validationScope.pending", {
        executed: run.metrics.executed ?? run.metrics.total - (run.metrics.skipped ?? 0),
        skipped: run.metrics.skipped ?? 0, calls: scope?.modelInvocations ?? 0,
      })}</p>
      {scope?.skippedRules.length ? <details className="mt-2">
        <summary className="cursor-pointer py-1">{t("validationScope.rules")} ({scope.skippedRules.length})</summary>
        <ul className="mt-1 space-y-1">{scope.skippedRules.map(r => <li key={`${r.policyId}/${r.ruleId}`} className="break-words text-xs">
          <code>{r.policyId} / {r.ruleId}</code> — {r.reason}
        </li>)}</ul>
      </details> : null}
    </AlertDescription>
  </Alert>;
}
