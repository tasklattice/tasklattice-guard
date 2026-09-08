#!/usr/bin/env node
// Run from controller/ with `node --import tsx ../scripts/release_default_orbstack.mjs`.
// Requires an exact pre-change backup and explicit authorization to publish Default.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PolicyCatalog } from '../controller/server/policy-catalog/catalog.ts';
import { defaultGuardrailDraft } from '../controller/server/domain/defaults.ts';
import { buildGuardrailPlan, normalizeGuardrailDraft } from '../controller/server/domain/guardrail-plan.ts';

assert.equal(process.env.GUARD_DEFAULT_PUBLISH, '1', 'Explicitly authorize publishing Default on OrbStack.');
assert(process.env.GUARD_DEFAULT_BACKUP, 'Supply the exact pre-change Default snapshot.');
const backup = JSON.parse(await readFile(process.env.GUARD_DEFAULT_BACKUP, 'utf8'));
assert.equal(backup.id, 'guardrail-default');
const base = 'http://localhost:38081';
const secret = JSON.parse(execFileSync('kubectl', ['--context', 'orbstack', '-n', 'tali', 'get', 'secret', 'tali-guard-bootstrap-admin', '-o', 'json'], { encoding: 'utf8' }));
const decode = key => Buffer.from(secret.data[key], 'base64').toString();
let cookie = '';
const report = (stage, data = {}) => console.log(JSON.stringify({ stage, ...data }));
async function call(path, body, method, expected = 200) {
  const r = await fetch(base + path, { method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { cookie, origin: base, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  const data = await r.json();
  assert.equal(r.status, expected, `${path}: ${JSON.stringify(data)}`);
  return { data, response: r };
}
async function until(read, done) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) { const data = await read(); if (done(data)) return data; await delay(1500); }
  throw Error('Timed out; inspect and resume the same revision instead of bypassing validation.');
}
const a = await call('/api/auth/sign-in/email', { email: decode('email'), password: decode('password') });
cookie = a.response.headers.getSetCookie().map(x => x.split(';')[0]).join('; ');
const path = '/api/v1/guardrails/guardrail-default';
const before = (await call(path)).data;
const modelBefore = (await call('/api/v1/model-configuration')).data;
const policies = PolicyCatalog.load(fileURLToPath(new URL('../runner/toolkit/policy_library/assets', import.meta.url))).list();
const desired = normalizeGuardrailDraft(defaultGuardrailDraft(policies));
const plan = buildGuardrailPlan({ guardrailId: 'guardrail-default', guardrailVersion: '20260908-000000.000Z', draft: desired, policies });
assert(plan.steps.length > 0 && plan.steps.every(step => step.capability === 'builtin_content_filter'));
assert.equal(desired.outputDelivery, 'full_buffered');
assert.deepEqual(before.excludedTestCaseIds, []);
if (!isDeepStrictEqual(normalizeGuardrailDraft(before.draftConfig), desired)) {
  assert.equal(before.draftRevision, backup.draftRevision, 'Draft changed since backup; do not overwrite it.');
  assert.deepEqual(before.draftConfig, backup.draftConfig);
  assert.equal(before.activeArtifactId, backup.activeArtifactId);
  await call(path, { draftConfig: desired }, 'PATCH');
}
const current = (await call(path)).data;
assert.deepEqual(normalizeGuardrailDraft(current.draftConfig), desired);
assert.deepEqual(current.excludedTestCaseIds, []);
report('default-draft-prepared', { draftRevision: current.draftRevision, policies: desired.policyBindings.length,
  outputDelivery: desired.outputDelivery, previousActiveVersion: before.activeVersion });
const previousRun = current.latestValidationRun;
const job = previousRun?.sourceDraftRevision === current.draftRevision && ['passed', 'queued', 'running'].includes(previousRun.status)
  ? previousRun : (await call('/api/v1/validation-runs', { guardrailId: 'guardrail-default' }, 'POST', 202)).data;
const validation = await until(async () => (await call(`/api/v1/validation-runs/${job.id}`)).data,
  d => ['passed', 'failed'].includes(d.status));
assert.equal(validation.status, 'passed', JSON.stringify({ reason: validation.failureReason, failures: validation.results.filter(x => !x.passed) }));
assert.equal(validation.sourceDraftRevision, current.draftRevision);
assert.equal(validation.metrics.total, 321, 'Reviewed Default acceptance contract changed; review before release.');
assert.equal(validation.metrics.passed, validation.metrics.total);
assert.deepEqual(validation.excludedCaseIds, []);
assert(validation.results.every(x => x.modelInvocations === 0 && !x.actualFailure));
report('default-validation-passed', { validationId: validation.id, cases: validation.metrics.total, modelInvocations: 0 });
const version = current.versions.find(v => v.sourceDraftRevision === current.draftRevision && v.status !== 'failed')
  ?? (await call(`${path}/publish`, {}, 'POST', 202)).data;
const published = await until(async () => (await call(path)).data, d => {
  const v = d.versions.find(v => v.version === version.version);
  assert.notEqual(v?.status, 'failed', v?.failureReason);
  return v?.status === 'ready' && d.activeVersion === version.version;
});
const result = published.versions.find(v => v.version === version.version);
assert(result.artifact.signature);
assert.equal(result.artifact.compilerVersion, 'tasklattice-nemo-config-v18-selected-policy-dependencies');
assert.deepEqual(normalizeGuardrailDraft(published.draftConfig), desired);
const modelAfter = (await call('/api/v1/model-configuration')).data;
assert.deepEqual(modelAfter.draft?.assignments, modelBefore.draft?.assignments);
assert.equal(modelAfter.active?.id, modelBefore.active?.id);
report('default-published', { draftRevision: published.draftRevision, version: result.version,
  artifactId: result.artifactId, checksum: result.artifact.checksum, generation: result.generation,
  compiler: result.artifact.compilerVersion, modelConfigurationUnchanged: true });
