import { requestController } from "./controller-api";
import type { AccessTokenView, CreateAccessToken } from "../../shared/access-tokens";
export type { AccessTokenView, CreateAccessToken } from "../../shared/access-tokens";
const path = "/api/v1/account/access-tokens";
export const listAccessTokens = () => requestController<{ items: AccessTokenView[] }>(path);
export const createAccessToken = (input: CreateAccessToken) => requestController<{ token: AccessTokenView; secret: string }>(path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
});
export const revokeAccessToken = (id: string) => requestController<void>(`${path}/${encodeURIComponent(id)}`, { method: "DELETE" });
