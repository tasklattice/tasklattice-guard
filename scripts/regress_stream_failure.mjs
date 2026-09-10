#!/usr/bin/env node
/** Opt-in isolated real Policy -> validation -> artifact -> stream failure replay.
 * No mocked verdict: an unbound recording call or opt-in malformed Action call
 * causes a real NeMo failure on one synthetic marker. Never edits existing data.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const required = key => { assert(process.env[key], `Set ${key}`); return process.env[key]; };
assert.equal(required("GUARD_REGRESSION_ALLOW_WRITES"), "1");
const controller = new URL(required("GUARD_REGRESSION_CONTROLLER_URL"));
const runner = new URL(required("GUARD_REGRESSION_RUNNER_URL"));
for (const url of [controller, runner]) assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
const origin = required("GUARD_REGRESSION_ORIGIN");
const token = required("GUARD_REGRESSION_RUNNER_TOKEN");
const dispatchFailure = process.env.GUARD_REGRESSION_ACTION_DISPATCH_FAILURE === "1";
const runId = process.env.GUARD_REGRESSION_RUN_ID || randomUUID();
let cookie = "", credential = "";
const report = (stage, data = {}) => console.log(JSON.stringify({ runId, stage, ...data }));
async function call(base, path, body, expected = 200, endpoint = false) {
  const response = await fetch(new URL(path, base), { method: body === undefined ? "GET" : "POST",
    headers: { origin, "content-type": "application/json", ...(base === controller ? { cookie }
      : endpoint ? { "x-api-key": credential } : { authorization: `Bearer ${token}` }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, expected, `${path}: unexpected HTTP status`);
  return { response, data: await response.json() };
}
async function until(label, read, done) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) { const value = await read(); if (done(value)) return value; await delay(1000); }
  throw new Error(`Timed out: ${label}; retained regression records must be inspected before retry.`);
}
const auth = await call(controller, "/api/auth/sign-in/email", {
  email: required("GUARD_REGRESSION_EMAIL"), password: required("GUARD_REGRESSION_PASSWORD") });
cookie = auth.response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
assert(cookie);
const safe = "REGRESSION_SAFE_OUTPUT", blocked = "REGRESSION_BLOCK_OUTPUT", failed = "REGRESSION_DETECTOR_FAILURE";
const flow = "regression_output_check";
const failingCall = dispatchFailure
  ? `GuardRecordPolicyAction(flow_name="${flow}", text=$text)`
  : 'GuardRecordPolicyAction(flow_name="unbound_regression_check", safe=True, text=$text)';
const cases = [[safe, "allow", null], [blocked, "block", null], [failed, "block", "provider_failure"]];
async function publishFixture() {
const resumePolicy = process.env.GUARD_REGRESSION_POLICY_ID;
if (resumePolicy) required("GUARD_REGRESSION_RUN_ID");
const policy = resumePolicy ? (await call(controller, `/api/v1/policies/${encodeURIComponent(resumePolicy)}`)).data
  : (await call(controller, "/api/v1/policies", {
  name: `Regression stream failure ${runId}`, owner: "regression", description: "Synthetic isolated execution-failure boundary, not a business Policy.",
  draft: { guardrail_category: "content_safety", colang_version: "2.x",
    sources: [{ path: "checks.co", content: `flow ${flow} $text\n  if $text == "${failed}"\n    $r = await ${failingCall}\n  elif $text == "${blocked}"\n    $r = await GuardRecordPolicyAction(flow_name="${flow}", safe=False, text=$text)\n  else\n    $r = await GuardRecordPolicyAction(flow_name="${flow}", safe=True, text=$text)\n` }],
    rail_bindings: [{ rail_type: "output", flow_name: flow, execution_mode: "detect", on_unsafe: "reject" }],
    action_references: [{ name: "GuardRecordPolicyAction", version: "1.0.0" }],
    execution_contract: [["output_delivery", "full_buffered"]],
    test_cases: cases.map(([content, expected_decision, expected_failure], index) => ({
      id: `output-${index}`, name: `Output boundary ${index}`, rail_type: "output", content, expected_decision,
      expected_failure, covered_rule_ids: [`flow/output/${flow}`], case_type: expected_failure ?? "output_rail", target_source: "model_output",
    })),
  },
}, 201)).data;
if (resumePolicy) {
  assert.equal(policy.name, `Regression stream failure ${runId}`);
  assert.equal(policy.owner, "regression");
  assert.equal(policy.version, "0", "Resume only an unpublished fixture.");
  assert.equal(policy.implementation_detail.draft_revision, 1);
  assert.equal(policy.implementation_detail.versions.length, 0);
  assert(policy.implementation_detail.draft.sources[0].content.includes(failingCall));
}
const policyPath = `/api/v1/policies/${policy.id}`;
report(resumePolicy ? "policy-resumed" : "policy-created", { policyId: policy.id });
await call(controller, `${policyPath}/validation-runs`, {}, 202);
const policyValidation = await until("Policy validation", async () => (await call(controller, `${policyPath}/validation-runs/latest`)).data,
  value => ["passed", "failed"].includes(value.status));
assert.equal(policyValidation.status, "passed", JSON.stringify(policyValidation));
await call(controller, `${policyPath}/publish`, {}, 201);
const guardrail = (await call(controller, "/api/v1/guardrails", {
  name: `Regression stream failure ${runId}`, runtimeProfile: "auto", draftConfig: { outputDelivery: "full_buffered",
    policyBindings: [{ policyId: policy.id, policyVersion: "1", enabledRails: ["output"], enabledRuleIds: [`flow/output/${flow}`] }] },
}, 201)).data;
report("guardrail-created", { guardrailId: guardrail.id, policyValidationId: policyValidation.id });
const validationRequest = (await call(controller, "/api/v1/validation-runs", { guardrailId: guardrail.id }, 202)).data;
const validation = await until("Guardrail validation", async () => (await call(controller, `/api/v1/validation-runs/${validationRequest.id}`)).data,
  value => ["passed", "failed"].includes(value.status));
assert.equal(validation.status, "passed", JSON.stringify(validation));
assert.deepEqual(validation.excludedCaseIds, []);
assert.equal(validation.metrics.total, 3);
assert(validation.results.every(item => item.modelInvocations === 0));
const path = `/api/v1/guardrails/${guardrail.id}`;
const publication = (await call(controller, `${path}/publish`, {}, 202)).data;
const detail = await until("publication", async () => (await call(controller, path)).data,
  value => value.activeVersion === publication.version && value.versions.some(v => v.version === publication.version && v.status === "ready"));
const release = detail.versions.find(v => v.version === publication.version);
assert(release.artifact.signature);
return { policy, guardrail, validation, publication, release };
}
async function existingFixture(id) {
  const guardrail = (await call(controller, `/api/v1/guardrails/${encodeURIComponent(id)}`)).data;
  assert(guardrail.name.startsWith("Regression stream failure ") && guardrail.activeArtifactId,
    "Replay only a published stream-failure regression fixture.");
  const release = guardrail.versions.find(v => v.version === guardrail.activeVersion && v.status === "ready");
  assert(release?.artifact.signature && release.plan.policy_versions.length === 1);
  assert(release.plan.policy_versions[0].sources[0].content.includes(failingCall));
  const policy = { id: release.plan.policy_versions[0].policy_id };
  report("fixture-resumed", { guardrailId: id, policyId: policy.id, version: release.version });
  return { policy, guardrail, validation: { id: release.validationRunId ?? null }, publication: { version: release.version }, release };
}
const { policy, guardrail, validation, publication, release } = process.env.GUARD_REGRESSION_GUARDRAIL_ID
  ? await existingFixture(process.env.GUARD_REGRESSION_GUARDRAIL_ID) : await publishFixture();
const endpoint = (await call(controller, "/api/v1/endpoints", { name: `Regression stream failure ${runId}`, adapter: "generic-http-guard" }, 201)).data;
credential = endpoint.credential;
const router = (await call(controller, "/api/v1/routers", { name: `Regression stream failure ${runId}`, guardrailId: guardrail.id,
  endpointId: endpoint.id, poolId: "default", enabled: true, trafficScope: { combinator: "and", conditions: [] } }, 201)).data;
await until("endpoint convergence", async () => {
  // /verify is the LiteLLM credential probe, not a generic HTTP probe.
  const response = await fetch(new URL(`/runtime/v1/endpoints/${endpoint.id}/guardrails/evaluate`, runner), {
    method: "POST", headers: { "x-api-key": credential, "content-type": "application/json" },
    body: JSON.stringify({ phase: "output", texts: [safe], protocol: "http", call_id: randomUUID() }), signal: AbortSignal.timeout(15_000) });
  assert([200, 401, 404, 503].includes(response.status), `Unexpected convergence status ${response.status}`);
  if (!response.ok) return false;
  const result = await response.json();
  assert.equal(result.decision, "allow");
  return true;
}, Boolean);
for (const [text, expected, failure] of cases) {
  const verdict = (await call(runner, `/internal/v1/guardrails/${guardrail.id}/evaluate`, {
    guardrail_version: publication.version, phase: "output", texts: [text], call_id: randomUUID(),
  })).data;
  assert.equal(verdict.decision, expected);
  assert.equal(verdict.usage.fail_closed, Boolean(failure));
  assert.equal(verdict.usage.model_invocations, 0);
  if (failure && dispatchFailure) assert(verdict.reason.includes("GuardRecordOwnedPolicyAction"), verdict.reason);
  const streamId = randomUUID();
  const streamPath = `/runtime/v1/endpoints/${endpoint.id}/guardrails/output-stream`;
  const first = (await call(runner, streamPath, { stream_id: streamId, sequence: 0, text, final: false, protocol: "http" }, 200, true)).data;
  assert.equal(first.status, "buffering");
  assert.equal(first.released_text, "");
  const final = (await call(runner, streamPath, { stream_id: streamId, sequence: 1, text: "", final: true, protocol: "http" }, failure ? 502 : 200, true)).data;
  if (failure) { assert(!JSON.stringify(final).includes(text)); assert(!("released_text" in final)); }
  else { assert.equal(final.released_text, expected === "allow" ? text : ""); assert.equal(final.status, expected === "allow" ? "completed" : "blocked"); }
  report("case-passed", { scenario: text, expected, infrastructureFailure: Boolean(failure), streamHttpStatus: failure ? 502 : 200, modelInvocations: 0 });
}
report("passed", { dispatchFailure, policyId: policy.id, guardrailId: guardrail.id, version: publication.version, artifactId: release.artifactId,
  checksum: release.artifact.checksum, validationId: validation.id, endpointId: endpoint.id, routerId: router.id,
  scope: "real persisted Policy, NeMo action failure, signed artifact, runtime stream HTTP; no mocked model or detector" });
