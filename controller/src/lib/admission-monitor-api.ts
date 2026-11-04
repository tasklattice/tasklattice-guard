import { admissionMonitorStateSchema } from "../../shared/admission-monitor";
import { requestController } from "./controller-api";
export type { AdmissionMonitorState, AdmissionMonitorEntity } from "../../shared/admission-monitor";
export const admissionMonitorKey = ["settings", "project-admission-monitor"] as const;
export async function getAdmissionMonitor(poolId?: string, signal?: AbortSignal) {
  const query = poolId ? `?poolId=${encodeURIComponent(poolId)}` : "";
  return admissionMonitorStateSchema.parse(await requestController(`/api/v1/project-admission-monitor${query}`, { signal }));
}
