#!/usr/bin/env node
/** Opt-in real HTTP/DB/NeMo lifecycle regression. Creates isolated named records;
 * never changes Default, existing Policies, routers, or model credentials. */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const required = (key) => { assert(process.env[key], `Set ${key}`); return process.env[key]; };
assert.equal(required("GUARD_REGRESSION_ALLOW_WRITES"), "1");
const controller = new URL(required("GUARD_REGRESSION_CONTROLLER_URL"));
const runner = new URL(required("GUARD_REGRESSION_RUNNER_URL"));
for (const url of [controller, runner]) assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Use isolated loopback endpoints.");
const origin = required("GUARD_REGRESSION_ORIGIN");
const runId = process.env.GUARD_REGRESSION_RUN_ID ?? new Date().toISOString().replaceAll(/[:.]/g, "-");
const token = required("GUARD_REGRESSION_RUNNER_TOKEN");
let cookie = "";
const report = (stage, detail = {}) => console.log(JSON.stringify({ runId, stage, ...detail }));
async function call(base, path, { body, method = body === undefined ? "GET" : "POST", expected = 200 } = {}) {
  const response = await fetch(new URL(path, base), { method,
    headers: { "content-type": "application/json", origin, ...(base === controller ? { cookie } : { authorization: `Bearer ${token}` }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  const result = await response.json();
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(result)}`);
  return { result, response };
}
async function until(label, read, ready) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) { const result = await read(); if (ready(result)) return result; await delay(1000); }
  throw new Error(`Timed out: ${label}; inspect retained regression resources.`);
}
const auth = await call(controller, "/api/auth/sign-in/email", { body: {
  email: required("GUARD_REGRESSION_EMAIL"), password: required("GUARD_REGRESSION_PASSWORD") } });
cookie = auth.response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
assert(cookie);

const phases = ["input", "output"];
// The opt-in variant intentionally uses Flow names as business content. A
// whole-source textual namespace replacement would silently bypass both rules.
const symbolMarkers = process.env.GUARD_REGRESSION_SYMBOL_MARKERS === "1";
const legacy = symbolMarkers ? "input_version_1" : "PINNED_LEGACY_TOKEN";
const current = symbolMarkers ? "output_version_2" : "PINNED_CURRENT_TOKEN";
function draft(version) {
  const marker = version === 1 ? legacy : current;
  const action = version === 1 ? "redact" : "reject";
  const flows = phases.map(phase => `${phase}_version_${version}`);
  return { guardrail_category: "content_safety", colang_version: "2.x",
    sources: [{ path: "checks.co", content: flows.map(flow => `flow ${flow} $text\n  if $text == "${marker}"\n    $r = await GuardRecordPolicyAction(flow_name="${flow}", safe=False, text=$text, replacement="[version-${version}]")\n  else\n    $r = await GuardRecordPolicyAction(flow_name="${flow}", safe=True, text=$text)\n`).join("\n") }],
    parameter_schema: version === 1 ? [{ name: "legacy_label", kind: "string", required: true, default: "legacy", description: "Version one parameter" }] : [],
    rail_bindings: phases.map((phase, index) => ({ rail_type: phase, flow_name: flows[index], execution_mode: "mutate", on_unsafe: action })),
    action_references: [{ name: "GuardRecordPolicyAction", version: "1.0.0" }],
    execution_contract: [["output_delivery", "full_buffered"]],
    test_cases: phases.flatMap((phase, index) => [legacy, current].map((text, sample) => ({
      id: `${phase}-v${version}-${sample}`, name: `${phase} version ${version} sample ${sample}`, rail_type: phase, content: text,
      expected_decision: text === marker ? version === 1 ? "transform" : "block" : "allow",
      covered_rule_ids: [`flow/${phase}/${flows[index]}`], case_type: `${phase}_rail`,
      target_source: phase === "output" ? "model_output" : "user_input",
    }))),
  };
}
const resumeId = process.env.GUARD_REGRESSION_POLICY_ID;
const created = resumeId ? (await call(controller, `/api/v1/policies/${encodeURIComponent(resumeId)}`)).result
  : (await call(controller, "/api/v1/policies", { expected: 201,
    body: { name: `Pinned regression ${runId} v1`, description: "Isolated version-boundary regression", owner: "regression", draft: draft(1) } })).result;
if (resumeId) {
  assert.equal(created.name, `Pinned regression ${runId} v1`, "Resume only this run's unmodified v1 fixture.");
  assert.equal(created.owner, "regression");
  assert.equal(created.version, "1");
  assert.equal(created.implementation_detail.draft_revision, 1);
}
const policyPath = `/api/v1/policies/${created.id}`;
report(resumeId ? "policy-resumed" : "policy-created", { policyId: created.id });
async function publishPolicy(version) {
  await call(controller, `${policyPath}/validation-runs`, { body: {}, expected: 202 });
  const validation = await until("Policy validation", async () => (await call(controller, `${policyPath}/validation-runs/latest`)).result,
    value => ["passed", "failed"].includes(value.status));
  assert.equal(validation.status, "passed", JSON.stringify(validation));
  const snapshot = (await call(controller, `${policyPath}/publish`, { body: {}, expected: 201 })).result;
  assert.equal(snapshot.version, String(version));
  report("policy-published", { policyId: created.id, version: snapshot.version, validationId: validation.id });
  return snapshot;
}
const first = resumeId ? created.implementation_detail.versions.find(item => item.version === "1") : await publishPolicy(1);
assert(first);
const binding = { policyId: created.id, policyVersion: "1", enabledRails: phases,
  enabledRuleIds: ["flow/input/input_version_1", "flow/output/output_version_1"], parameterValues: { legacy_label: "legacy" } };
const guardrail = (await call(controller, "/api/v1/guardrails", { expected: 201, body: {
  name: `Pinned regression ${runId}`, runtimeProfile: "auto",
  draftConfig: { policyBindings: [binding], outputDelivery: "full_buffered" },
} })).result;
report("guardrail-created", { guardrailId: guardrail.id });
await call(controller, policyPath, { method: "PATCH", body: { name: `Pinned regression ${runId} v2`, draft: draft(2) } });
const second = await publishPolicy(2);
const catalog = (await call(controller, policyPath)).result;
assert.equal(catalog.version, "2");
assert.equal(catalog.parameters.length, 0);
const pinned = catalog.published_versions.find(item => item.version === "1");
assert.equal(pinned.parameters[0].name, "legacy_label");
assert.deepEqual(pinned.rules.map(rule => rule.id), ["flow/input/input_version_1", "flow/output/output_version_1"]);
assert.deepEqual(catalog.implementation_detail.versions.find(item => item.version === "1"), first);
assert.notEqual(first.checksum, second.checksum);

const guardrailPath = `/api/v1/guardrails/${guardrail.id}`;
// Save an edit after version 2 exists, without changing the Policy binding.
await call(controller, guardrailPath, { method: "PATCH", body: { name: `Pinned regression ${runId} edited`, draftConfig: {
  policyBindings: [binding], outputDelivery: "full_buffered" },
} });
const saved = (await call(controller, guardrailPath)).result;
assert.equal(saved.draftConfig.policyBindings[0].policyVersion, "1");
const request = (await call(controller, "/api/v1/validation-runs", { expected: 202, body: { guardrailId: guardrail.id } })).result;
const validation = await until("Guardrail validation", async () => (await call(controller, `/api/v1/validation-runs/${request.id}`)).result,
  value => ["passed", "failed"].includes(value.status));
assert.equal(validation.status, "passed", JSON.stringify(validation));
assert.equal(validation.metrics.total, 4);
assert(validation.results.every(item => item.modelInvocations === 0 && !item.actualFailure));
assert.deepEqual(validation.excludedCaseIds, []);
const publication = (await call(controller, `${guardrailPath}/publish`, { expected: 202, body: {} })).result;
const detail = await until("Guardrail publication", async () => (await call(controller, guardrailPath)).result, value => {
  const version = value.versions.find(item => item.version === publication.version);
  assert.notEqual(version?.status, "failed", version?.failureReason);
  return value.activeVersion === publication.version && version?.status === "ready";
});
const release = detail.versions.find(item => item.version === publication.version);
assert.equal(release.plan.policy_bindings[0].policy_version, "1");
assert.deepEqual(release.plan.policy_versions[0].sources, first.sources);
assert.equal(release.plan.policy_versions[0].checksum, first.checksum);
assert(release.artifact.signature);
await until("Runner convergence", async () => (await call(runner, "/health/ready")).result,
  value => value.ready && value.desired_state_synchronized && value.applied_generation >= publication.generation);
for (const phase of phases) for (const text of [legacy, current]) {
  const result = (await call(runner, `/internal/v1/guardrails/${guardrail.id}/evaluate`, { body: {
    guardrail_version: publication.version, phase, texts: [text], call_id: `${runId}:${phase}:${text}`,
  } })).result;
  assert.equal(result.decision, text === legacy ? "transform" : "allow", JSON.stringify(result));
  assert.equal(result.usage?.model_invocations, 0);
  assert.equal(result.guardrail_version, publication.version);
  if (text === legacy) assert.deepEqual(result.texts, ["[version-1]"]);
  else assert(!result.texts.length || result.texts.join("") === text);
}
report("passed", { policyId: created.id, guardrailId: guardrail.id, pinnedVersion: "1", latestPolicyVersion: "2",
  validationId: validation.id, guardrailVersion: publication.version, artifactId: release.artifactId, checksum: release.artifact.checksum,
  replayedCases: 4, modelInvocations: 0, symbolMarkers,
  scope: "real persisted custom Policy versions, draft edit, validation, signed compilation, distribution, Input/Output replay; not streaming or live-model quality" });
