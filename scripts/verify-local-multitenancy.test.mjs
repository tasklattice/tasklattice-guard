import test from 'node:test';
import assert from 'node:assert/strict';
import { main, runAcceptance, validateConfiguration } from './verify-local-multitenancy.mjs';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

function deployment(options = {}) {
  const ids = ['project-blue', 'project-green', 'project-orange'].slice(0, options.projectCount ?? 3);
  const config = {
    controllerBaseUrl: 'https://controller.example.test', timeoutMs: 2000,
    requestText: 'Synthetic private acceptance input.',
    projects: ids.map((id, index) => ({
      id, auth: index === 1 ? { sessionCookie: `session=synthetic-cookie-${id}; preference=en` } : { bearerToken: `synthetic-token-${id}` },
      runnerBaseUrl: index < 2 ? 'https://runner-shared.example.test' : 'https://runner-orange.example.test',
      gateway: { baseUrl: `https://gateway-${index}.example.test/v1`, apiKey: `synthetic-gateway-${id}`, model: 'existing-application-model' },
      resources: { endpointId: `endpoint-${id}`, routerId: `router-${id}`, guardrailId: `guardrail-${id}`,
        guardrailVersion: 'existing-v1', endpointCredential: `synthetic-endpoint-${id}` },
      expectedGroupId: index < 2 ? 'default' : 'orange', expectedPoolId: index < 2 ? 'default' : 'orange-pool',
    })),
    administratorAuth: { bearerToken: 'synthetic-administrator-token' },
    modelStatus: { url: 'https://model.example.test/state', token: 'synthetic-model-counter-token' },
  };
  if (options.optional === false) {
    delete config.administratorAuth; delete config.modelStatus;
    for (const project of config.projects) delete project.resources.endpointCredential;
  }
  const requests = [], saved = [], events = new Map(ids.map(id => [id, []])), queryStarts = new Map();
  let completed = 0, time = Date.parse('2026-11-07T01:00:00Z');
  const actorFor = headers => config.projects.find(project => project.auth.bearerToken
    ? headers.get('authorization') === `Bearer ${project.auth.bearerToken}` : headers.get('cookie') === project.auth.sessionCookie);
  const fetcher = async (input, init = {}) => {
    const url = new URL(input), headers = new Headers(init.headers), method = init.method ?? 'GET';
    const actor = actorFor(headers), admin = headers.get('authorization') === `Bearer ${config.administratorAuth?.bearerToken}`;
    requests.push({ url, method, headers, body: init.body && JSON.parse(init.body) });
    assert.equal(init.redirect, 'error', 'Credentials must not follow redirects.');
    assert(init.signal instanceof AbortSignal);
    if (url.origin === config.controllerBaseUrl) {
      assert.equal(method, 'GET', 'Acceptance must never edit product configuration or sign in.');
      assert.equal(headers.get('origin'), config.controllerBaseUrl);
      if (actor) assert.equal(headers.get('x-project-id'), actor.id);
      if (url.pathname === '/api/v1/account/identity') {
        if (options.oversizedIdentity) return new Response('x'.repeat(2 * 1024 * 1024 + 1));
        if (options.fetchFailure) throw new Error(config.projects[0].gateway.apiKey);
        return json({ role: admin ? 'admin' : 'user', projectId: admin ? null : options.identityMismatch ? 'another-project' : actor?.id,
          ignoredPrivateExtension: config.projects[0].gateway.apiKey });
      }
      const resource = /^\/api\/v1\/(endpoints|routers|guardrails)\/([^/]+)$/.exec(url.pathname);
      if (resource) {
        const key = { endpoints: 'endpointId', routers: 'routerId', guardrails: 'guardrailId' }[resource[1]];
        const owner = config.projects.find(project => project.resources[key] === decodeURIComponent(resource[2]));
        assert(owner && actor);
        return json({}, actor.id === owner.id ? 200 : options.foreignStatus ?? 404);
      }
      if (['/api/v1/project-groups', '/api/v1/project-admission-monitor'].includes(url.pathname)) {
        assert(actor); return json({}, options.adminStatus ?? 403);
      }
      const allocation = /^\/api\/v1\/projects\/([^/]+)\/runner$/.exec(url.pathname);
      if (allocation) {
        assert(admin);
        const project = config.projects.find(project => project.id === decodeURIComponent(allocation[1]));
        return json({ projectId: project.id, groupId: project.expectedGroupId,
          pool: { id: options.cookieMismatch ? decodeURIComponent(config.projects[1].auth.sessionCookie.split(';')[0].split('=')[1])
            : options.poolMismatch ? config.projects[0].gateway.apiKey : project.expectedPoolId } });
      }
      const policy = /^\/api\/v1\/project-groups\/([^/]+)\/model-configuration$/.exec(url.pathname);
      if (policy) {
        assert(admin);
        return json({ groupId: decodeURIComponent(policy[1]), mode: 'scoped', ignoredPrivateExtension: config.projects[0].gateway.apiKey,
          ...(options.policySecret ? { credentialCiphertexts: { provider: config.projects[0].gateway.apiKey } } : {}) });
      }
      if (url.pathname === '/api/v1/telemetry/events') {
        assert(actor);
        assert.equal(url.searchParams.get('endpointId'), actor.resources.endpointId);
        assert.equal(url.searchParams.get('limit'), '100');
        const since = url.searchParams.get('since');
        assert(Number.isFinite(Date.parse(since)) && Date.parse(since) <= time);
        if (!queryStarts.has(actor.id)) queryStarts.set(actor.id, since);
        assert.equal(since, queryStarts.get(actor.id), 'Polling must retain the gateway request start boundary.');
        return json(options.invalidTelemetry ? {} : { items: events.get(actor.id) });
      }
    }
    const gateway = config.projects.find(project => new URL(project.gateway.baseUrl).origin === url.origin);
    if (gateway) {
      assert.equal(url.pathname, '/v1/chat/completions'); assert.equal(method, 'POST');
      assert.equal(headers.get('authorization'), `Bearer ${gateway.gateway.apiKey}`);
      const body = JSON.parse(init.body);
      assert.equal(body.model, gateway.gateway.model); assert.equal(body.stream, false);
      assert.equal(body.messages[0].content, config.requestText);
      assert.equal(typeof body.metadata.acceptance_request_id, 'string');
      if (options.modelDispatched !== false) completed++;
      const requestId = `observed-request-${gateway.id}`;
      for (const direction of ['incoming', 'outgoing']) {
        if (options.missingOutput && direction === 'outgoing') continue;
        events.get(gateway.id).push({ ...gateway.resources, direction,
          requestId: options.mismatchedRequest && direction === 'outgoing' ? 'another-request' : requestId,
          guardrailId: options.mismatchedPath && direction === 'outgoing' ? 'another-guardrail' : gateway.resources.guardrailId,
          guardrailVersion: options.staleVersion ? 'old-v0' : gateway.resources.guardrailVersion,
          runnerId: options.missingRunner && direction === 'outgoing' ? ''
            : options.differentRunner && direction === 'outgoing' ? 'runner-1' : 'runner-0' });
      }
      return json(options.malformedCompletion ? {} : { choices: [{ message: { content: 'Synthetic private model response.' } }] });
    }
    if (url.origin === 'https://model.example.test') {
      assert.equal(url.pathname, '/state'); assert.equal(method, 'GET');
      assert.equal(headers.get('authorization'), `Bearer ${config.modelStatus.token}`);
      return json({ completed, active: options.modelBusy ? 1 : 0 });
    }
    if (url.pathname === '/health/ready') return json({ ready: options.runnerReady !== false, controller_connected: true, desired_state_synchronized: true });
    const verification = /^\/runtime\/v1\/endpoints\/([^/]+)\/verify$/.exec(url.pathname);
    if (verification) {
      assert.equal(method, 'POST'); assert.equal(init.body, undefined, 'Credential probes must not run Guard pipelines.');
      const project = config.projects.find(project => project.resources.endpointId === decodeURIComponent(verification[1]));
      assert(project); assert.equal(headers.get('x-api-key'), project.resources.endpointCredential);
      const own = url.origin === project.runnerBaseUrl;
      return json(own ? { ready: true, adapter_id: 'litellm-generic-guardrail' } : {}, own ? options.ownCredentialStatus ?? 200 : options.wrongPoolStatus ?? 401);
    }
    throw new Error(`Unexpected external acceptance request: ${url.origin}${url.pathname}`);
  };
  const execute = () => runAcceptance(config, { fetcher, save: async value => saved.push(structuredClone(value)),
    now: () => time, sleep: async milliseconds => { time += milliseconds; } });
  return { config, fetcher, execute, requests, saved };
}

test('standalone Project acceptance checks supplied identities, privacy, real gateways and optional allocation evidence', async () => {
  const setup = deployment();
  const result = await setup.execute();
  assert.equal(result.status, 'passed'); assert.equal(result.checks.length, 7); assert.equal(result.runtime.length, 3);
  assert.deepEqual(result.checks.at(-1).facts, { verified: 3, denied: 3 });
  assert.equal(result.capabilities.externalModelDispatch, true);
  assert(result.runtime.every(item => item.externalModelDispatchVerified));
  assert.equal(setup.requests.filter(item => item.url.pathname === '/v1/chat/completions').length, 3);
  assert.equal(setup.requests.filter(item => item.url.pathname.endsWith('/verify')).length, 6);
  assert(!setup.requests.some(item => /sign-in|tenant-groups|sharing|basic_guardrail_api/.test(item.url.pathname)));
  const evidence = JSON.stringify(setup.saved);
  const secrets = [setup.config.administratorAuth.bearerToken, setup.config.modelStatus.token,
    ...setup.config.projects.flatMap(project => [Object.values(project.auth)[0], project.gateway.apiKey, project.resources.endpointCredential])];
  for (const secret of secrets) assert(!evidence.includes(secret));
  for (const content of ['ignoredPrivateExtension', setup.config.requestText, 'Synthetic private model response.']) assert(!evidence.includes(content));
});

test('external acceptance works for any two configured Projects without administrator or model-counter authority', async () => {
  const setup = deployment({ projectCount: 2, optional: false });
  const result = await setup.execute();
  assert.equal(result.status, 'passed'); assert.equal(result.checks.length, 5); assert.equal(result.runtime.length, 2);
  assert.equal(result.capabilities.administratorPlacement, false); assert.equal(result.capabilities.externalModelDispatch, false);
  assert.equal(result.capabilities.wrongPoolCredentialDenial, false);
  assert(result.limitations.some(item => item.includes('External model dispatch is unverified')));
  assert(!setup.requests.some(item => /model-configuration|\/runner$|\/verify$/.test(item.url.pathname)));
});

test('paired Input and Output may execute on different replicas behind the configured Runtime Service', async () => {
  const setup = deployment({ differentRunner: true });
  const result = await setup.execute();
  assert.equal(result.status, 'passed');
  assert(result.runtime.every(item => item.inputRunnerId === 'runner-0' && item.outputRunnerId === 'runner-1'));
});

test('configuration accepts an existing multi-cookie session but never header control characters', () => {
  const { config } = deployment();
  assert.equal(validateConfiguration(config).projects[1].auth.sessionCookie, config.projects[1].auth.sessionCookie);
  for (const value of ['session=ok\r\nx-injected: yes', ' session=trim-me ', '']) {
    const bad = structuredClone(config); bad.projects[1].auth.sessionCookie = value;
    assert.throws(() => validateConfiguration(bad), /Cookie header/);
  }
  const bad = structuredClone(config); bad.projects[0].auth.bearerToken = 'token with spaces';
  assert.throws(() => validateConfiguration(bad), /ASCII header credential/);
});

test('configuration rejects retired login inputs, credential-bearing URLs and ambiguous resource bindings', () => {
  assert.throws(() => validateConfiguration({ identities: {}, admin: {}, fixtures: {} }), /controllerBaseUrl/);
  const { config } = deployment();
  for (const url of ['https://user:private@controller.example.test', 'https://controller.example.test/prefix', 'https://controller.example.test?secret=value']) {
    const bad = structuredClone(config); bad.controllerBaseUrl = url;
    assert.throws(() => validateConfiguration(bad), /without embedded credentials/);
  }
  const duplicate = structuredClone(config); duplicate.projects[1].resources.guardrailId = duplicate.projects[0].resources.guardrailId;
  assert.throws(() => validateConfiguration(duplicate), /distinct Project-owned/);
  const auth = structuredClone(config); auth.projects[1].auth = auth.projects[0].auth;
  assert.throws(() => validateConfiguration(auth), /distinct Project-bound/);
});

for (const [name, options, expected] of [
  ['wrong Project identity', { identityMismatch: true }, /configured Project/],
  ['foreign resources becoming readable', { foreignStatus: 200 }, /Expected HTTP 404/],
  ['business users reading administrator controls', { adminStatus: 200 }, /Expected HTTP 403/],
  ['an unsynchronized Runner', { runnerReady: false }, /has not synchronized/],
  ['a malformed gateway completion', { malformedCompletion: true }, /OpenAI-compatible completion/],
  ['a gateway bypassing the configured external model', { modelDispatched: false }, /exactly one external model call/],
  ['an active model counter with unrelated traffic', { modelBusy: true }, /pause other traffic/],
  ['an Endpoint key not accepted by its own Runner', { ownCredentialStatus: 401 }, /Expected HTTP 200/],
  ['an Endpoint key accepted by a foreign Runner', { wrongPoolStatus: 200 }, /Expected HTTP 401/],
  ['private Model snapshot data exposed through the public policy', { policySecret: true }, /private runtime\/credential data/],
  ['malformed runtime evidence', { invalidTelemetry: true }, /event list/],
  ['an oversized response', { oversizedIdentity: true }, /response budget/],
]) {
  test(`acceptance fails and saves a bounded report for ${name}`, async () => {
    const setup = deployment(options);
    await assert.rejects(setup.execute(), expected);
    const result = setup.saved.at(-1);
    assert.equal(result.status, 'failed'); assert.equal(result.checks.at(-1).status, 'failed');
  });
}

for (const [name, options] of [
  ['missing output evidence', { missingOutput: true }],
  ['a different pinned Guardrail version', { staleVersion: true }],
  ['Input and Output from different requests', { mismatchedRequest: true }],
  ['Input and Output from different resource paths', { mismatchedPath: true }],
  ['output evidence without a Runner identity', { missingRunner: true }],
]) {
  test(`acceptance rejects ${name}`, async () => {
    const setup = deployment(options);
    await assert.rejects(setup.execute(), /Timed out waiting for paired runtime evidence/);
    assert.equal(setup.saved.at(-1).status, 'failed');
  });
}

test('failure reports redact credential values returned as misleading allocation data', async () => {
  const setup = deployment({ poolMismatch: true });
  await assert.rejects(setup.execute(), error => !error.message.includes(setup.config.projects[0].gateway.apiKey));
  const serialized = JSON.stringify(setup.saved);
  assert(!serialized.includes(setup.config.projects[0].gateway.apiKey)); assert(serialized.includes('[REDACTED]'));
});

test('failure reports redact individual and decoded session-cookie secrets without replacing display preferences', async () => {
  const setup = deployment({ cookieMismatch: true });
  setup.config.projects[1].auth.sessionCookie = 'session=synthetic%2Dencoded%2Dcookie; preference=en';
  await assert.rejects(setup.execute(), error => !error.message.includes('synthetic-encoded-cookie'));
  const serialized = JSON.stringify(setup.saved);
  assert(!serialized.includes('synthetic-encoded-cookie')); assert(!serialized.includes('synthetic%2Dencoded%2Dcookie'));
  assert(serialized.includes('[REDACTED]'));
  assert(serialized.includes('existing Project credentials'), 'A short display-preference value must not corrupt ordinary report text.');
});

test('transport failures do not expose HTTP credentials', async () => {
  const setup = deployment({ fetchFailure: true });
  await assert.rejects(setup.execute(), /External HTTP request failed/);
  assert(!JSON.stringify(setup.saved).includes(setup.config.projects[0].gateway.apiKey));
});

test('CLI help documents existing Project credentials without executing a deployment', async () => {
  const previous = console.log, output = [];
  console.log = value => output.push(value);
  try { await main(['--help']); } finally { console.log = previous; }
  assert.equal(output.length, 1);
  assert.match(output[0], /existing Projects/); assert.match(output[0], /--config/);
  assert.match(output[0], /No login is performed/);
});
