import { useTranslation } from "react-i18next";
import type { RuntimeOutcome } from "../../shared/runtime-outcome";
import { StateBadge } from "./product-shell";

export function RuntimeOutcomeBadge({ outcome, executionError = false }: { outcome: RuntimeOutcome | null; executionError?: boolean }) {
  const { t } = useTranslation();
  return executionError ? <span className="inline-flex flex-wrap gap-1"><StateBadge state="error" label={t("logs.executionErrorOutcome")} />{outcome ? <RuntimeOutcomeBadge outcome={outcome} /> : null}</span> : outcome
    ? <span className="inline-flex whitespace-nowrap"><StateBadge state={outcome} label={t(`logs.outcomes.${outcome}`)} /></span>
    : <span className="text-muted-foreground" title={t("logs.outcomeUnavailable")} aria-label={t("logs.outcomeUnavailable")}>—</span>;
}
