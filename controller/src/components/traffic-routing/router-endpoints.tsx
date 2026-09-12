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
import { useRoutingText } from "./form";

export const endpointHref = (id: string) =>
  `/integration/endpoint?${new URLSearchParams({ endpointId: id })}`;
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
  const t = useRoutingText();
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
          ? `${t("已绑定到", "Bound to")} ${owner.name}`
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
          t("当前不可编辑绑定。", "Bindings cannot be edited right now."),
        );
      if (action.kind === "attach" && (!sourcesReady || !selectionAvailable))
        throw new Error(
          t(
            "请刷新并重新选择可用 Endpoint。",
            "Refresh and select available Endpoints.",
          ),
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
  const attachLabel = t("附加 Endpoint", "Attach endpoint");
  const detachLabel = t("从 Router 解除绑定", "Detach from router");
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">Endpoints</h2>
          <p className="text-sm text-muted-foreground">
            {t(
              "接入此 Router 的来源 Endpoint。",
              "Source Endpoints attached to this Router.",
            )}
          </p>
        </div>
        {canEdit && (
          <Button
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
          {t(
            "只读：仅管理员可修改 Endpoint 绑定。",
            "Read only. Only administrators can change Endpoint bindings.",
          )}
        </p>
      )}
      {endpoints.error && (
        <div className="space-y-2">
          <ErrorNotice error={endpoints.error} />
          <Button variant="outline" onClick={() => void endpoints.refetch()}>
            {t("重试", "Retry")}
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
                <TableHead>Endpoint</TableHead>
                <TableHead>{t("协议", "Protocol")}</TableHead>
                <TableHead>{t("状态", "Status")}</TableHead>
                <TableHead className="text-right">
                  {t("操作", "Actions")}
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
                        to="/integration/endpoint"
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
                          {t("状态不可用", "Status unavailable")}
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
                            aria-label={`${t("操作", "Actions")}: ${name}`}
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
                              to="/integration/endpoint"
                              search={{ endpointId: id }}
                            >
                              {t("查看 Endpoint", "View endpoint")}
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
            title={t("尚未绑定 Endpoint", "No Endpoints attached")}
            description={t(
              "附加 Endpoint 以将来源流量接入此 Router。",
              "Attach an Endpoint to connect incoming traffic to this Router.",
            )}
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
            ? t(
                "解除绑定立即生效，该 Endpoint 将无法通过此 Router 接收评估调用。",
                "Detaching takes effect immediately. Traffic from this Endpoint will no longer use this Router.",
              )
            : t(
                "每个 Endpoint 只能绑定一个 Router；已属于其他 Router 的 Endpoint 不可选择。",
                "Each Endpoint can belong to only one Router. Endpoints owned by other Routers cannot be selected.",
              )
        }
        footer={
          <>
            <Button
              variant="outline"
              disabled={mutation.isPending}
              onClick={close}
            >
              {t("取消", "Cancel")}
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
                ? t("保存中…", "Saving…")
                : action?.kind === "detach"
                  ? t("解除绑定", "Detach endpoint")
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
                ariaLabel={t("选择 Endpoint", "Select Endpoints")}
                options={options}
                value={selected}
                onValueChange={setSelected}
                disabled={!canEdit || mutation.isPending || !sourcesReady}
                placeholder={t(
                  "搜索或选择 Endpoint…",
                  "Search or select Endpoints…",
                )}
                searchPlaceholder={t("按名称搜索…", "Search by name…")}
                noOptionsMessage={t(
                  "没有可附加的 Endpoint。",
                  "No Endpoints to attach.",
                )}
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
                  {t("重试", "Retry")}
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
