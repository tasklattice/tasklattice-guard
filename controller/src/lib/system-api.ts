import * as controllerApi from "@/lib/controller-api";
import type { SystemStatus } from "@/lib/api-types";

const unique = <T>(values: T[]): T[] => [...new Set(values)];

export async function getSystemStatus(): Promise<SystemStatus> {
  const [status, deployments, integrations] = await Promise.all([
    controllerApi.getControllerSystemStatus(),
    controllerApi.listControllerDeployments(),
    controllerApi.listControllerIntegrations(),
  ]);
  return {
    status: status.status === "ready" ? "healthy" : "degraded",
    status_reason: status.defaultRunnerReady ? "runtime_ready" : "default_runner_unavailable",
    active_deployments: deployments.items.filter((item) => item.enabled).length,
    enabled_integrations: integrations.items.filter((item) => item.status === "active").length,
    total_integrations: integrations.items.length,
    capabilities: {
      deterministic: true,
      fast_semantic: true,
      specialized_evaluators: unique([
        "secrets", "pii", "builtin_content_filter", "prompt_injection", "jailbreak",
        ...status.modelConnections.dataPlane.models.map((item) => item.capability),
      ]),
      generic_runtime_llm: false,
      automated_reasoning: status.modelConnections.dataPlane.models.some((item) => item.capability === "automatedReasoning"),
    },
  };
}
