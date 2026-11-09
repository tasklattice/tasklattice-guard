import { projectParams } from "@/lib/project-paths";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { listTrafficRouters, trafficRouterKeys } from "@/lib/traffic-routing-api";

export function EndpointRouterLink({ endpointId }: { endpointId: string }) {
  const { t } = useTranslation();
  const query = useQuery({ queryKey: trafficRouterKeys.all, queryFn: listTrafficRouters });
  const router = query.data?.items.find(item => item.endpointIds.includes(endpointId));
  if (router) return <Link to="/$projectId/integration/routers/$routerId" params={{ ...projectParams(), routerId: router.id }}
    onClick={event => event.stopPropagation()} className="resource-related-link">{router.name}</Link>;
  return <span className="text-xs text-muted-foreground">{t(query.error ? "resourceList.relationshipUnavailable" : query.isPending ? "common.loading" : "resourceList.unboundRouter")}</span>;
}
