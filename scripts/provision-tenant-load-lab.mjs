#!/usr/bin/env node
/** Dedicated three-tenant local-detector load fixtures. Native Node 24 only.
 * --self-test and --definition are offline. Live execution requires --execute.
 * Does not change Default, its shares, Runner capacity, or existing smoke fixtures.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const BLOCK_MARKER = 'LAB_BLOCK_MARKER';
export const TENANTS = ['tenantA', 'tenantB', 'tenantC'];
export function createDefinition(id = 'tenant-load-lab-offline') {
  const ruleId = 'block-lab-marker';
  return {
    schema_version: 1, kind: 'Policy',
    metadata: { id, name: 'Tenant load lab synthetic marker',
      description: 'Dedicated local load demonstration. Blocks only a synthetic marker; not a production safety policy.',
      version: '0', tags: [{ namespace: 'protection', value: 'content_filters', label: 'Words & content filters', source: 'declared' }],
      safety_level: 'balanced', output_delivery: 'full_buffered' },
    parameters: [],
    rules: [{ id: ruleId, name: 'Block synthetic load marker', description: 'Exact local keyword match for lab traffic only.',
      stages: ['input', 'output'], detector: { ref: 'text/keyword', version: '1.0.0',
        parameters: { detector_options: { terms: [BLOCK_MARKER] } } },
      on_match: { action: 'block' }, risk_level: 'medium', metadata: { taxonomy_ids: ['TALI-BUSINESS-POLICY'] } }],
    tests: ['input', 'output'].flatMap(phase => [
      { id: `marker-${phase}`, name: `Block synthetic marker on ${phase}`, description: '', phase,
        content: `Synthetic lab content ${BLOCK_MARKER}.`, expected_decision: 'block', covered_rule_ids: [ruleId],
        kind: 'rule_acceptance', scope: 'rule', required: true, parameter_names: [], group: 'Local load lab', expected_matched_rules: [ruleId] },
      { id: `benign-${phase}`, name: `Allow benign content on ${phase}`, description: '', phase,
        content: 'A plain synthetic lab request about application features.', expected_decision: 'allow', covered_rule_ids: [ruleId],
        kind: 'scenario', scope: 'rule', required: true, parameter_names: [], group: 'Local load lab', expected_matched_rules: [] },
    ]),
    execution: { mode: 'sequential', input: 'previous_output', stop_on: 'block' },
  };
}
export function guardrailDraft(policyId, policyVersion) {
  return { allowedTopics: [], restrictedTopics: [], topicControlMode: 'permissive', safetyLevel: 'balanced', outputDelivery: 'full_buffered',
    policyBindings: [{ policyId, policyVersion, action: null, parameterValues: {}, enabledRuleIds: ['block-lab-marker'],
      enabledRails: ['input', 'output'], ruleActions: {}, ruleOrder: [], testCaseOverrides: {}, reasoningPolicy: null }] };
}
export function routeDraft(guardrailId, guardrailVersion) {
  return { routes: [{ id: 'lab-fallback', name: 'Dedicated three-tenant load lab', kind: 'fallback', enabled: true,
    selector: { expression: { combinator: 'and', conditions: [] } },
    targets: [{ id: 'lab-target', guardrailId, guardrailVersion, weightBps: 10000 }] }] };
}

async function validateRepositoryFixtures() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const compiled = resolve(root, 'controller/dist-server');
  const modules = [
    'shared/policy-definition.js', 'shared/traffic-routing.js',
    'server/policy-studio/declarative.js', 'server/domain/guardrail-plan.js', 'server/domain/validation.js',
  ];
  if (!modules.every(path => existsSync(resolve(compiled, path)))) return {
    status: 'skipped', reason: 'Controller compiled modules unavailable; build Controller to enable real schema/compiler checks.',
  };
  const [definitions, routing, { DeclarativeCompiler }, planning, validation] = await Promise.all(
    modules.map(path => import(pathToFileURL(resolve(compiled, path)).href)),
  );
  const definition = definitions.policyDefinitionSchema.parse(createDefinition());
  assert.deepEqual(definitions.definitionIssues(definition), []);
  const compiler = new DeclarativeCompiler(resolve(root, 'runner/toolkit/policy_library/assets'));
  const policy = compiler.compile(definition);
  const draft = planning.normalizeGuardrailDraft(guardrailDraft(policy.id, policy.version));
  const plan = planning.buildGuardrailPlan({ guardrailId: 'load-lab-offline', guardrailVersion: '20261026-000000.000Z', draft, policies: [policy] });
  const cases = validation.generatedTestCases('load-lab-offline', draft, [policy]);
  const router = routing.routerDraftSchema.parse(routeDraft('load-lab-offline', '20261026-000000.000Z'));
  assert.deepEqual(routing.routingIssues(router, true), []);
  assert.equal(cases.length, 4);
  assert(plan.steps.length > 0 && plan.steps.every(step => step.capability === 'builtin_content_filter'));
  assert.equal(plan.policy_bindings.length, 1);
  return { status: 'passed', policySchema: true, compiler: true, localPlanSteps: plan.steps.length, frozenCases: cases.length, routerSchema: true };
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log(`Prepare dedicated real three-tenant load fixtures on the disposable loopback stack.
Native Node 24; no runtime packages. No service calls without --execute.
  --definition  print the synthetic Policy definition (offline)
  --self-test   validate fixture invariants and built Controller schemas/compiler when available (offline)
  --execute     sign in, create/test/publish fixtures, share only the new Guardrail
Required: GUARD_SMOKE_IDENTITIES_FILE ({tenantA:{email,password},tenantB:...,tenantC:...})
Optional:
  GUARD_SMOKE_CONTROLLER_URL  http://127.0.0.1:38081
  GUARD_SMOKE_RUNNER_URL      http://127.0.0.1:38082
  GUARD_SMOKE_ORIGIN          http://localhost:38081
  GUARD_LAB_STATE_FILE        .local-secrets/tenant-runtime-20261026/load-lab-fixtures.json
  GUARD_LAB_CONFIG_FILE       .local-secrets/tenant-runtime-20261026/load-lab-config.json
  GUARD_SMOKE_TIMEOUT_MS      180000 per validation/rollout
Private state/config are written atomically with mode 0600. Fixtures are retained.
Default is never edited, published, shared with C, or used as the lab target.
Example from the repository root:
  GUARD_SMOKE_IDENTITIES_FILE=.local-secrets/tenant-runtime-20261026/identities.json \\
    node scripts/provision-tenant-load-lab.mjs --execute`);
    return;
  }
  if (process.argv.includes('--definition')) { console.log(JSON.stringify(createDefinition(), null, 2)); return; }
  if (process.argv.includes('--self-test')) {
    const definition = createDefinition();
    assert.equal(definition.tests.length, 4);
    assert.equal(definition.rules.length, 1);
    assert.deepEqual(definition.rules[0].stages, ['input', 'output']);
    for (const phase of ['input', 'output']) {
      const tests = definition.tests.filter(test => test.phase === phase);
      assert(tests.some(test => test.kind === 'rule_acceptance' && test.content.includes(BLOCK_MARKER) && test.expected_decision === 'block'));
      assert(tests.some(test => test.kind === 'scenario' && !test.content.includes(BLOCK_MARKER) && test.expected_decision === 'allow'));
    }
    assert.equal(routeDraft('guard', 'version').routes[0].targets[0].weightBps, 10000);
    assert.equal(guardrailDraft('policy', 'r1').policyBindings.length, 1);
    const repositoryValidation = await validateRepositoryFixtures();
    console.log(JSON.stringify({ status: 'passed', offline: true, tests: 4, rules: 1, externalModels: false, repositoryValidation }));
    return;
  }
  assert(process.argv.includes('--execute'), 'No services contacted. Use --self-test, --definition, --help, or explicitly --execute.');
  assert(process.env.GUARD_SMOKE_IDENTITIES_FILE, 'Set GUARD_SMOKE_IDENTITIES_FILE.');
  const controller = new URL(process.env.GUARD_SMOKE_CONTROLLER_URL ?? 'http://127.0.0.1:38081');
  const runner = new URL(process.env.GUARD_SMOKE_RUNNER_URL ?? 'http://127.0.0.1:38082');
  for (const url of [controller, runner]) {
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Only disposable loopback URLs are supported.');
    assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 'Invalid deployment URL.');
  }
  const origin = process.env.GUARD_SMOKE_ORIGIN ?? 'http://localhost:38081';
  const statePath = resolve(process.env.GUARD_LAB_STATE_FILE ?? '.local-secrets/tenant-runtime-20261026/load-lab-fixtures.json');
  const configPath = resolve(process.env.GUARD_LAB_CONFIG_FILE ?? '.local-secrets/tenant-runtime-20261026/load-lab-config.json');
  assert.notEqual(statePath, configPath);
  const timeoutMs = Number(process.env.GUARD_SMOKE_TIMEOUT_MS ?? 180000);
  assert(Number.isFinite(timeoutMs) && timeoutMs >= 1000, 'Invalid timeout.');
  const secrets = new Set();
  const cookies = {};
  const identities = JSON.parse(await readFile(process.env.GUARD_SMOKE_IDENTITIES_FILE, 'utf8'));
  for (const id of TENANTS) { assert(identities[id]?.email && identities[id]?.password, `Missing ${id} identity.`); secrets.add(identities[id].password); }
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  state ??= { schemaVersion: 1, runId: randomUUID().slice(0, 8), createdAt: new Date().toISOString(),
    controller: controller.origin, runner: runner.origin, fixtures: {}, identityIds: {}, shares: {} };
  assert.equal(state.controller, controller.origin, 'Different Controller; use a different private state file.');
  assert.equal(state.runner, runner.origin, 'Different Runner; use a different private state file.');
  for (const fixture of Object.values(state.fixtures)) if (fixture.endpoint?.credential) secrets.add(fixture.endpoint.credential);
  function clean(value) {
    let text = String(value);
    for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[REDACTED]');
    return text.replace(/\btg_[A-Za-z0-9_-]{43}\b/g, '[REDACTED]');
  }
  const log = (stage, data = {}) => console.log(clean(JSON.stringify({ stage, ...data })));
  async function privateJson(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path); await chmod(path, 0o600);
  }
  const save = () => privateJson(statePath, state);
  class HttpError extends Error {
    constructor(method, path, status, code) { super(`${method} ${path}: HTTP ${status}${code ? ` (${code})` : ''}`); this.status = status; }
  }
  async function request(base, path, { tenant, method = 'GET', body, headers = {}, expect = 200 } = {}) {
    const response = await fetch(new URL(path, base), { method, redirect: 'error',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(base === controller ? { origin, ...(tenant ? { cookie: cookies[tenant] ?? '' } : {}) } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(Math.min(timeoutMs, 90000)) });
    const raw = await response.text(); let value = null;
    if (raw) { try { value = JSON.parse(raw); } catch { value = null; } }
    if (expect !== null && ![].concat(expect).includes(response.status)) throw new HttpError(method, path, response.status, value?.error?.code);
    return { value, status: response.status, headers: response.headers };
  }
  const api = async (tenant, path, options = {}) => (await request(controller, path, { ...options, tenant })).value;
  async function until(label, read, ready) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { const value = await read(); if (ready(value)) return value; }
      catch (error) { if (!(error instanceof TypeError || error.name === 'TimeoutError' || [429, 502, 503, 504].includes(error.status))) throw error; }
      await delay(1000);
    }
    throw new Error(`Timed out waiting for ${label}; private state retained.`);
  }
  function assertPassed(report, expectedCount, label) {
    assert.equal(report.status, 'passed', `${label} failed: ${clean(report.failureReason ?? 'inspect the saved run')}`);
    assert.equal(report.results?.length, expectedCount, `${label}: unexpected test count.`);
    assert(report.results.every(item => item.passed && !item.actualFailure && (item.modelInvocations ?? 0) === 0), `${label} has failed/nonlocal results.`);
  }
  try {
    await save();
    for (const id of TENANTS) {
      const login = await request(controller, '/api/auth/sign-in/email', { method: 'POST', body: identities[id] });
      cookies[id] = login.headers.getSetCookie().map(item => item.split(';')[0]).join('; ');
      assert(cookies[id], 'Sign-in omitted cookie.'); secrets.add(cookies[id]);
      const identity = await api(id, '/api/v1/account/identity');
      assert.equal(identity.tenantId, id); assert.equal(identity.role, 'user');
      if (state.identityIds[id]) assert.equal(state.identityIds[id], identity.userId, 'Identity changed; use a new fixture state.');
      state.identityIds[id] = identity.userId;
    }
    await save();
    const cDefault = await request(controller, '/api/v1/guardrails/guardrail-default', { tenant: 'tenantC', expect: null });
    assert.equal(cDefault.status, 404, 'C unexpectedly has access to Default; refuse to mix independent acceptance fixtures.');
    log('identities-verified-default-still-private');
    await until('Runner synchronization', async () => (await request(runner, '/health/ready')).value,
      value => value?.ready && value.controller_connected && value.desired_state_synchronized);

    const policyId = state.policy?.id ?? `tenant-load-lab-${state.runId}`;
    const definition = createDefinition(policyId);
    let resourceResponse = await request(controller, `/api/v1/policies/${policyId}/definition`, { tenant: 'tenantC', expect: null });
    assert([200, 404].includes(resourceResponse.status), 'Unexpected Policy lookup.');
    let resource = resourceResponse.value;
    if (resourceResponse.status === 404) resource = await api('tenantC', `/api/v1/policies/${policyId}/definition`, {
      method: 'PUT', body: { definition, maintainer: 'Tenant C load lab operator', expectedRevision: 0, create: true } });
    assert.equal(resource.id, policyId); assert.equal(resource.revision, 1, 'Refuse to overwrite an edited lab Policy.');
    assert.deepEqual(resource.definition.rules, definition.rules, 'Existing lab Rule differs.');
    assert.deepEqual(resource.definition.tests, definition.tests, 'Existing lab tests differ.');
    state.policy = { ...state.policy, id: policyId, revision: resource.revision }; await save();
    let policyReport = resource.validation;
    if (!policyReport || !['queued', 'running', 'passed'].includes(policyReport.status)) policyReport = await api('tenantC', `/api/v1/policies/${policyId}/definition/test-runs`, { method: 'POST', expect: 202 });
    policyReport = await until('four Policy tests', () => api('tenantC', `/api/v1/policies/${policyId}/definition/test-runs/${policyReport.id}`), report => ['passed', 'failed'].includes(report?.status));
    assertPassed(policyReport, 4, 'Policy tests');
    const policy = await api('tenantC', `/api/v1/policies/${policyId}/definition/publish`, { method: 'POST', expect: 201,
      body: { expectedRevision: resource.revision } });
    assert.equal(policy.id, policyId); assert.equal(policy.rules.length, 1);
    state.policy = { ...state.policy, version: policy.version, validationRunId: policyReport.id, tests: 4, modelInvocations: 0 }; await save();
    log('dedicated-policy-tested-and-published', { policyId, version: policy.version, tests: 4, modelInvocations: 0 });

    const guardName = `Tenant load lab ${state.runId}`;
    let guard = state.guardrail?.id ? await api('tenantC', `/api/v1/guardrails/${state.guardrail.id}`)
      : (await api('tenantC', '/api/v1/guardrails')).items.find(item => item.name === guardName && item.tenantId === 'tenantC');
    if (!guard) guard = await api('tenantC', '/api/v1/guardrails', { method: 'POST', expect: 201,
      body: { name: guardName, runtimeProfile: 'auto', draftConfig: guardrailDraft(policyId, policy.version) } });
    assert.equal(guard.tenantId, 'tenantC');
    state.guardrail = { ...state.guardrail, id: guard.id, name: guard.name }; await save();
    guard = await api('tenantC', `/api/v1/guardrails/${guard.id}`);
    assert.equal(guard.draftRevision, 1, 'Refuse edited lab Guardrail.');
    assert.equal(guard.draftConfig.policyBindings.length, 1);
    assert.equal(guard.draftConfig.policyBindings[0].policyId, policyId);
    assert.equal(guard.draftConfig.policyBindings[0].policyVersion, policy.version);
    let version = guard.versions.find(item => item.status === 'ready' && item.sourceDraftRevision === guard.draftRevision);
    if (!version) {
      let job = guard.latestValidationRun;
      if (!job || !['queued', 'running', 'passed'].includes(job.status)) job = await api('tenantC', `/api/v1/guardrails/${guard.id}/test-runs`, { method: 'POST', body: { testModelRules: false }, expect: 202 });
      const report = await until('four Guardrail tests', () => api('tenantC', `/api/v1/test-runs/${job.id}`), value => ['passed', 'failed'].includes(value?.status));
      assertPassed(report, 4, 'Guardrail tests');
      const publication = await api('tenantC', `/api/v1/guardrails/${guard.id}/publish`, { method: 'POST', expect: 201,
        body: { expectedDraftRevision: guard.draftRevision } });
      state.guardrail.validationRunId = report.id; await save();
      guard = await api('tenantC', `/api/v1/guardrails/${guard.id}`);
      version = guard.versions.find(item => item.version === publication.version && item.status === 'ready');
    }
    assert(version?.artifact?.signature && version.artifact.checksum, 'No signed ready lab Artifact.');
    assert(version.plan.steps.length > 0 && version.plan.steps.every(step => step.capability === 'builtin_content_filter'), 'Lab plan is not strictly local.');
    assert.equal(version.plan.policy_bindings.length, 1);
    assert.equal(version.plan.policy_bindings[0].policy_id, policyId);
    assert.equal(version.plan.policy_bindings[0].policy_version, policy.version);
    const suite = await api('tenantC', `/api/v1/guardrails/${guard.id}/versions/${encodeURIComponent(version.version)}/test-suite`);
    assert.equal(suite.items?.length, 4, 'Published lab version must carry its four frozen tests.');
    if (state.guardrail.checksum) assert.equal(version.artifact.checksum, state.guardrail.checksum, 'Lab artifact changed.');
    state.guardrail = { ...state.guardrail, version: version.version, checksum: version.artifact.checksum, artifactId: version.artifactId, generation: version.generation, tests: 4 }; await save();
    log('dedicated-guardrail-tested-and-published', { guardrailId: guard.id, version: version.version, checksum: version.artifact.checksum, tests: 4 });
    for (const recipient of ['tenantA', 'tenantB']) {
      const shared = await api('tenantC', '/api/v1/account/shares', { method: 'POST', expect: 201,
        body: { resourceType: 'guardrail', resourceId: guard.id, recipientTenantId: recipient } });
      state.shares[recipient] = shared.share.id;
      const visible = await api(recipient, `/api/v1/guardrails/${guard.id}`);
      assert.equal(visible.tenantId, 'tenantC');
    }
    await save();
    for (const tenant of TENANTS) {
      state.fixtures[tenant] ??= {};
      const fixture = state.fixtures[tenant]; const name = `Tenant load lab ${state.runId} ${tenant}`;
      let endpoint = fixture.endpoint?.id ? await api(tenant, `/api/v1/endpoints/${fixture.endpoint.id}`)
        : (await api(tenant, '/api/v1/endpoints')).items.find(item => item.name === name && item.tenantId === tenant);
      if (!endpoint) endpoint = await api(tenant, '/api/v1/endpoints', { method: 'POST', expect: 201, body: { name, adapter: 'litellm-generic-guardrail' } });
      else if (!fixture.endpoint?.credential) endpoint = await api(tenant, `/api/v1/endpoints/${endpoint.id}/credentials`, { method: 'POST', body: {}, expect: 201 });
      assert.equal(endpoint.tenantId, tenant); assert.equal(endpoint.status, 'active');
      const credential = endpoint.credential ?? fixture.endpoint?.credential;
      assert(credential, 'Endpoint credential unavailable.'); secrets.add(credential);
      fixture.endpoint = { id: endpoint.id, name: endpoint.name, tenantId: tenant, credential, credentialId: endpoint.credentialId ?? fixture.endpoint?.credentialId }; await save();
      let router = fixture.router?.id ? await api(tenant, `/api/v1/routers/${fixture.router.id}`)
        : (await api(tenant, '/api/v1/routers')).items.find(item => item.name === name && item.tenantId === tenant);
      if (!router) router = await api(tenant, '/api/v1/routers', { method: 'POST', expect: 201, body: { name,
        description: 'Dedicated identical local-plan traffic for the three-tenant occupancy lab.', endpointIds: [endpoint.id], draft: routeDraft(guard.id, version.version) } });
      assert.equal(router.tenantId, tenant); assert.deepEqual(router.endpointIds, [endpoint.id]);
      assert.equal(router.draft.routes.length, 1); assert.equal(router.draft.routes[0].targets.length, 1);
      assert.equal(router.draft.routes[0].targets[0].guardrailId, guard.id);
      assert.equal(router.draft.routes[0].targets[0].guardrailVersion, version.version);
      fixture.router = { ...fixture.router, id: router.id, name: router.name }; await save();
      if (!router.activeRevision) {
        let change = router.pendingChangeRequest;
        if (!change) {
          const preview = await api(tenant, `/api/v1/routers/${router.id}/publication-preview`, { method: 'POST', body: { expectedDraftRevision: router.draftRevision } });
          change = await api(tenant, `/api/v1/routers/${router.id}/change-requests`, { method: 'POST', expect: 201, body: {
            expectedDraftRevision: router.draftRevision, reviewedSnapshot: preview.snapshot, reviewedEndpointIds: preview.endpointIds,
            reason: 'Operator-requested disposable local three-tenant load lab; identical local policy, synthetic content only.', ticket: 'TENANT-LOAD-LAB-20261026' } });
        }
        fixture.router.changeRequestId = change.id; await save();
        await api(tenant, `/api/v1/routers/${router.id}/change-requests/${change.id}/emergency-apply`, { method: 'POST', expect: 202,
          body: { reason: 'Dedicated operator-authorized local lab fixtures; one owned synthetic Endpoint, no business traffic or existing smoke fixture changed.' } });
      }
      router = await until(`${tenant} lab Router rollout`, () => api(tenant, `/api/v1/routers/${router.id}`), value => {
        assert.notEqual(value.rolloutStatus, 'failed', 'Runner rejected lab Router generation.'); return value.rolloutStatus === 'active'; });
      const target = router.activeSnapshot.routes[0].targets[0];
      assert.equal(target.guardrailId, guard.id); assert.equal(target.guardrailVersion, version.version);
      fixture.router = { ...fixture.router, activeRevision: router.activeRevision, desiredGeneration: router.desiredGeneration }; await save();
      log('tenant-fixtures-active', { tenant, endpointId: endpoint.id, routerId: router.id, guardrailVersion: version.version });
    }
    // Verify two real actions per tenant. Same raw ID proves independent Endpoint claims.
    const sameRawId = `load-lab-ready-${randomUUID()}`;
    const decisions = new Set();
    for (const tenant of TENANTS) {
      const fixture = state.fixtures[tenant];
      for (const [phase, text, action] of [['request', 'A plain synthetic load lab request.', 'NONE'], ['response', BLOCK_MARKER, 'BLOCKED']]) {
        const response = await request(runner, `/runtime/v1/endpoints/${fixture.endpoint.id}/beta/litellm_basic_guardrail_api`, {
          method: 'POST', headers: { 'x-api-key': fixture.endpoint.credential },
          body: { input_type: phase, litellm_call_id: sameRawId, texts: [text] } });
        assert.equal(response.value.action, action);
        const assignment = JSON.parse(response.headers.get('x-guard-route-assignment') ?? 'null');
        assert.equal(assignment?.endpointId, fixture.endpoint.id); assert.equal(assignment.routerId, fixture.router.id);
        assert.equal(assignment.guardrailId, guard.id); assert.equal(assignment.guardrailVersion, version.version);
        if (phase === 'request') { fixture.inputDecisionId = assignment.decisionId; decisions.add(assignment.decisionId); }
        else assert.equal(assignment.decisionId, fixture.inputDecisionId, 'Input/output pin changed.');
      }
    }
    assert.equal(decisions.size, 3, 'Raw call ID collided between tenant Endpoints.');
    assert.equal((await request(controller, '/api/v1/guardrails/guardrail-default', { tenant: 'tenantC', expect: null })).status, 404);
    const config = { runnerBaseUrl: runner.origin, tenants: TENANTS.map((id, index) => ({ id, name: `Tenant ${String.fromCharCode(65 + index)}`,
      endpointId: state.fixtures[id].endpoint.id, credential: state.fixtures[id].endpoint.credential })) };
    await privateJson(configPath, config);
    state.status = 'ready'; state.completedAt = new Date().toISOString(); state.configPath = configPath;
    state.readiness = { samePublishedArtifactForAllTenants: true, localOnly: true, policyTests: 4, guardrailTests: 4, sameRawCallIdSeparated: true, defaultStillPrivateFromC: true };
    await save();
    log('ready', { statePath, configPath, tenants: TENANTS, guardrailId: guard.id, guardrailVersion: version.version, checksum: version.artifact.checksum,
      samePublishedArtifactForAllTenants: true, policyTests: 4, guardrailTests: 4, modelInvocations: 0, defaultStillPrivateFromC: true });
  } catch (error) {
    state.status = 'failed'; state.failure = clean(error.message); state.failedAt = new Date().toISOString();
    await save().catch(() => {}); console.error(clean(JSON.stringify({ status: 'failed', error: error.message, statePath })));
    process.exitCode = 1;
  }
}

if (process.argv[1] && !process.argv[1].startsWith('-')
    && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) await main();
