import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/features/query-keys";
import { getDeploymentCapabilities, type DeploymentCapabilities } from "./controller-api";

/**
 * What this deployment has configured for release packages. Every deployment
 * offers the same features; this only reports whether export (a signing
 * identity) and import (trusted sources) are set up here.
 */
export function useDeploymentCapabilities(): DeploymentCapabilities & { known: boolean } {
  const query = useQuery({ queryKey: queryKeys.deploymentCapabilities, queryFn: getDeploymentCapabilities, staleTime: Infinity, retry: 1, retryDelay: 200 });
  const data = query.data;
  return {
    packageExport: data?.packageExport ?? { available: false, sourceId: null },
    packageImport: data?.packageImport ?? { available: false },
    known: query.isSuccess,
  };
}
