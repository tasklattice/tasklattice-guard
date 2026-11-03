import { tenantLoadLabStateSchema, type TenantLoadLabControl, type TenantLoadLabState } from "../../shared/tenant-load-lab.js";
import { ControllerError } from "../domain/errors.js";

/** Optional experiment service. No tenant credentials are accepted from the browser. */
export async function requestTenantLoadLab(
  baseUrl: string | null | undefined,
  command?: TenantLoadLabControl,
  transport: typeof fetch = fetch,
): Promise<TenantLoadLabState> {
  if (!baseUrl) throw new ControllerError("The local tenant load lab is not configured.", 503, "tenant_load_lab_unavailable");
  try {
    const response = await transport(new URL(command ? "/control" : "/state", baseUrl), {
      method: command ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(5_000),
      ...(command ? { headers: { "content-type": "application/json" }, body: JSON.stringify(command) } : {}),
    });
    if (!response.ok) throw new Error("Experiment service rejected the request.");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing experiment state.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 2_000_000) throw new Error("Experiment state exceeds the response limit.");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return tenantLoadLabStateSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    // Provider transport details and private workload configuration stay server-side.
    throw new ControllerError("The tenant load lab is unavailable. Check its local workload service.", 503, "tenant_load_lab_unavailable");
  }
}
