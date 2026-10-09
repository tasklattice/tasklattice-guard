#!/usr/bin/env node
/** Wire the test LiteLLM gateway to a local Guard release: Endpoint + Router + Secret. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
const env = process.env;
const controller = new URL(env.GUARD_DEV_CONTROLLER_URL ?? "http://localhost:38081");
const runtime = new URL(env.GUARD_DEV_RUNTIME_URL ?? "http://localhost:38082");
const email = env.GUARD_DEV_ADMIN_EMAIL ?? "admin@tasklattice.local";
const password = env.GUARD_DEV_ADMIN_PASSWORD ?? "password";
const namespace = env.HELM_NAMESPACE ?? "tali";
const context = env.HELM_CONTEXT ?? "orbstack";
const guardRelease = env.GUARD_DEV_RELEASE_NAME ?? "tali-guard";
const secretName = env.LITELLM_GUARD_SECRET ?? "tali-litellm-dev-guard";
const resourceName = env.LITELLM_GUARD_RESOURCE_NAME ?? "litellm-dev";
const guardrailId = env.LITELLM_GUARD_GUARDRAIL_ID ?? "guardrail-default";
let cookie = "";
const log = (stage, value = {}) => console.error(JSON.stringify({ stage, ...value }));

async function api(path, body, expected = 200, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(new URL(path, controller), {
    method, headers: { "content-type": "application/json", origin: controller.origin, cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  const result = response.status === 204 ? null : await response.json();
  if (response.status !== expected) throw new Error(`${method} ${path}: HTTP ${response.status} ${JSON.stringify(result)}`);
  return { result, response };
}

async function signIn() {
  const auth = await api("/api/auth/sign-in/email", { email, password });
  cookie = auth.response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
}

async function ensureEndpoint() {
  const existing = (await api("/api/v1/endpoints")).result.items.find((item) => item.name === resourceName && item.status !== "disabled");
  if (!existing) {
    const created = (await api("/api/v1/endpoints", { name: resourceName, adapter: "litellm-generic-guardrail" }, 201)).result;
    log("endpoint-created", { endpointId: created.id });
    return created;
  }
  // Re-runs keep the Endpoint and issue a fresh credential; older credentials
  // stay valid so a running gateway is not cut off mid-rotation.
  const rotated = (await api(`/api/v1/endpoints/${existing.id}/credentials`, {}, 201)).result;
  log("endpoint-credential-rotated", { endpointId: existing.id });
  return rotated;
}

async function ensureRouter(endpointId, version) {
  const draft = { routes: [{
    id: "default-fallback", name: "Default Guardrail", kind: "fallback", enabled: true,
    selector: { expression: { combinator: "and", conditions: [] } },
    targets: [{ id: "default-target", guardrailId, guardrailVersion: version, weightBps: 10000 }],
  }] };
  // The Controller normalizes key order, so compare the routing facts instead.
  const sameDraft = (stored) => stored?.routes?.length === 1 && stored.routes[0].kind === "fallback" && stored.routes[0].enabled
    && stored.routes[0].selector?.expression?.conditions?.length === 0 && stored.routes[0].targets?.length === 1
    && stored.routes[0].targets[0].guardrailId === guardrailId && stored.routes[0].targets[0].guardrailVersion === version
    && stored.routes[0].targets[0].weightBps === 10000;
  let router = (await api("/api/v1/routers")).result.items.find((item) => item.name === resourceName);
  if (!router) {
    router = (await api("/api/v1/routers", { name: resourceName, description: "LiteLLM integration test stack", endpointIds: [endpointId], draft }, 201)).result;
    log("router-created", { routerId: router.id });
  } else if (!sameDraft(router.draft)) {
    router = (await api(`/api/v1/routers/${router.id}/draft`, { expectedDraftRevision: router.draftRevision, draft }, 200, "PUT")).result;
    log("router-draft-updated", { routerId: router.id, draftRevision: router.draftRevision });
  }
  if (!router.endpointIds?.includes(endpointId)) {
    await api(`/api/v1/routers/${router.id}/endpoints`, { endpointIds: [...new Set([...(router.endpointIds ?? []), endpointId])] }, 200, "PUT");
    log("router-endpoint-bound", { routerId: router.id, endpointId });
  }
  router = (await api(`/api/v1/routers/${router.id}`)).result;
  if (!router.activeRevision || router.activeDraftRevision !== router.draftRevision) {
    // The dev stack has a single administrator, so it applies its own change
    // through the audited emergency path instead of waiting for a second approver.
    let change = router.pendingChangeRequest;
    if (!change) {
      const review = (await api(`/api/v1/routers/${router.id}/publication-preview`, { expectedDraftRevision: router.draftRevision })).result;
      change = (await api(`/api/v1/routers/${router.id}/change-requests`, { expectedDraftRevision: review.draftRevision, reviewedSnapshot: review.snapshot,
        reviewedEndpointIds: review.endpointIds, reason: "LiteLLM integration test stack wiring" }, 201)).result;
    }
    const published = (await api(`/api/v1/routers/${router.id}/change-requests/${change.id}/emergency-apply`, { reason: "Automated LiteLLM dev stack wiring" }, 202)).result;
    log("router-published", { routerId: router.id, changeRequestId: change.id, rolloutStatus: published.rolloutStatus ?? null });
  }
  return router;
}

async function waitForRunner(endpointId, credential) {
  const verifyUrl = new URL(`/runtime/v1/endpoints/${endpointId}/verify`, runtime);
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const check = await fetch(verifyUrl, { method: "POST", headers: { "x-api-key": credential, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5_000) });
      if (check.ok && (await check.json()).ready) return;
    } catch { /* Runner may still be converging. */ }
    await delay(1_000);
  }
  throw new Error("Runner did not verify the Endpoint credential within 90 seconds.");
}

async function writeSecret(apiBase, apiKey) {
  const cluster = ["--context", context, "--namespace", namespace];
  const manifest = await exec("kubectl", [...cluster, "create", "secret", "generic", secretName,
    `--from-literal=api-base=${apiBase}`, `--from-literal=api-key=${apiKey}`, "--dry-run=client", "-o", "yaml"]);
  await new Promise((resolve, reject) => {
    const child = execFile("kubectl", [...cluster, "apply", "-f", "-"], (error) => error ? reject(error) : resolve());
    child.stdin.end(manifest.stdout);
  });
}

try {
  await signIn();
  // Routes pin an exact version: LITELLM_GUARD_GUARDRAIL_VERSION, or for the
  // Default Guardrail the version serving as the runtime baseline.
  const version = env.LITELLM_GUARD_GUARDRAIL_VERSION
    ?? (guardrailId === "guardrail-default" ? (await api("/api/v1/system/baseline")).result.version : null);
  const guardrail = (await api(`/api/v1/guardrails/${guardrailId}`)).result;
  if (!version || !guardrail.versions.some((item) => item.version === version && item.status === "ready")) {
    throw new Error(`Guardrail ${guardrailId} has no ready baseline version yet. Deploy tali-guard and wait for the Default Guardrail to become active.`);
  }
  const endpoint = await ensureEndpoint();
  if (!endpoint.credential) throw new Error("Endpoint did not return a one-time credential.");
  const router = await ensureRouter(endpoint.id, version);
  await waitForRunner(endpoint.id, endpoint.credential);
  const apiBase = `http://${guardRelease}-runtime.${namespace}.svc.cluster.local:8091/runtime/v1/endpoints/${endpoint.id}`;
  await writeSecret(apiBase, endpoint.credential);
  log("secret-written", { secret: secretName, namespace });
  console.log(JSON.stringify({ endpointId: endpoint.id, routerId: router.id, guardrailId, guardrailVersion: version, apiBase, secret: secretName }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
