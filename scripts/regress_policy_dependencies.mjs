#!/usr/bin/env node
/** Real Controller HTTP -> Default Runner compile/NeMo -> publication gate.
 * Opt-in loopback fixture only; no existing Policy or Guardrail is modified. */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const required = name => { assert(process.env[name], `Set ${name}`); return process.env[name]; };
assert.equal(required("GUARD_REGRESSION_ALLOW_WRITES"), "1");
const base = new URL(required("GUARD_REGRESSION_CONTROLLER_URL"));
assert(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname), "Use an isolated loopback Controller.");
const origin = required("GUARD_REGRESSION_ORIGIN");
let cookie = "";
async function call(path, body, expected = 200, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(new URL(path, base), {
    method, headers: { "content-type": "application/json", origin, cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(result)}`);
  return { result, response };
}
const auth = await call("/api/auth/sign-in/email", {
  email: required("GUARD_REGRESSION_EMAIL"), password: required("GUARD_REGRESSION_PASSWORD"),
});
cookie = auth.response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
assert(cookie);
const safeSource = 'flow check $text\n  # await MissingAction() is documentation only\n  $r = await GuardRecordPolicyAction(flow_name="check", safe=True, text=$text)\n';
const draft = {
  guardrail_category: "content_safety", protection_directory: "content_filters", colang_version: "2.x",
  sources: [{ path: "checks.co", content: safeSource }],
  rail_bindings: [{ rail_type: "input", flow_name: "check", execution_mode: "detect", on_unsafe: "block" }],
  action_references: [{ name: "GuardRecordPolicyAction", version: "1.0.0" }],
  test_cases: [{ name: "Ordinary content", rail_type: "input", content: "ordinary", expected_decision: "allow",
    covered_rule_ids: ["flow/input/check"], case_type: "input_rail", required: true }],
};
const created = (await call("/api/v1/policies", {
  name: `Dependency regression ${new Date().toISOString()}`, owner: "regression",
  description: "Isolated compiler declaration regression; not a production detector.", draft,
}, 201)).result;
const path = `/api/v1/policies/${created.id}`;
console.log(JSON.stringify({ stage: "created", policyId: created.id }));
async function validate() {
  await call(`${path}/test-runs`, {}, 202);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = (await call(`${path}/test-runs/latest`)).result;
    if (["passed", "failed"].includes(result.status)) return result;
    await delay(500);
  }
  throw new Error(`Validation timed out; inspect retained ${created.id}, do not create a duplicate.`);
}
for (const [label, source, error] of [
  ["unreferenced action", safeSource + "  if False\n    await GuardCustomerIdentifierAction(text=$text)\n", /unreferenced Action/],
  ["undefined flow", safeSource + "  if False\n    await missing\n", /undefined Flow/],
]) {
  await call(path, { draft: { ...draft, sources: [{ path: "checks.co", content: source }] } }, 200, "PATCH");
  const result = await validate();
  assert.equal(result.status, "failed");
  assert.match(JSON.stringify(result), error);
  await call(`${path}/publish`, {}, 409);
  console.log(JSON.stringify({ stage: "rejected", scenario: label, validationId: result.id }));
}
await call(path, { draft }, 200, "PATCH");
const result = await validate();
assert.equal(result.status, "passed", JSON.stringify(result));
const published = (await call(`${path}/publish`, {}, 201)).result;
assert.equal(published.version, "1");
assert.equal(published.protection_directory, "content_filters");
console.log(JSON.stringify({ stage: "recovered-and-published", policyId: created.id,
  validationId: result.id, version: published.version, checksum: published.checksum }));
