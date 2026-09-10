import * as controllerApi from "@/lib/controller-api";
import type { SystemStatus } from "@/lib/api-types";

const unique = <T>(values: T[]): T[] => [...new Set(values)];

export async function getSystemStatus(): Promise<SystemStatus> {
  const [status, routers, endpoints] = await Promise.all([
    controllerApi.getControllerSystemStatus(),
    controllerApi.listControllerRouters(),
    controllerApi.listControllerEndpoints(),
  ]);
  const runtimeModels = status.components.runtimeModels.models;
  const runtimeHealthy = status.status === "healthy";
  return {
    status: runtimeHealthy ? "healthy" : "degraded",
    status_reason: runtimeHealthy ? "runtime_ready" : "default_runner_unavailable",
    active_routers: routers.items.filter((item) => item.enabled).length,
    enabled_endpoints: endpoints.items.filter((item) => item.status === "active").length,
    total_endpoints: endpoints.items.length,
    capabilities: {
      evaluators: unique(runtimeModels.map((item) => item.id)),
      generic_runtime_llm: false,
      automated_reasoning: runtimeModels.some((item) => item.id === "automated-reasoning"),
    },
  };
}
