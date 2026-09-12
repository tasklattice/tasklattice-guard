import generatedDocument from "../../openapi/controller.openapi.json" with { type: "json" };

type Operation = { operationId: string; summary: string; description: string; tags: string[]; "x-token-permission"?: { module: string; access: string }; "x-account-role": string; [key: string]: unknown };
type ApiDocument = { openapi: string; info: { title: string; version: string; description: string }; paths: Record<string, Record<string, Operation>>; components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> }; [key: string]: unknown };
const document = generatedDocument as ApiDocument;
const tags = document.tags as Array<{ name: string; description: string; "x-product-area": string }>;
export const apiModules = tags.map(tag => tag.name);
const productAreas = [...new Set(tags.map(tag => tag["x-product-area"]))];

/** Filter the standard document, retaining every transitively referenced schema. */
export function openApiDocument(filter: { module?: string | undefined; operationId?: string | undefined } = {}): ApiDocument | null {
  if (!filter.module && !filter.operationId) return document;
  const paths = Object.fromEntries(Object.entries(document.paths).map(([path, methods]) => [path, Object.fromEntries(Object.entries(methods).filter(([, operation]) =>
    (!filter.module || operation.tags.some(tag => tag.toLowerCase() === filter.module!.toLowerCase())) && (!filter.operationId || operation.operationId === filter.operationId),
  ))] as const).filter(([, methods]) => Object.keys(methods).length));
  if (!Object.keys(paths).length) return null;
  const schemas: Record<string, unknown> = {};
  function includeReferences(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.$ref === "string" && record.$ref.startsWith("#/components/schemas/")) {
      const name = record.$ref.split("/")[3]!;
      if (!Object.hasOwn(schemas, name)) {
        schemas[name] = document.components.schemas[name];
        includeReferences(schemas[name]);
      }
    }
    for (const child of Object.values(record)) includeReferences(child);
  }
  includeReferences(paths);
  return { ...document, paths, components: { ...document.components, schemas } };
}
const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
export function apiReferenceHtml() {
  const sections = apiModules.map(module => `<section id="${escape(module)}"><h2>${escape(module)}</h2><p>${escape(tags.find(tag => tag.name === module)!.description)}</p><p><a href="/api/openapi.json?module=${encodeURIComponent(module)}">Download this module's OpenAPI document</a></p>${Object.entries(document.paths).flatMap(([path, methods]) => Object.entries(methods).filter(([, operation]) => operation.tags.includes(module)).map(([method, operation]) => `<details><summary><code>${method.toUpperCase()} ${escape(path)}</code> — ${escape(operation.summary)}</summary><p>${escape(operation.description)}</p><p><strong>Retry:</strong> ${escape(String(operation["x-retry-policy"]))}</p><p>Operation: <code>${escape(operation.operationId)}</code> · <a href="/api/openapi.json?operationId=${encodeURIComponent(operation.operationId)}">Complete request and response schemas</a></p><pre>${escape(JSON.stringify(operation, null, 2))}</pre></details>`)).join("")}</section>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>TaskLattice Guard API reference</title><style>body{font:16px/1.6 system-ui,sans-serif;margin:0;color:#17212b;background:#f6f7f9}main{max-width:1080px;margin:auto;padding:32px 24px}h1{font-size:32px;line-height:1.2}h2{margin-top:40px}a{color:#2458b8}nav{display:flex;flex-wrap:wrap;gap:8px 24px}nav a{padding:10px 0}details{background:white;border:1px solid #d8dee6;border-radius:6px;margin:12px 0;padding:12px 16px}summary{cursor:pointer;min-height:24px;padding:10px 0;overflow-wrap:anywhere}pre{padding:16px;background:#f1f3f6;overflow:auto;font-size:13px}code{font-family:ui-monospace,monospace}a:focus-visible,summary:focus-visible{outline:2px solid #2458b8;outline-offset:4px}</style></head><body><main><h1>TaskLattice Guard API reference</h1><p>OpenAPI ${escape(document.openapi)} · Controller ${escape(document.info.version)} · ${Object.values(document.paths).reduce((count, methods) => count + Object.keys(methods).length, 0)} operations</p><p>Generated from application code. Requests, responses and permissions are available as a standard document.</p><p><a href="/api/openapi.json">Download full OpenAPI JSON</a> · <a href="/api/llms.txt">Compact index for API agents</a></p><p>Use <code>Authorization: Bearer &lt;token&gt;</code>. Token management requires a browser session. A 202 response acknowledges processing; check the resource before assuming it is active. Domain validation may apply beyond JSON Schema.</p><nav aria-label="API modules">${productAreas.map(area => `<div><strong>${escape(area)}</strong><br>${tags.filter(tag => tag["x-product-area"] === area).map(tag => `<a href="#${escape(tag.name)}">${escape(tag.name)}</a>`).join(" · ")}</div>`).join("")}</nav>${sections}</main></body></html>`;
}
export function apiAgentIndex() {
  return `# TaskLattice Guard Controller API\n\nOpenAPI 3.1: /api/openapi.json\nHuman reference: /api/docs\n\nRead the relevant operation schema before sending a request. Fetch /api/openapi.json?module=routers or /api/openapi.json?operationId=getRouters to limit context. Each filtered result is a complete OpenAPI document with its referenced schemas.\n\nAuthentication: Authorization: Bearer <personal-access-token>. Never put credentials in URLs. Browser-session-only operations cannot be called using a personal token. Write requires both the module grant and a current admin account. A 202 response is not proof of successful deployment. Inspect the returned state and poll the resource or validation result. Do not blindly retry writes after timeouts; compare state first.\n\n${Object.entries(document.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, operation]) => `- ${operation.operationId}: ${method.toUpperCase()} ${path} — ${operation.summary}; ${operation["x-token-permission"] ? `${operation["x-token-permission"].module}:${operation["x-token-permission"].access}` : operation.tags.includes("access-tokens") && path !== "/api/v1/account/identity" ? "browser session only" : path === "/api/v1/account/identity" ? "token or session" : "public"}; idempotency: ${(operation["x-idempotency"] as { mode?: string } | undefined)?.mode ?? "unspecified"}`)).join("\n")}\n`;
}
