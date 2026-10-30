import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getTestingReportDeletionImpact, deleteTestingReport } from "@/lib/controller-api";
import type { ValidationRun } from "@/lib/api";
import { queryKeys } from "@/features/query-keys";
import { ConfirmationSheet } from "./confirmation-sheet";
import { Alert, AlertDescription } from "./ui/alert";
import { ErrorNotice } from "./product-shell";
import { Skeleton } from "./ui/skeleton";
import { Button } from "./ui/button";
import { toast } from "./ui/notifications";

export function DeleteTestingReportSheet({ run, onClose, onDeleted }: { run: ValidationRun; onClose: () => void; onDeleted: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const impact = useQuery({ queryKey: ["testing-report-deletion", run.id], queryFn: () => getTestingReportDeletionImpact(run.id), staleTime: 0 });
  const remove = useMutation({
    mutationFn: () => deleteTestingReport(run.id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.guardrails }),
        queryClient.invalidateQueries({ queryKey: queryKeys.guardrailVersions(run.guardrail_id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.allValidationRuns }),
        queryClient.invalidateQueries({ queryKey: queryKeys.metrics }),
      ]);
      queryClient.removeQueries({ queryKey: queryKeys.validationRun(run.id), exact: true });
      queryClient.removeQueries({ queryKey: ["testing-report-deletion", run.id], exact: true });
      toast.success(t("validation.reportDeleted"));
      onDeleted();
    },
    onError: () => { void impact.refetch(); },
  });
  const result = impact.data;
  return <ConfirmationSheet open onOpenChange={open => { if (!open) onClose(); }} onConfirm={() => remove.mutate()}
    eyebrow={t("validation.detailEyebrow")} title={t("validation.deleteReportTitle")}
    description={t("validation.deleteReportDescription")} variant="destructive"
    cancelLabel={t("common.cancel")} confirmLabel={t("validation.deleteReport")}
    confirmDisabled={impact.isFetching || !result?.deletable} pending={remove.isPending}>
    <p className="break-all font-mono text-xs text-muted-foreground">{run.id}</p>
    {impact.isPending ? <Skeleton className="h-24" /> : null}
    {impact.error ? <><ErrorNotice error={impact.error} /><Button variant="outline" onClick={() => { void impact.refetch(); }}>{t("common.retry")}</Button></> : null}
    {result?.running ? <Alert variant="warning"><AlertDescription>{t("validation.deleteReportRunning")}</AlertDescription></Alert> : null}
    {result && !result.deletable ? <Button variant="outline" disabled={impact.isFetching} onClick={() => { void impact.refetch(); }}>{t("common.retry")}</Button> : null}
    {remove.error ? <ErrorNotice error={remove.error} /> : null}
  </ConfirmationSheet>;
}
