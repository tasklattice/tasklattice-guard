import {directorySearch,type PageQuery} from "./directory-query";
import type {DirectoryPage} from "../../shared/directory";
import { requestController } from "@/lib/controller-api";

export type ShareableResource = {
  resourceType: "policy" | "guardrail" | "endpoint" | "router" | "model";
  resourceId: string;
  name: string;
};
export type ProjectOption = { id: string; name: string };
export type ShareGrant = {
  id: string;
  resourceType: ShareableResource["resourceType"];
  resourceId: string;
  recipientProjectId: string;
  createdAt: string;
};
export type CreateShareInput = Pick<ShareGrant, "resourceType" | "resourceId" | "recipientProjectId">;

export const listProjects = (query:PageQuery={},signal?:AbortSignal) => requestController<DirectoryPage<ProjectOption>>(`/api/v1/account/share-recipients${directorySearch(query)}`,{signal});
export const listShareableResources = () => requestController<{ items: ShareableResource[] }>("/api/v1/account/shareable-resources");
export const listShares = () => requestController<{ items: ShareGrant[] }>("/api/v1/account/shares");
export const createShare = (input: CreateShareInput) => requestController<{ share: ShareGrant }>("/api/v1/account/shares", {
  method: "POST", body: JSON.stringify(input),
});
export const revokeShare = (id: string) => requestController<void>(`/api/v1/account/shares/${encodeURIComponent(id)}`, { method: "DELETE" });
