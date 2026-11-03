import { useTranslation } from "react-i18next";
import type { RuntimeOutcome } from "../../shared/runtime-outcome";
import { StateBadge } from "./product-shell";

export function RuntimeOutcomeBadge({ outcome, executionError = false }: { outcome: RuntimeOutcome | null; executionError?: boolean }) {
  const { t } = useTranslation();
  return executionError ? <span className="inline-flex flex-col items-start gap-1"><StateBadge state="error" label={t("logs.executionErrorOutcome")} /><span className="text-xs text-muted-foreground">{outcome ? t("logs.diagnostics.action", { action: t(`logs.outcomes.${outcome}`) }) : t("logs.diagnostics.noAction")}</span></span> : outcome
    ? <span className="inline-flex whitespace-nowrap"><StateBadge state={outcome} label={t(`logs.outcomes.${outcome}`)} /></span>
    : <span className="text-muted-foreground" title={t("logs.outcomeUnavailable")} aria-label={t("logs.outcomeUnavailable")}>—</span>;
}
