#!/usr/bin/env node
// Explicitly opt-in: real NVIDIA requests and writes only to local OrbStack.
// Run from controller/: POLICY_STUDIO_ALLOW_WRITES=1 node --import tsx ../scripts/regress_policy_studio_orbstack.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { parsePackage } from '../controller/server/domain/guardrail-package.ts';

assert.equal(process.env.POLICY_STUDIO_ALLOW_WRITES, '1', 'Explicit opt-in required.');
const root = fileURLToPath(new URL('../', import.meta.url));
const work = `${root}output/policy-studio-orbstack`;
mkdirSync(work, { recursive: true });
const reportPath = `${work}/acceptance.json`;
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath)) : { stages: {}, requests: [] };
if (report.failure) {
  report.previousFailures ??= [];
  report.previousFailures.push({ message: report.failure, failedTests: Object.fromEntries(Object.entries(report.stages).filter(([key, value]) => key.includes('test') && value.status === 'failed')) });
  delete report.failure;
}
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const secret = (namespace, name) => Object.fromEntries(Object.entries(JSON.parse(execFileSync('kubectl',
  ['--context', 'orbstack', '-n', namespace, 'get', 'secret', name, '-o', 'json'], { encoding: 'utf8' })).data)
  .map(([key, value]) => [key, Buffer.from(value, 'base64').toString()]));
const log = (stage, detail = {}) => console.log(JSON.stringify({ stage, ...detail }));
async function until(label, read, ready) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (ready(value)) return value;
    } catch (error) {
      if (!(error instanceof TypeError && error.message === 'fetch failed')) throw error;
    }
    await delay(1500);
  }
  throw Error(`Timed out: ${label}. Retained resources and evidence for diagnosis.`);
}
class Stack {
  constructor(name, port, runtimePort, release) {
    Object.assign(this, { name, base: `http://localhost:${port}`, runtime: `http://localhost:${runtimePort}`, release, cookie: '' });
  }
  async api(path, { body, method, expected = 200, form, binary = false } = {}) {
    const response = await fetch(this.base + path, { method: method ?? (body !== undefined || form ? 'POST' : 'GET'),
      headers: { Origin: this.base, Cookie: this.cookie, ...(form ? {} : { 'Content-Type': 'application/json' }) },
      ...(form ? { body: form } : body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(180_000) });
    if (path.includes('sign-in')) this.cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const value = binary && response.ok ? Buffer.from(await response.arrayBuffer()) : await response.json();
    assert([expected].flat().includes(response.status), `${this.name} ${path}: ${response.status} ${binary ? '' : JSON.stringify(value)}`);
    return value;
  }
  async login() { await this.api('/api/auth/sign-in/username', { body: { username: 'admin', password: process.env.POLICY_STUDIO_ADMIN_PASSWORD ?? 'password' } }); }
  async ready() { return until(`${this.name} Runner`, async () => (await fetch(this.runtime + '/health/ready')).json(), value => value.ready && value.controller_connected && value.desired_state_synchronized); }
  async upload(bytes) {
    const form = new FormData(); form.append('package', new Blob([bytes], { type: 'application/zip' }), 'policy-studio.guardrail.zip');
    return this.api('/api/v1/guardrail-packages', { form, expected: 201 });
  }
}
const source = new Stack('source', 38081, 38082, 'tali-guard');
const target = new Stack('target', 38581, 38582, 'tali-policy-import');
const definitions = Object.fromEntries(['grounding', 'formal'].map(kind => [kind, JSON.parse(readFileSync(`${root}tests/fixtures/policy-studio/${kind}.json`))]));
const context = { query: 'How long is the warranty?', grounding_sources: ['The product warranty lasts one year.'] };
const formalValidation = { policyId: 'warranty-duration', policyVersion: '1', confidenceThreshold: 0.8,
  query: context.query, validResponse: 'The warranty lasts one year.', invalidResponse: 'The warranty lasts ten years.' };

async function models(stack) {
  const key = `${stack.name}:models`;
  if (report.stages[key]) return;
  let view = await stack.api('/api/v1/model-configuration');
  const previous = view.active?.assignments;
  const env = parseEnv(readFileSync(`${root}.env`, 'utf8'));
  const namespace = stack.name === 'source' ? 'tali' : 'tali-policy-import';
  const credential = secret(namespace, 'formal-proof-credential')['api-key'];
  for (const [kind, binding, profile, baseUrl, apiKey] of [
    ['grounding', 'contextual_grounding.output', 'tali.grounding-judge.v1', 'https://integrate.api.nvidia.com/v1', env.MODEL_GUARDRAILS_NVIDIA_API_KEY_ENV_VAR],
    ['formal', 'automated_reasoning.output', 'tali.automated-reasoning.v1', `http://policy-formal-proof.${namespace}.svc.cluster.local:8093/evaluate`, credential],
  ]) {
    assert(apiKey, `Missing ${kind} service credential.`);
    view = await stack.api('/api/v1/model-configuration');
    const name = `Studio E2E ${kind} service${kind === 'formal' && stack.name === 'target' ? ' · independent' : ''}`;
    let provider = view.providers.find(item => item.name === name);
    if (!provider) provider = await stack.api('/api/v1/model-providers', { expected: 201,
      body: { name, kind: 'custom-openai-compatible', baseUrl, apiKey } });
    const modelName = kind === 'grounding' ? 'nvidia/nemotron-3.5-lightning-30b-a3b' : 'z3-integer-proof';
    let model = view.models.find(item => item.providerId === provider.id && item.profile === profile && item.model === modelName);
    if (!model) model = await stack.api('/api/v1/models', { expected: 201, body: { providerId: provider.id,
      name: `Studio E2E ${kind} Detector · online`, model: modelName,
      profile, timeoutSeconds: 60, maxTokens: 4096 } });
    if (view.active?.assignments.bindings[binding] === model.id && report.stages[`${stack.name}:${kind}:candidate`]?.status === 'passed' && report.stages[`${stack.name}:${kind}:candidate`]?.deadlineAligned) continue;
    const validation = await stack.api(`/api/v1/model-configuration/draft/assignments/${binding}/candidate-validations`, {
      expected: 201, body: { modelId: model.id, ...(kind === 'formal' ? { formalValidation } : {}) } });
    const check = validation.validationReport.checks.find(item => item.id === `probe:${binding}:${model.id}`);
    report.stages[`${stack.name}:${kind}:candidate`] = { ...check, deadlineAligned: true }; save();
    assert.equal(check.status, 'passed', JSON.stringify(check));
    if (view.active?.assignments.bindings[binding] === model.id) {
      log('active-model-revalidated', { stack: stack.name, kind, latencyMs: check.latencyMs });
      continue;
    }
    await stack.api(`/api/v1/model-configuration/draft/assignments/${binding}`, { method: 'PUT', body: { modelId: model.id, validationId: validation.validationId } });
    view = await stack.api('/api/v1/model-configuration');
    await stack.api('/api/v1/model-configuration/apply', { expected: [200, 202], body: {
      bindingIds: [binding], expectedDraftToken: view.draft.reviewToken, expectedActiveId: view.active?.id ?? null } });
    await until(`${binding} active`, () => stack.api('/api/v1/model-configuration'), value => value.active?.assignments.bindings[binding] === model.id);
    log('model-bound', { stack: stack.name, kind, modelId: model.id });
  }
  view = await stack.api('/api/v1/model-configuration');
  for (const [binding, modelId] of Object.entries(previous?.bindings ?? {})) {
    if (!['contextual_grounding.output', 'automated_reasoning.output'].includes(binding)) assert.equal(view.active.assignments.bindings[binding], modelId);
  }
  if (previous) assert.equal(view.active.assignments.controlPlane, previous.controlPlane);
  report.stages[key] = { activeId: view.active.id, assignments: view.active.assignments }; save();
}

async function authored(kind) {
  const stage = `source:${kind}:published`; if (report.stages[stage]) return report.stages[stage];
  const definition = definitions[kind]; const id = definition.metadata.id;
  const library = await source.api('/api/v1/policies');
  if (!library.items.some(policy => policy.id === id)) await source.api(`/api/v1/policies/${id}/definition`, {
    method: 'PUT', body: { definition, maintainer: 'OrbStack acceptance', expectedRevision: 0, create: true } });
  let resource = await source.api(`/api/v1/policies/${id}/definition`);
  if (!resource.published_version) {
    const run = await source.api(`/api/v1/policies/${id}/definition/test-runs`, { body: {}, expected: 202 });
    const done = await until('Policy test', () => source.api(`/api/v1/policies/${id}/definition/test-runs/${run.id}`), value => ['passed', 'failed'].includes(value.status));
    report.stages[`source:${kind}:policy-test`] = done; save();
    assert.equal(done.status, 'passed', JSON.stringify(done));
    await source.api(`/api/v1/policies/${id}/definition/publish`, { body: { expectedRevision: resource.revision }, expected: 201 });
    resource = await source.api(`/api/v1/policies/${id}/definition`);
  }
  const name = `Studio E2E · ${kind}`;
  const rails = await source.api('/api/v1/guardrails');
  let guard = rails.items.find(item => item.name === name);
  if (!guard) guard = await source.api('/api/v1/guardrails', { expected: 201, body: { name, runtimeProfile: 'auto', draftConfig: {
    allowedTopics: [], restrictedTopics: [], safetyLevel: 'balanced', outputDelivery: 'full_buffered',
    policyBindings: [{ policyId: id, policyVersion: resource.published_version, enabledRuleIds: definition.rules.map(rule => rule.id), enabledRails: ['output'] }] } } });
  const path = `/api/v1/guardrails/${guard.id}`;
  guard = await source.api(path);
  let version = guard.versions.find(item => item.status === 'ready' && item.sourceDraftRevision === guard.draftRevision);
  if (!version) {
    const run = await source.api(path + '/test-runs', { expected: 202, body: {} });
    log('guardrail-test-started', { kind, runId: run.id });
    const done = await until('Guardrail test', () => source.api(`/api/v1/test-runs/${run.id}`), value => ['passed', 'failed'].includes(value.status));
    report.stages[`source:${kind}:guardrail-test`] = done; save();
    assert.equal(done.status, 'passed', JSON.stringify({ id: done.id, metrics: done.metrics, failures: done.results.filter(item => !item.passed).map(item => ({ name: item.name, reason: item.reason, actualFailure: item.actualFailure })) }));
    assert.equal(done.metrics.total, 2); assert(done.results.every(item => item.modelInvocations === 1));
    version = await source.api(path + '/publish', { body: { expectedDraftRevision: guard.draftRevision }, expected: 201 });
    assert.equal(version.status, 'ready');
  }
  const detail = await source.api(path); version = detail.versions.find(item => item.version === version.version);
  const bytes = await source.api(`${path}/package?versions=${version.version}`, { binary: true });
  const parsed = parsePackage(bytes);
  assert.equal(parsed.policies.length, 1, 'Export must carry only the used Policy leaf.');
  assert.equal(parsed.versions.length, 1); assert.equal(parsed.versions[0].testSuite.length, 2);
  assert.equal(parsed.policies[0].id, id);
  assert.deepEqual(parsed.policies[0].definition.definition.rules, definition.rules);
  assert(parsed.versions[0].testSuite.every(test => test.query === context.query));
  if (kind === 'grounding') assert(parsed.versions[0].testSuite.every(test => test.groundingSources.length === 1));
  if (kind === 'formal') assert.equal(parsed.versions[0].content.plan.reasoning_policies[0].policy_id, 'warranty-duration');
  const filename = `${kind}.guardrail.zip`; writeFileSync(`${work}/${filename}`, bytes);
  const repeated = await source.api(`${path}/package?versions=${version.version}`, { binary: true });
  assert.deepEqual(parsePackage(repeated).versions[0].content, parsed.versions[0].content);
  report.stages[stage] = { guardrailId: guard.id, version: version.version, policyId: id, policyVersion: resource.published_version,
    checksum: version.artifact.checksum, signature: version.artifact.signature, package: filename, leaves: parsed.manifest.policies, cases: 2 };
  save(); log('source-published-and-exported', report.stages[stage]); return report.stages[stage];
}

async function imported(kind, data) {
  const stage = `target:${kind}:imported`; if (report.stages[stage]) return;
  const bytes = readFileSync(`${work}/${data.package}`);
  const progressKey = `target:${kind}:import-progress`;
  let progress = report.stages[progressKey];
  if (!progress) {
    const before = await target.api('/api/v1/policies');
    assert(!before.items.some(policy => policy.id === data.policyId), 'Cold import must start without the authored Policy leaf.');
    const preview = await target.upload(bytes);
    assert.deepEqual(preview.blockers, []); assert.equal(preview.policies[0].state, 'new');
    progress = report.stages[progressKey] = { packageId: preview.packageId, policyInitiallyAbsent: true }; save();
  }
  if (!progress.imported) {
    progress.imported = await target.api(`/api/v1/guardrail-packages/${progress.packageId}/imports`, { expected: 201, body: {} }); save();
  }
  const path = `/api/v1/guardrails/${data.guardrailId}`;
  let version = (await target.api(path)).versions.find(item => item.version === data.version);
  assert.equal(version.artifact.checksum, data.checksum);
  assert.notEqual(version.artifact.signature, data.signature, 'Each environment signs its own artifact.');
  if (!progress.rejectedBeforeValidation) {
    assert.equal(version.status, 'pending');
    const blocked = await target.api(`${path}/versions/${data.version}/release`, { body: {}, expected: 409 });
    progress.rejectedBeforeValidation = blocked.error.code; save();
  }
  let done = report.stages[`target:${kind}:version-test`];
  if (done?.status !== 'passed') {
    const run = await target.api(`${path}/versions/${data.version}/test-runs`, { body: {}, expected: 202 });
    assert.equal(run.subject, 'version');
    done = await until('Imported version test', () => target.api(`/api/v1/test-runs/${run.id}`), value => ['passed', 'failed'].includes(value.status));
    report.stages[`target:${kind}:version-test`] = done; save(); assert.equal(done.status, 'passed', JSON.stringify(done));
  }
  assert.equal(done.metrics.total, 2); assert(done.results.every(item => item.modelInvocations === 1));
  const released = await target.api(`${path}/versions/${data.version}/release`, { body: {} });
  assert.equal(released.status, 'ready'); assert.equal(released.validationRunId, done.id);
  const again = await target.upload(bytes);
  const repeated = await target.api(`/api/v1/guardrail-packages/${again.packageId}/imports`, { expected: 201, body: {} });
  assert.deepEqual(repeated.imported, []);
  const exported = parsePackage(await target.api(`${path}/package?versions=${data.version}`, { binary: true }));
  assert.deepEqual(exported.versions[0].content, parsePackage(bytes).versions[0].content);
  const resource = await target.api(`/api/v1/policies/${data.policyId}/definition`);
  assert.deepEqual(resource.definition.rules, definitions[kind].rules);
  report.stages[stage] = { imported: progress.imported, policyInitiallyAbsent: progress.policyInitiallyAbsent, validationId: done.id, rejectedBeforeValidation: progress.rejectedBeforeValidation,
    checksum: version.artifact.checksum, independentlySigned: true, repeatImportNoop: true, reexportMatches: true };
  save(); log('cold-import-tested-and-released', { kind, version: data.version });
}

async function requests(stack, kind, data) {
  const stage = `${stack.name}:${kind}:requests`; if (report.stages[stage]) return;
  const credentialPath = `${work}/${stack.name}-${kind}-endpoint.json`;
  let endpoint = existsSync(credentialPath) ? JSON.parse(readFileSync(credentialPath)) : null;
  if (!endpoint) {
    endpoint = await stack.api('/api/v1/endpoints', { expected: 201, body: { name: `Studio E2E ${kind} requests`, adapter: 'litellm-generic-guardrail' } });
    writeFileSync(credentialPath, JSON.stringify(endpoint), { mode: 0o600 });
  }
  const routers = (await stack.api('/api/v1/routers')).items;
  let router = routers.find(item => item.name === `Studio E2E ${kind} routing`);
  if (!router) router = await stack.api('/api/v1/routers', { expected: 201, body: { name: `Studio E2E ${kind} routing`, endpointIds: [endpoint.id], draft: { routes: [{
    id: 'fallback', name: 'Acceptance only', kind: 'fallback', enabled: true, selector: { expression: { combinator: 'and', conditions: [] } },
    targets: [{ id: 'target', guardrailId: data.guardrailId, guardrailVersion: data.version, weightBps: 10000 }] }] } } });
  if (!router.activeRevision) {
    const review = await stack.api(`/api/v1/routers/${router.id}/publication-preview`, { body: { expectedDraftRevision: router.draftRevision } });
    const change = await stack.api(`/api/v1/routers/${router.id}/change-requests`, { expected: 201, body: {
      expectedDraftRevision: router.draftRevision, reviewedSnapshot: review.snapshot, reviewedEndpointIds: review.endpointIds,
      reason: 'Operator-requested local Policy Studio end-to-end acceptance on a dedicated synthetic Endpoint.', ticket: 'POLICY-STUDIO-E2E' } });
    // Product-supported, audited single-admin publication; only this script's dedicated local Endpoint.
    await stack.api(`/api/v1/routers/${router.id}/change-requests/${change.id}/emergency-apply`, { expected: 202,
      body: { reason: 'Local OrbStack acceptance requested by the operator; synthetic requests only, no existing business Endpoint changed.' } });
  }
  const publishedRouter = await until('Router distribution', () => stack.api(`/api/v1/routers/${router.id}`), value => {
    assert.notEqual(value.rolloutStatus, 'failed', value.rolloutError);
    return value.rolloutStatus === 'active';
  });
  await until('Runner routing generation', async () => (await fetch(stack.runtime + '/health/ready')).json(),
    value => value.ready && value.applied_generation >= publishedRouter.desiredGeneration);
  for (const [text, expected] of [['The warranty lasts one year.', 'NONE'], ['The warranty lasts ten years.', 'BLOCKED']]) {
    const callId = `policy-studio-${randomUUID()}`;
    for (const input_type of ['request', 'response']) {
      const response = await fetch(`${stack.runtime}/runtime/v1/endpoints/${endpoint.id}/beta/litellm_basic_guardrail_api`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': endpoint.credential },
        body: JSON.stringify({ input_type, litellm_call_id: callId, texts: [input_type === 'request' ? context.query : text], guardrail_context: context }), signal: AbortSignal.timeout(90_000) });
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      assert.equal(value.action, input_type === 'request' ? 'NONE' : expected, JSON.stringify(value));
      const assignment = JSON.parse(response.headers.get('x-guard-route-assignment'));
      assert.equal(assignment.guardrailId, data.guardrailId); assert.equal(assignment.guardrailVersion, data.version);
      report.requests.push({ stack: stack.name, kind, callId, phase: input_type, status: response.status, result: value, assignment }); save();
    }
    const logs = await until('Runtime telemetry', () => stack.api(`/api/v1/telemetry/events?endpointId=${endpoint.id}&requestId=${encodeURIComponent(endpoint.id + ':' + callId)}&limit=20`), value => value.items?.some(item => item.direction === 'outgoing'));
    const event = await stack.api(`/api/v1/telemetry/events/${logs.items.find(item => item.direction === 'outgoing').id}`);
    report.stages[`${stack.name}:${kind}:${expected}:telemetry`] = event; save();
    assert.equal(event.metadata.executionStatus, 'complete', JSON.stringify(event));
    assert.equal(event.metadata.usage.model_invocations, 1);
    assert.equal(event.metadata.usage.fail_closed, false, 'A service failure must not pass as a successful BLOCKED result.');
    assert.equal(event.decision, expected === 'NONE' ? 'allow' : 'block');
    if (expected === 'BLOCKED') assert(event.metadata.findings.some(item => item.policyId === data.policyId && item.verdict === 'matched'));
  }
  report.stages[stage] = { endpointId: endpoint.id, routerId: router.id, cases: 2, passed: true }; save(); log('public-runtime-passed', { stack: stack.name, kind });
}

try {
  await source.login(); await target.login(); await source.ready(); await target.ready();
  await models(source); await models(target);
  for (const kind of ['grounding', 'formal']) {
    const data = await authored(kind);
    await requests(source, kind, data);
    await imported(kind, data);
    await requests(target, kind, data);
  }
  report.passed = true; delete report.failure; save(); log('passed', { requests: report.requests.length, reportPath });
} catch (error) { report.passed = false; report.failure = error.message; save(); console.error(error.stack); process.exitCode = 1; }
