#!/usr/bin/env node
// Opt-in local Kubernetes regression. No external model probes or secret output.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.env.GUARD_TOPIC_ALLOW_WRITES, '1');
const lifecycle = process.argv.includes('--lifecycle');
const namespace = lifecycle ? 'tali-topic-e2e' : 'tali';
const release = lifecycle ? 'tali-topic-e2e' : 'tali-guard';
const controller = lifecycle ? 'http://localhost:38181' : 'http://localhost:38081';
const runner = 'http://localhost:38182';
const endpoint = `http://topic-control-mock.${namespace}.svc.cluster.local:8098/v1`;
const modelName = 'mock/nemoguard-topic-control';
const target = 'topic_control.input';
const runId = process.env.GUARD_TOPIC_RUN_ID;
if (lifecycle) assert.match(runId ?? '', /^[a-zA-Z0-9_-]+$/, 'Supply a stable, explicit regression run ID.');
const report = (stage, detail = {}) => console.log(JSON.stringify({ stage, namespace, ...detail }));
const secret = (name) => {
  const raw = JSON.parse(execFileSync('kubectl', ['--context', 'orbstack', '-n', namespace, 'get', 'secret', name, '-o', 'json'], { encoding: 'utf8' }));
  return Object.fromEntries(Object.entries(raw.data).map(([k, v]) => [k, Buffer.from(v, 'base64').toString()]));
};
let cookie = '';
async function call(path, { body, method, expected = 200, base = controller, headers = {} } = {}) {
  const response = await fetch(base + path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', origin: controller, ...(base === controller ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45_000),
  });
  const data = await response.json();
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`);
  return { data, response };
}
async function until(label, read, ready) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await delay(1500);
  }
  throw Error(`Timed out: ${label}. Inspect retained test resources; do not bypass validation.`);
}
const credentials = secret(`${release}-bootstrap-admin`);
const auth = await call('/api/auth/sign-in/email', { body: { email: credentials.email, password: credentials.password } });
cookie = auth.response.headers.getSetCookie().map(x => x.split(';')[0]).join('; ');
assert(cookie);
const before = (await call('/api/v1/model-configuration')).data;
const otherAssignments = assignments => ({ controlPlane: assignments.controlPlane,
  bindings: Object.fromEntries(Object.entries(assignments.bindings).filter(([key]) => key !== target)) });
const prior = otherAssignments(before.draft.assignments);
if (lifecycle) {
  assert.equal(prior.controlPlane, null);
  assert(Object.values(prior.bindings).every(v => v === null), 'This isolated test must have no other model bindings.');
  assert(before.providers.every(p => p.baseUrl === endpoint), 'No external Provider may exist in the test release.');
}
const providers = before.providers.filter(p => p.baseUrl === endpoint);
assert(providers.length <= 1, 'Ambiguous Mock Provider.');
let model = providers.length ? before.models.find(m => m.providerId === providers[0].id && m.model === modelName) : null;
if (!model) {
  assert.equal(providers.length, 0, 'Existing Mock Provider has no matching Model; inspect before registering.');
  const result = (await call('/api/v1/model-providers/register', { expected: 201, body: {
    connection: { name: 'Topic Control — MOCK ONLY', kind: 'custom-openai-compatible', baseUrl: endpoint, apiKey: 'synthetic-mock-only', skipTlsVerify: false },
    models: [{ name: 'Topic Control — synthetic test only', model: modelName,
      profile: 'tali.nemoguard-topic-control.v1', timeoutSeconds: 5, maxTokens: 16 }],
  } })).data;
  model = result.models[0];
}
assert.equal(model.connectionStatus, 'validated', model.connectionMessage);
report('mock-model-callable', { modelId: model.id, endpoint });
if (before.draft.assignments.bindings[target] !== model.id) {
  await call(`/api/v1/model-configuration/draft/assignments/${target}`, { method: 'PUT', body: { modelId: model.id } });
}
const reusableActive = lifecycle && before.active?.validationReport?.valid
  && before.active.assignments.bindings[target] === model.id;
const checked = reusableActive ? before.active
  : (await call(`/api/v1/model-configuration/draft/assignments/${target}/validate`, { body: {} })).data;
assert.deepEqual(otherAssignments(checked.assignments), prior, 'Unrelated model assignments must remain unchanged.');
const probe = checked.validationReport.checks.find(c => c.id === `probe:${target}:${model.id}`);
assert.equal(probe?.status, 'passed', probe?.message);
assert.equal(probe.evidenceKind, 'nemo-rail-v1');
report('topic-rail-validated', { revisionId: checked.id, wholeDraftValid: checked.validationReport.valid, message: probe.message });
if (!lifecycle) {
  const after = (await call('/api/v1/model-configuration')).data;
  assert.deepEqual(after.active?.assignments, before.active?.assignments);
  assert.equal(after.active?.id, before.active?.id);
  report('main-configuration-preserved', { activeRevisionId: after.active?.id, topicSavedAndValidated: true, globallyActivated: false });
  process.exit(0);
}
assert(checked.validationReport.valid, 'The Mock-only revision must pass normally, without fabricated evidence.');
if (!reusableActive) await call(`/api/v1/model-configuration/${checked.id}/activate`, { body: {} });
const active = await until('model activation', async () => (await call('/api/v1/model-configuration')).data,
  d => d.active?.id === checked.id);
report('mock-configuration-active', { revisionId: active.active.id });
const token = secret(`${release}-control`)['runner-token'];
const existing = (await call('/api/v1/guardrails')).data.items;
const evidence = [];
// Public runtime represents redirect as transform + a safe replacement. The
// inherited validation contract uses "intervene" for the internal outcome.
for (const [scope, expected] of [['Product support', 'allow'], ['Cooking and recipes only', 'transform']]) {
  const name = `Regression ${runId} Topic ${scope}`;
  const matches = existing.filter(g => g.name === name);
  assert(matches.length <= 1);
  const draftConfig = { allowedTopics: [scope], restrictedTopics: [], safetyLevel: 'balanced', outputDelivery: 'full_buffered',
    policyBindings: [{ policyId: 'builtin-topic-safety', policyVersion: '1.0.0', action: null, parameterValues: {},
      enabledRuleIds: ['model/topic-control'], ruleOrder: [], ruleActions: {}, testCaseOverrides: {}, enabledRails: ['input'], reasoningPolicy: null }] };
  const created = matches[0] ?? (await call('/api/v1/guardrails', { expected: 201, body: { name, runtimeProfile: 'auto', draftConfig } })).data;
  const path = `/api/v1/guardrails/${created.id}`;
  const saved = (await call(path)).data;
  assert.deepEqual(saved.draftConfig.allowedTopics, [scope]);
  assert.deepEqual(saved.draftConfig.policyBindings, draftConfig.policyBindings);
  assert.deepEqual(saved.excludedTestCaseIds, []);
  assert.equal(saved.draftRevision, 1);
  const requested = saved.latestValidationRun?.status === 'passed' ? saved.latestValidationRun
    : (await call('/api/v1/validation-runs', { body: { guardrailId: created.id }, expected: 202 })).data;
  const validation = await until('inherited Topic validation', async () => (await call(`/api/v1/validation-runs/${requested.id}`)).data,
    d => ['passed', 'failed'].includes(d.status));
  assert.equal(validation.status, 'passed', JSON.stringify(validation.results));
  assert(validation.metrics.total > 0);
  assert.deepEqual(validation.excludedCaseIds, []);
  const publication = saved.versions.find(v => v.sourceDraftRevision === saved.draftRevision && v.status !== 'failed')
    ?? (await call(`${path}/publish`, { body: {}, expected: 202 })).data;
  const detail = await until('signed publication', async () => (await call(path)).data, d => {
    const v = d.versions.find(v => v.version === publication.version);
    assert.notEqual(v?.status, 'failed', v?.failureReason);
    return d.activeVersion === publication.version && v?.status === 'ready';
  });
  const version = detail.versions.find(v => v.version === publication.version);
  assert(version.artifact.signature);
  const steps = version.plan.steps.filter(s => s.capability === 'topic_control');
  assert(steps.some(s => Object.fromEntries(s.parameters).allowed_topics === scope));
  await until('Runner distribution', async () => (await call('/health/ready', { base: runner })).data,
    d => d.ready && d.controller_connected && d.desired_state_synchronized && d.applied_generation > publication.generation);
  const cases = [
    { phase: 'input', text: 'How can I reset my product password?', decision: expected, failure: false },
    { phase: 'input', text: 'Discuss a business subject that is not on the approved list.', decision: 'transform', failure: false },
    { phase: 'input', text: 'UNREGISTERED MOCK CASE 20260908', decision: 'block', failure: true },
    { phase: 'output', text: 'How can I reset my product password?', decision: 'allow', failure: false },
  ];
  for (const [index, test] of cases.entries()) {
    const verdict = (await call(`/internal/v1/guardrails/${created.id}/evaluate`, { base: runner,
      headers: { authorization: `Bearer ${token}` }, body: { guardrail_version: publication.version,
        phase: test.phase, texts: [test.text], call_id: `${runId}:${created.id}:${index}` } })).data;
    assert.equal(verdict.decision, test.decision, JSON.stringify(verdict));
    assert.equal(verdict.usage.fail_closed, test.failure);
    assert.equal(verdict.usage.model_invocations, test.phase === 'input' ? 1 : 0);
    assert.equal(verdict.guardrail_version, publication.version);
    assert(verdict.effective_release_id);
    if (test.decision === 'allow') assert(!verdict.texts.length || verdict.texts.join('') === test.text);
    if (test.decision === 'transform') {
      assert.equal(verdict.action, 'redirect');
      assert.equal(verdict.texts.join(''), 'I can help with topics inside the configured allowed topics.');
      assert(verdict.findings.some(f => f.verdict === 'unsafe' && f.policy_id === 'builtin-topic-safety'));
    }
    if (test.failure) assert(!verdict.findings.some(f => f.verdict === 'unsafe'), 'Infrastructure failure must not masquerade as a detected threat.');
  }
  const result = { scope, guardrailId: created.id, version: publication.version, artifactId: version.artifactId,
    checksum: version.artifact.checksum, inheritedCases: validation.metrics.total, runtimeCases: cases.length };
  evidence.push(result);
  report('topic-scope-published-and-replayed', result);
}
report('passed', { evidence, externalApiCallsFromThisHarness: 0, scope: 'Kubernetes Controller/database/compiler/signature/distribution/Runner/NeMo/TCP Mock; not semantic quality' });
