#!/usr/bin/env node
/** Replay the published isolated Default. Never modifies drafts or publishes. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const required = (key) => { assert(process.env[key], `Set ${key}.`); return process.env[key]; };
const controller = new URL(required("GUARD_REGRESSION_CONTROLLER_URL"));
const runner = new URL(required("GUARD_REGRESSION_RUNNER_URL"));
for (const url of [controller, runner]) assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Use isolated loopback endpoints.");
const origin = required("GUARD_REGRESSION_ORIGIN");
const runnerToken = required("GUARD_REGRESSION_RUNNER_TOKEN");
const runId = randomUUID();
let cookie = "";
async function call(base, path, body) {
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", origin,
      ...(base === controller ? { cookie } : { authorization: `Bearer ${runnerToken}` }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, `${path}: HTTP ${response.status}`);
  return { value: await response.json(), response };
}
const auth = await call(controller, "/api/auth/sign-in/email", {
  email: required("GUARD_REGRESSION_EMAIL"), password: required("GUARD_REGRESSION_PASSWORD"),
});
cookie = auth.response.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ");
assert(cookie);
const targetId = process.env.GUARD_REGRESSION_DEFAULT_COPY_ID ?? "guardrail-default";
const path = `/api/v1/guardrails/${encodeURIComponent(targetId)}`;
const rail = (await call(controller, path)).value;
if (targetId !== "guardrail-default") assert(rail.name.startsWith("Regression Default copy "), "Only a named isolated Default copy may be replayed here.");
const version = rail.versions.find((item) => item.version === rail.activeVersion);
assert(version?.status === "ready" && version.artifact.signature);
assert.equal(version.sourceDraftRevision, rail.draftRevision, "Publish the reviewed Default draft before replay.");
assert.equal(version.artifactId, rail.activeArtifactId);
assert(version.plan.steps.length > 0 && version.plan.steps.every(step => step.capability === "builtin_content_filter"),
  "Refuse to replay a Default with model-backed or unknown steps under the zero-external-call budget.");
assert.equal(rail.draftConfig.outputDelivery, "full_buffered");
assert.deepEqual(rail.excludedTestCaseIds, []);
assert.deepEqual(version.plan.policy_bindings.map((item) => [item.policy_id, item.policy_version]),
  rail.draftConfig.policyBindings.map((item) => [item.policyId, item.policyVersion]));
const ready = (await call(runner, "/health/ready")).value;
assert(ready.ready && ready.controller_connected && ready.desired_state_synchronized);
assert(ready.applied_generation >= version.generation);
const cases = (await call(controller, `/api/v1/test-cases?guardrailId=${encodeURIComponent(targetId)}`)).value.items;
assert(cases.length > 0 && cases.every((item) => !item.excluded));
let checked = 0, exactOutputs = 0;
const configChecksums = new Set();
async function replay(test) {
  const expected = test.expectationOverride ?? test;
  const verdict = (await call(runner, `/internal/v1/guardrails/${encodeURIComponent(targetId)}/evaluate`, {
    guardrail_version: version.version, phase: test.phase, texts: [test.content],
    call_id: `${runId}:${checked}`, messages: test.trustedInstruction ? [{ role: "system", content: test.trustedInstruction }] : [],
  })).value;
  const label = `${test.id ?? test.caseId ?? checked} (${test.phase})`;
  assert.equal(verdict.guardrail_version, version.version, label);
  assert.equal(verdict.decision, expected.expectedDecision, label);
  assert.equal(verdict.usage?.model_invocations, 0, label);
  assert.equal(verdict.usage?.fail_closed, false, label);
  assert.match(verdict.usage.config_checksum, /^[a-f0-9]{64}$/);
  configChecksums.add(verdict.usage.config_checksum);
  const matches = verdict.findings.filter((item) => item.verdict === "unsafe" || item.verdict === "uncertain");
  for (const match of expected.expectedMatches ?? []) {
    assert(matches.some((item) => item.policy_id === match.policyId && item.rule_id === match.ruleId), label);
  }
  if (!test.expectationOverride && test.coveredRuleIds?.length) {
    const covered = matches.some((item) => item.policy_id === test.sourcePolicyId && test.coveredRuleIds.includes(item.rule_id));
    assert.equal(covered, expected.expectedDecision !== "allow", label);
  }
  if (expected.expectedOutputContent !== undefined) {
    assert.equal(verdict.texts.join(""), expected.expectedOutputContent, label);
    exactOutputs++;
  } else if (verdict.decision === "allow") {
    assert(!verdict.texts.length || verdict.texts.join("") === test.content, label);
  } else if (verdict.decision === "transform") {
    assert(verdict.texts.length && verdict.texts.join("") !== test.content, label);
  }
  if (test.assertFullOrder) assert.deepEqual(verdict.trace.filter((step) => step.kind === "action").map((step) => step.policy_id),
    version.plan.policy_bindings.filter((item) => item.enabled_rails.includes(test.phase)).map((item) => item.policy_id));
  checked++;
}
for (const test of cases) await replay(test);
console.log(JSON.stringify({ stage: "inherited-cases-passed", count: cases.length }));

const migration = JSON.parse(await readFile(new URL("../tests/fixtures/default-policy-migration.json", import.meta.url), "utf8"));
for (const test of migration.cases) await replay({ ...test,
  ...(test.expectedOutputContent === undefined ? {} : {
    expectedOutputContent: test.expectedOutputContent.replaceAll(/\[(visa|mastercard|amex|discover)_REDACTED\]/g, "[credit_card_REDACTED]"),
  }),
});
for (const phase of ["input", "output"]) {
  for (const content of ["How do I renew my passport?", "Explain how to redact personal information.", "Explain how this application works."])
    await replay({ phase, content, expectedDecision: "allow", assertFullOrder: true });
  for (const [content, expectedOutputContent] of [
    ["Passport: E12345678", "Passport: [passport_china_REDACTED]"],
    ["Passport: K1234567", "Passport: [passport_singapore_REDACTED]"],
    ["NRIC: S1234567D", "NRIC: [sg_nric_REDACTED]"],
    ["Email: alice@example.com", "Email: [email_REDACTED]"],
    ["Card: 4111 1111 1111 1111", "Card: [credit_card_REDACTED]"],
    ["TFN: 123 456 789", "TFN: [au_tfn_REDACTED]"],
  ]) await replay({ phase, content, expectedDecision: "transform", expectedOutputContent });
  for (const content of ["AKIA0000000000000000", "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"])
    await replay({ phase, content, expectedDecision: "block" });
}
const after = (await call(controller, path)).value;
assert.equal(after.draftRevision, rail.draftRevision);
assert.equal(after.activeArtifactId, rail.activeArtifactId);
assert.equal(configChecksums.size, 1, "All calls must execute the same compiled configuration.");
console.log(JSON.stringify({ stage: "passed", guardrailId: rail.id, draftRevision: rail.draftRevision,
  version: version.version, artifactId: version.artifactId, checksum: version.artifact.checksum,
  runtimeConfigChecksum: [...configChecksums][0], appliedGeneration: ready.applied_generation,
  inheritedCases: cases.length, frozenLegacyCases: migration.cases.length, checked, exactOutputs, modelInvocations: 0,
  scope: "real deployed Default artifact replay; not business-proxy, streaming or live-model quality" }));
