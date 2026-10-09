import type { EndpointProtocol } from "@/lib/api-types";
import { parseHttpRequest } from "../../../shared/playground-path";

export type RequestHeader = {
  id: string;
  enabled: boolean;
  name: string;
  value: string;
};
export type RequestDraft = {
  method: string;
  url: string;
  headers: RequestHeader[];
  body: string;
};
export const newHeader = (name = "", value = ""): RequestHeader => ({
  id: crypto.randomUUID(),
  enabled: true,
  name,
  value,
});
export const routerRequest = (): RequestDraft => ({
  method: "POST",
  url: "https://api.example.com/v1/chat",
  headers: [
    newHeader("Content-Type", "text/plain"),
    newHeader("X-Channel", "partner"),
  ],
  body: "Hello, can you help me?",
});
export function serializeRequest(request: RequestDraft): string {
  const headers = request.headers.filter(
    (h) => h.enabled && (h.name || h.value),
  );
  if (headers.some((h) => /[\r\n]/.test(h.name + h.value)))
    throw new Error("Headers must not contain newlines.");
  const source = `${request.method} ${request.url} HTTP/1.1\n${headers.map((h) => `${h.name}: ${h.value}`).join("\n")}${headers.length ? "\n" : ""}\n${request.body}`;
  parseHttpRequest(source);
  return source;
}
export function importRequest(source: string): RequestDraft {
  const request = parseHttpRequest(source);
  return {
    method: request.method,
    url: request.path,
    body: request.body,
    headers: Object.entries(request.headers).flatMap(([name, values]) =>
      values.map((value) => newHeader(name, value)),
    ),
  };
}
export function endpointRequest(id: string, protocol: EndpointProtocol): RequestDraft {
  if (protocol === "scan") return {
    method: "POST", url: "/backend/v1/scans",
    headers: [newHeader("Content-Type", "application/json")],
    body: JSON.stringify({ input: "Hello, can you help me?", scanDirection: "request", flagOnly: true, verbose: true }, null, 2),
  };
  if (protocol !== "litellm") throw new Error("Unsupported Endpoint protocol.");
  return {
    method: "POST",
    url: `/runtime/v1/endpoints/${encodeURIComponent(id)}/beta/litellm_basic_guardrail_api`,
    headers: [newHeader("Content-Type", "application/json")],
    body: JSON.stringify(
      { input_type: "request", texts: ["Hello, can you help me?"] },
      null,
      2,
    ),
  };
}
