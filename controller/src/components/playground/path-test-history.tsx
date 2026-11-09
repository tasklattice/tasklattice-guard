import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { EntitySheet } from "@/components/entity-sheet";
import { StateBadge } from "@/components/product-shell";

import type { PathTestRecord } from "./use-path-workbench";

export function PathTestHistory({
  open,
  onOpenChange,
  records,
  onRestore,
  onClear,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  records: PathTestRecord[];
  onRestore: (record: PathTestRecord) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  return (
    <EntitySheet open={open} onOpenChange={onOpenChange} width="md" density="compact"
      eyebrow={t("routing.testResult")} title={t("routing.testHistory")}
      description={t("routing.last50TestsInThisPageSessionRestoringA")}
      footer={<>
        <Button variant="ghost" disabled={!records.length} onClick={onClear}>{t("routing.clearHistory")}</Button>
        <Button variant="outline" onClick={() => onOpenChange(false)}>{t("routing.close")}</Button>
      </>}>
        <div>
          {records.length ? (
            records.map((item) => (
              <div key={item.id} className="space-y-2 border-b py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 space-y-1">
                    <p className="break-words text-sm font-medium">{item.label}</p>
                    <p className="text-xs text-muted-foreground">{item.configuration} · {new Date(item.createdAt).toLocaleTimeString()}</p>
                  </div>
                  <span className="shrink-0"><StateBadge
                    state={item.error || (item.result && item.result.status >= 400) ? "failed" : "success"}
                    label={item.error ? t("routing.failed") : item.result ? `HTTP ${item.result.status}` : "—"}
                  /></span>
                </div>
                <p className="break-all font-mono text-xs">
                  {item.input.request.split("\n")[0]}
                </p>
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => {
                    onRestore(item);
                    onOpenChange(false);
                  }}
                >
                  {t("routing.restoreRequestAndResult")}
                </Button>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("routing.noTestHistoryYet")}
            </p>
          )}
        </div>
    </EntitySheet>
  );
}
