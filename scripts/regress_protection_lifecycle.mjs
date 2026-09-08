#!/usr/bin/env node
/**
 * Opt-in, deployed lifecycle regression. Creates five named Guardrails in an
 * isolated Controller; never edits Default, existing drafts, or exclusions.
 * Real HTTP, database, validation, compiler, signing, distribution and runtime.
 * This is NOT a business-proxy/streaming or live-model quality regression.
 */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const required = (key) => {
  assert(process.env[key], `Set ${key}.`);
  return process.env[key];
};
assert.equal(required("GUARD_REGRESSION_ALLOW_WRITES"), "1", "Explicitly opt in to creating regression Guardrails.");
const controller = new URL(required("GUARD_REGRESSION_CONTROLLER_URL"));
const runner = new URL(required("GUARD_REGRESSION_RUNNER_URL"));
for (const url of [controller, runner]) {
  assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Use isolated loopback endpoints, not a production server.");
}
const origin = required("GUARD_REGRESSION_ORIGIN");
const email = required("GUARD_REGRESSION_EMAIL");
const password = required("GUARD_REGRESSION_PASSWORD");
const runnerToken = required("GUARD_REGRESSION_RUNNER_TOKEN");
const runId = process.env.GUARD_REGRESSION_RUN_ID ?? new Date().toISOString().replaceAll(/[:.]/g, "-");
let cookie = "";
const report = (stage, detail = {}) => console.log(JSON.stringify({ runId, stage, ...detail }));

async function call(base, path, { body, headers = {}, expected = 200 } = {}) {
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", origin, ...(base === controller ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(result)}`);
  return { result, response };
}

async function until(label, read, isReady) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (isReady(value)) return value;
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for ${label}; inspect the retained regression resources.`);
}

const auth = await call(controller, "/api/auth/sign-in/email", { body: { email, password } });
cookie = auth.response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
assert(cookie, "Authentication must return a session cookie.");
const presets = (await call(controller, "/api/v1/protection-presets")).result.items;
assert.deepEqual(presets.map((item) => item.id).sort(), [
  "banking-assistant", "common-baseline", "internet-customer-support", "securities-assistant", "singapore-financial-assistant",
]);
const existing = (await call(controller, "/api/v1/guardrails")).result.items;
const evidence = [];

for (const preset of presets) {
  const name = `Regression ${runId} ${preset.id}`;
  // Reusing an explicit run ID resumes the same resources after a failed run.
  const found = existing.filter((item) => item.name === name);
  assert(found.length <= 1, `Ambiguous regression Guardrail ${name}.`);
  const guardrail = found[0] ?? (await call(controller, "/api/v1/guardrails", {
    expected: 201,
    body: { name, runtimeProfile: "auto", draftConfig: {
      allowedTopics: [], restrictedTopics: [], policyBindings: preset.policyBindings,
      safetyLevel: "balanced", outputDelivery: "full_buffered",
    } },
  })).result;
  const path = `/api/v1/guardrails/${guardrail.id}`;
  const saved = (await call(controller, path)).result;
  assert.equal(saved.draftRevision, 1, "Do not reuse a modified regression draft.");
  assert.deepEqual(saved.draftConfig.policyBindings, preset.policyBindings, "Saved Policy order, versions and overrides must match the preset.");
  assert.deepEqual(saved.excludedTestCaseIds, []);
  report("created", { preset: preset.id, guardrailId: guardrail.id, policies: preset.policyBindings.length });

  // An interrupted HTTP replay must not create duplicate validation/compile
  // jobs when resuming the same explicitly named regression resources.
  const existingValidation = saved.latestValidationRun?.sourceDraftRevision === saved.draftRevision
    ? saved.latestValidationRun : null;
  const requested = existingValidation ?? (await call(controller, "/api/v1/validation-runs", {
    body: { guardrailId: guardrail.id }, expected: 202,
  })).result;
  const validation = await until("validation", async () => (await call(controller, `/api/v1/validation-runs/${requested.id}`)).result,
    (value) => ["passed", "failed"].includes(value.status));
  assert.equal(validation.status, "passed", JSON.stringify({ failure: validation.failureReason, cases: validation.results.filter((item) => !item.passed) }));
  assert(validation.metrics.total > 0);
  assert.equal(validation.metrics.passed, validation.metrics.total);
  assert.equal(validation.sourceDraftRevision, saved.draftRevision);
  assert.deepEqual(validation.excludedCaseIds, []);
  assert(validation.results.every((item) => item.modelInvocations === 0 && !item.actualFailure), "Local presets must not call safety models.");
  report("validated", { preset: preset.id, cases: validation.metrics.total, validationId: validation.id });

  const existingVersion = saved.versions.find((item) => item.sourceDraftRevision === saved.draftRevision
    && item.status !== "failed");
  const publication = existingVersion ?? (await call(controller, `${path}/publish`, { body: {}, expected: 202 })).result;
  const detail = await until("signed publication", async () => (await call(controller, path)).result, (value) => {
    const version = value.versions.find((item) => item.version === publication.version);
    assert.notEqual(version?.status, "failed", version?.failureReason ?? "Compilation failed.");
    return value.activeVersion === publication.version && version?.status === "ready";
  });
  const version = detail.versions.find((item) => item.version === publication.version);
  assert.equal(version.sourceDraftRevision, saved.draftRevision);
  assert.equal(version.artifactId, detail.activeArtifactId);
  assert.match(version.artifact.checksum, /^[a-f0-9]{64}$/);
  assert(version.artifact.signature, "Published artifacts must be signed.");
  assert.deepEqual(version.plan.policy_bindings.map((item) => [item.policy_id, item.policy_version]),
    preset.policyBindings.map((item) => [item.policyId, item.policyVersion]), "Compiled Policy order must match the saved draft.");
  const ready = await until("Runner verified/prewarmed generation", async () => (await call(runner, "/health/ready")).result,
    (value) => value.ready && value.controller_connected && value.desired_state_synchronized
      // A compile request is not yet the delivery of its finished artifact.
      && value.applied_generation >= publication.generation + (publication.status === "compiling" ? 1 : 0));

  const cases = (await call(controller, `/api/v1/test-cases?guardrailId=${guardrail.id}`)).result.items;
  assert.equal(cases.length, validation.metrics.total);
  for (const test of cases) {
    assert(!test.excluded);
    const verdict = (await call(runner, `/internal/v1/guardrails/${guardrail.id}/evaluate`, {
      headers: { authorization: `Bearer ${runnerToken}` },
      body: { guardrail_version: publication.version, phase: test.phase, texts: [test.content],
        call_id: `${runId}:${test.id}`, messages: test.trustedInstruction ? [{ role: "system", content: test.trustedInstruction }] : [] },
    })).result;
    assert.equal(verdict.guardrail_version, publication.version);
    assert.equal(verdict.decision, test.expectedDecision, `${preset.id}: ${test.name} (${test.phase}): ${JSON.stringify(verdict)}`);
    assert.equal(verdict.usage?.model_invocations, 0, "Deployed local replay unexpectedly called a model.");
    if (test.expectedDecision === "allow") assert(!verdict.texts.length || verdict.texts.join("") === test.content);
    if (test.expectedDecision === "transform") assert(verdict.texts.length && verdict.texts.join("") !== test.content);
  }
  const entry = { preset: preset.id, guardrailId: guardrail.id, validationId: validation.id,
    version: publication.version, artifactId: version.artifactId, checksum: version.artifact.checksum,
    appliedGeneration: ready.applied_generation, replayedCases: cases.length, modelInvocations: 0 };
  evidence.push(entry);
  report("published-and-replayed", entry);
}
report("passed", { presets: evidence.length, cases: evidence.reduce((sum, item) => sum + item.replayedCases, 0), evidence,
  scope: "real-controller-and-runner-http-lifecycle; not business-proxy, streaming or live-model quality" });
