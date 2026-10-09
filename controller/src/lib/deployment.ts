import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/features/query-keys";
import { getDeploymentCapabilities, type DeploymentCapabilities } from "./controller-api";

/**
 * Deployment capabilities. Until known, authoring is assumed, so an authoring
 * environment never flickers read-only; the API enforces the real switch.
 * `settled` lets a page that must not call authoring APIs wait for the answer.
 */
export function useDeploymentCapabilities(): DeploymentCapabilities & { known: boolean; settled: boolean } {
  const query = useQuery({ queryKey: queryKeys.deploymentCapabilities, queryFn: getDeploymentCapabilities, staleTime: Infinity, retry: 1, retryDelay: 200 });
  const data = query.data;
  return {
    authoringEnabled: data?.authoringEnabled !== false,
    packageExport: data?.packageExport ?? { available: false, sourceId: null },
    packageImport: data?.packageImport ?? { available: false },
    known: query.isSuccess,
    settled: !query.isPending,
  };
}
