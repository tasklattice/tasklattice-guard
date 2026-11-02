import { useTranslation } from "react-i18next";
import type { ModelStatus } from "../../shared/execution-diagnostics";

export function ModelCallStatus({ status }: { status?: ModelStatus | null }) {
  const { t } = useTranslation();
  if (!status) return null;
  return <span className="text-xs text-muted-foreground" title={t("logs.modelStatusDescription")}>{t(`logs.modelStatus.${status}`)}</span>;
}
