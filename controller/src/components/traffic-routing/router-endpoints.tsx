import { EndpointProtocolIcon } from "@/components/endpoint-protocol-icon";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { MoreHorizontal, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EntitySheet } from "@/components/entity-sheet";
import {
  EmptyState,
  ErrorNotice,
  StateBadge,
} from "@/components/product-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { queryKeys } from "@/features/query-keys";
import { getEndpoints } from "@/lib/endpoints-api";
import {
  bindTrafficRouter,
  listTrafficRouters,
  trafficRouterKeys,
  type TrafficRouter,
} from "@/lib/traffic-routing-api";


export const endpointHref = (id: string) =>
  `/integration/endpoints?${new URLSearchParams({ endpointId: id })}`;
type Action = { kind: "attach" } | { kind: "detach"; id: string; name: string };

export function RouterEndpoints({
  router,
  canEdit,
  onBound,
}: {
  router: TrafficRouter;
  canEdit: boolean;
  onBound: (next: TrafficRouter) => void | Promise<void>;
}) {
  const { t: localize } = useTranslation();
  const { t } = useTranslation();
  const { t: translate } = useTranslation();
  const client = useQueryClient();
  const opener = useRef<HTMLElement | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const endpoints = useQuery({
    queryKey: queryKeys.endpoints,
    queryFn: getEndpoints,
  });
  const routers = useQuery({
    queryKey: trafficRouterKeys.all,
    queryFn: listTrafficRouters,
    enabled: action?.kind === "attach",
  });
  const options = (endpoints.data?.items ?? [])
    .filter((endpoint) => !router.endpointIds.includes(endpoint.id))
    .map((endpoint) => {
      const owner = routers.data?.items.find(
        (item) =>
          item.id !== router.id && item.endpointIds.includes(endpoint.id),
      );
      return {
        value: endpoint.id,
        label: endpoint.name,
        meta: endpoint.protocol,
        keywords: [endpoint.id],
        disabled: Boolean(owner),
        description: owner
          ? `${t("routing.boundTo")} ${owner.name}`
          : translate(`endpoints.setupStatuses.${endpoint.setup_status}`),
      };
    });
  const selectionAvailable =
    selected.length > 0 &&
    selected.every((id) =>
      options.some((option) => option.value === id && !option.disabled),
    );
  const sourcesReady = Boolean(
    endpoints.data &&
    routers.data &&
    !endpoints.error &&
    !routers.error &&
    !endpoints.isFetching &&
    !routers.isFetching,
  );
  const mutation = useMutation({
    mutationFn: async () => {
      if (!canEdit || !action)
        throw new Error(
          t("routing.bindingsCannotBeEditedRightNow"),
        );
      if (action.kind === "attach" && (!sourcesReady || !selectionAvailable))
        throw new Error(
          t("routing.refreshAndSelectAvailableEndpoints"),
        );
      // This API replaces the full list. Preserve all existing bindings on attach.
      const ids =
        action.kind === "attach"
          ? [...new Set([...router.endpointIds, ...selected])]
          : router.endpointIds.filter((id) => id !== action.id);
      return bindTrafficRouter(router.id, ids);
    },
    onSuccess: async (next) => {
      client.setQueryData(trafficRouterKeys.detail(next.id), next);
      await onBound(next);
      await Promise.all([
        client.invalidateQueries({ queryKey: trafficRouterKeys.all }),
        client.invalidateQueries({ queryKey: queryKeys.endpoints }),
        client.invalidateQueries({ queryKey: ["routing-source-endpoints"] }),
        client.invalidateQueries({ queryKey: ["routing-fields"] }),
      ]);
      setAction(null);
      setSelected([]);
    },
  });
  const open = (next: Action, target: HTMLElement) => {
    opener.current = target;
    mutation.reset();
    setSelected([]);
    setAction(next);
  };
  const close = () => {
    if (!mutation.isPending) setAction(null);
  };
  const attachLabel = t("routing.attachEndpoint");
  const detachLabel = t("routing.detachFromRouter");
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">{localize("routing.endpoints2")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("routing.sourceEndpointsAttachedToThisRouter")}
          </p>
        </div>
        {canEdit && (
          <Button
            className="router-workspace-action"
            disabled={mutation.isPending}
            onClick={(event) => open({ kind: "attach" }, event.currentTarget)}
          >
            <Plus />
            {attachLabel}
          </Button>
        )}
      </div>
      {!canEdit && (
        <p className="text-sm text-muted-foreground">
          {t("routing.readOnlyOnlyAdministratorsCanChangeEndpointBindings")}
        </p>
      )}
      {endpoints.error && (
        <div className="space-y-2">
          <ErrorNotice error={endpoints.error} />
          <Button variant="outline" onClick={() => void endpoints.refetch()}>
            {t("routing.retry")}
          </Button>
        </div>
      )}
      {endpoints.isPending ? (
        <Skeleton className="h-48" />
      ) : router.endpointIds.length ? (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{localize("routing.endpoint")}</TableHead>
                <TableHead>{t("routing.protocol")}</TableHead>
                <TableHead>{t("routing.status")}</TableHead>
                <TableHead className="text-right">
                  {t("routing.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {router.endpointIds.map((id) => {
                const endpoint = endpoints.data?.items.find(
                  (item) => item.id === id,
                );
                const name = endpoint?.name ?? id;
                return (
                  <TableRow key={id}>
                    <TableCell>
                      <Link
                        className="inline-flex min-h-11 items-center gap-2 font-medium text-primary hover:underline"
                        to="/integration/endpoints"
                        search={{ endpointId: id }}
                      >
                        {endpoint && <EndpointProtocolIcon protocol={endpoint.protocol} size="sm" />}
                        <span>{name}</span>
                      </Link>
                    </TableCell>
                    <TableCell>
                      {endpoint
                        ? translate(
                            `endpoints.protocolShort.${endpoint.protocol}`,
                          )
                        : "—"}
                    </TableCell>
                    <TableCell>
                      {endpoint ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline">
                            {translate(
                              `endpoints.setupStatuses.${endpoint.setup_status}`,
                            )}
                          </Badge>
                          <StateBadge state={endpoint.runtime_status} />
                        </div>
                      ) : (
                        <span className="text-muted-foreground">
                          {t("routing.statusUnavailable")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-11"
                            aria-label={`${t("routing.actions")}: ${name}`}
                            onClick={(event) => {
                              opener.current = event.currentTarget;
                            }}
                          >
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem asChild>
                            <Link
                              to="/integration/endpoints"
                              search={{ endpointId: id }}
                            >
                              {t("routing.viewEndpoint")}
                            </Link>
                          </DropdownMenuItem>
                          {canEdit && (
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={mutation.isPending}
                              onSelect={() =>
                                open(
                                  { kind: "detach", id, name },
                                  opener.current ?? document.body,
                                )
                              }
                            >
                              {detachLabel}
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        !endpoints.error && (
          <EmptyState
            title={t("routing.noEndpointsAttached")}
            description={t("routing.attachAnEndpointToConnectIncomingTrafficToThis")}
          />
        )
      )}
      <EntitySheet
        open={Boolean(action)}
        onOpenChange={(value) => {
          if (!value) close();
        }}
        closeDisabled={mutation.isPending}
        returnFocusRef={opener}
        width="md"
        eyebrow={router.name}
        title={action?.kind === "detach" ? detachLabel : attachLabel}
        description={
          action?.kind === "detach"
            ? t("routing.detachingTakesEffectImmediatelyTrafficFromThisEndpointWill")
            : t("routing.eachEndpointCanBelongToOnlyOneRouterEndpoints")
        }
        footer={
          <>
            <Button
              variant="outline"
              disabled={mutation.isPending}
              onClick={close}
            >
              {t("routing.cancel")}
            </Button>
            <Button
              variant={action?.kind === "detach" ? "destructive" : "default"}
              disabled={
                !canEdit ||
                mutation.isPending ||
                (action?.kind === "attach" &&
                  (!sourcesReady || !selectionAvailable))
              }
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending
                ? t("routing.saving")
                : action?.kind === "detach"
                  ? t("routing.detachEndpoint")
                  : attachLabel}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {action?.kind === "detach" ? (
            <p className="text-sm">{action.name}</p>
          ) : action?.kind === "attach" ? (
            <>
              {(endpoints.isPending || routers.isPending) && (
                <Skeleton className="h-12" />
              )}
              <MultiSelectCombobox
                ariaLabel={t("routing.selectEndpoints")}
                options={options}
                value={selected}
                onValueChange={setSelected}
                disabled={!canEdit || mutation.isPending || !sourcesReady}
                placeholder={t("routing.searchOrSelectEndpoints")}
                searchPlaceholder={t("routing.searchByName")}
                noOptionsMessage={t("routing.noEndpointsToAttach")}
              />
              {endpoints.error && <ErrorNotice error={endpoints.error} />}
              {routers.error && <ErrorNotice error={routers.error} />}
              {(endpoints.error || routers.error) && (
                <Button
                  variant="outline"
                  onClick={() => {
                    void endpoints.refetch();
                    void routers.refetch();
                  }}
                >
                  {t("routing.retry")}
                </Button>
              )}
            </>
          ) : null}
          {mutation.error && <ErrorNotice error={mutation.error} />}
        </div>
      </EntitySheet>
    </section>
  );
}
