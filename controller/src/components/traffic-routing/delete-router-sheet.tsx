import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ConfirmationSheet } from "@/components/confirmation-sheet";
import { ErrorNotice } from "@/components/product-shell";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/notifications";
import { queryKeys } from "@/features/query-keys";
import { deleteTrafficRouter, getTrafficRouter, trafficRouterKeys, type TrafficRouter } from "@/lib/traffic-routing-api";

export function DeleteTrafficRouterSheet({ router, onClose }: { router: TrafficRouter; onClose: () => void }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const current = useQuery({ queryKey: trafficRouterKeys.detail(router.id), queryFn: () => getTrafficRouter(router.id), staleTime: 0 });
  const bound = Boolean(current.data?.endpointIds.length);
  const remove = useMutation({
    mutationFn: () => deleteTrafficRouter(router.id),
    onError: () => { void current.refetch(); },
    onSuccess: async () => {
      client.removeQueries({ queryKey: trafficRouterKeys.detail(router.id) });
      await Promise.all([
        client.invalidateQueries({ queryKey: trafficRouterKeys.all }),
        client.invalidateQueries({ queryKey: queryKeys.routers }),
        client.invalidateQueries({ queryKey: queryKeys.metrics }),
        client.invalidateQueries({ queryKey: queryKeys.auditEvents }),
      ]);
      toast.success(t("routerDetail.deleteSucceeded"));
      onClose();
    },
  });
  const error = remove.error ?? current.error;
  return <ConfirmationSheet
    open onOpenChange={open => { if (!open) onClose(); }}
    eyebrow={t("routing.router")}
    title={t("routerDetail.deleteDialogTitle")}
    description={t("routerDetail.deleteDialogDescription", { name: current.data?.name ?? router.name })}
    cancelLabel={t("common.cancel")}
    confirmLabel={t("routerDetail.deleteConfirm")}
    pendingLabel={t("routerDetail.deleting")}
    variant="destructive"
    pending={remove.isPending}
    confirmDisabled={!current.data || current.isFetching || Boolean(current.error) || bound}
    onConfirm={() => remove.mutate()}
  >
    {current.isFetching && <p role="status">{t("routing.checkingRouterBindings")}</p>}
    {bound && <div className="space-y-2">
      <p>{t("routing.deleteRouterUnbindFirst", { count: current.data!.endpointIds.length })}</p>
      <Button asChild variant="outline"><Link to="/integration/routers/$routerId" params={{ routerId: router.id }} search={{ tab: "endpoints" }}>{t("routing.manageRouterEndpoints")}</Link></Button>
    </div>}
    <p className="text-sm text-muted-foreground">{t("routerDetail.deleteRetentionNote")}</p>
    {error && <ErrorNotice error={error} />}
    {current.error && <Button variant="outline" onClick={() => void current.refetch()}>{t("common.retry")}</Button>}
  </ConfirmationSheet>;
}
