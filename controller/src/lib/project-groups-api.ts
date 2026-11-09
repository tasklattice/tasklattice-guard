import { requestController } from "./controller-api";
import type { z } from "zod";
import type {
  groupModelConfigurationInput,
  GroupModelConfigurationView,
} from "../../shared/group-model-configuration";

export type { GroupModelConfigurationView } from "../../shared/group-model-configuration";

export type GroupRunnerPool = import("../../shared/project-groups").ProjectGroupPool & { connectedCount: number };
export const projectGroupsKey = ["resources", "project-groups"] as const;
const groupPath = (id: string) =>
  `/api/v1/project-groups/${encodeURIComponent(id)}`;
const poolPath = (id: string) =>
  `/api/v1/runner-pools/${encodeURIComponent(id)}`;
const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

export const updateRunnerPoolConnectivity = (
  id: string,
  input: { runtimeUrl: string | null; publicUrl: string | null },
) =>
  requestController<GroupRunnerPool>(
    `${poolPath(id)}/connectivity`,
    json("PUT", input),
  );
export const groupModelConfigurationKey = (id: string) =>
  [...projectGroupsKey, id, "models"] as const;
export const getGroupModelConfiguration = (id: string, signal?: AbortSignal) =>
  requestController<GroupModelConfigurationView>(
    `${groupPath(id)}/model-configuration`,
    { signal },
  );
export const updateGroupModelConfiguration = (
  id: string,
  input: z.infer<typeof groupModelConfigurationInput>,
) =>
  requestController<GroupModelConfigurationView>(
    `${groupPath(id)}/model-configuration`,
    json("PUT", input),
  );
