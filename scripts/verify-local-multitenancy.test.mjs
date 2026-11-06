import test from 'node:test';
import assert from 'node:assert/strict';
import { runAcceptance, localOrigin, signIn } from './verify-local-multitenancy.mjs';

test('local verification rejects remote URLs and selects the explicit identity protocol', () => {
  assert.throws(() => localOrigin('https://example.com'), /loopback/);
  assert.throws(() => localOrigin('http://user:private@localhost:38081'), /without credentials/);
  assert.throws(() => localOrigin('http://localhost:38081/path'), /without credentials/);
  assert.equal(localOrigin('http://localhost:38081'), 'http://localhost:38081');
  assert.deepEqual(signIn({ username: 'test-user', email: 'unused@example.test', password: 'synthetic' }), {
    path: '/api/auth/sign-in/username', body: { username: 'test-user', password: 'synthetic' },
  });
  assert.equal(signIn({ email: 'legacy@example.test', password: 'synthetic' }).path, '/api/auth/sign-in/email');
});

function deployment({ wrongPoolStatus = 401, monitorSecret = false, bypassInput = false, bypassOutput = false, modelCounter = true } = {}) {
  const ids = ['tenantA', 'tenantB', 'tenantC'];
  const fixtures = { guardrail: { id: 'guard-lab', version: 'published-version' }, fixtures: Object.fromEntries(ids.map(id => [id, {
    endpoint: { id: `endpoint-${id}`, credential: `synthetic-${id}-endpoint-key` }, router: { id: `router-${id}` },
  }])) };
  const identities = Object.fromEntries(ids.map(id => [id, { username: id, password: `private-"${id}\n-password` }]));
  const admin = { username: 'admin', password: 'synthetic-private-admin-password' };
  const controller = 'http://127.0.0.1:38081', runnerAB = 'http://127.0.0.1:38082', runnerC = 'http://127.0.0.1:38083';
  const group = id => id === 'tenantC' ? 'isolated' : 'default';
  const pool = id => id === 'tenantC' ? 'c' : 'default';
  const gateways = Object.fromEntries(ids.map((id, index) => [id, {
    gatewayBaseUrl: `http://127.0.0.1:${38121 + index}/v1`, gatewayApiKey: `synthetic-private-${id}-gateway`, model: 'mock-model',
  }]));
  const modelStatusUrl = 'http://127.0.0.1:38120/state', modelStatusToken = 'synthetic-private-model-status';
  const requests = [], saved = [], events = Object.fromEntries(ids.map(id => [id, []]));
  const admitted = Object.fromEntries(ids.map(id => [id, 8]));
  let completed = 0;
  const json = (value, status = 200, headers) => new Response(JSON.stringify(value), { status, headers });
  const fetcher = async (input, options = {}) => {
    const url = new URL(input), headers = new Headers(options.headers), actor = headers.get('cookie')?.split('=')[1];
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ origin: url.origin, path: url.pathname, method: options.method ?? 'GET', actor });
    if (url.pathname === '/state') {
      assert.equal(url.href, modelStatusUrl);
      assert.equal(headers.get('authorization'), `Bearer ${modelStatusToken}`);
      return json({ completed, active: 0, fixedLatencyMs: 120 });
    }
    if (url.pathname === '/v1/chat/completions') {
      const id = ids.find(id => new URL(gateways[id].gatewayBaseUrl).origin === url.origin);
      assert(id, 'All positive application traffic must use an external upstream gateway.');
      assert.equal(headers.get('authorization'), `Bearer ${gateways[id].gatewayApiKey}`);
      assert.equal(body.model, gateways[id].model);
      const content = body.messages[0].content;
      if (content === 'LAB_BLOCK_MARKER' && !bypassInput) return json({ error: { type: 'None', code: 400 } }, 400);
      if (modelCounter) completed++;
      admitted[id] += 2;
      const requestId = `gateway-request-${id}-${completed}`;
      for (const direction of ['incoming', 'outgoing']) events[id].push({ requestId, direction,
        endpointId: `endpoint-${id}`, routerId: `router-${id}`, guardrailId: 'guard-lab', guardrailVersion: 'published-version',
        runnerId: id === 'tenantC' ? 'runner-c' : 'runner-ab' });
      if (content === '[mock:block-output]' && !bypassOutput) return json({ error: { type: 'None', code: 400 } }, 400);
      return json({ choices: [{ message: { content: content === '[mock:block-output]' ? 'LAB_BLOCK_MARKER' : 'External synthetic completion.' } }] });
    }
    if (url.pathname === '/health/ready') return json({ ready: true, controller_connected: true, desired_state_synchronized: true });
    if (url.pathname === '/api/auth/sign-in/username') return json({}, 200, { 'set-cookie': `session=${body.username}; Path=/; HttpOnly` });
    if (url.pathname === '/api/v1/account/identity') return json({ role: actor === 'admin' ? 'admin' : 'user', tenantId: actor });
    if (url.pathname === '/api/v1/runner-pools') return json({ items: [{ id: pool(actor) }] });
    if (url.pathname === '/api/v1/telemetry/events') {
      assert.equal(url.searchParams.get('endpointId'), `endpoint-${actor}`);
      return json({ items: events[actor] });
    }
    if (url.pathname.startsWith('/api/v1/endpoints/') || url.pathname.startsWith('/api/v1/routers/')) {
      const id = url.pathname.split('/').at(-1);
      return json({}, id.endsWith(actor) ? 200 : 404);
    }
    if (url.pathname === '/api/v1/tenant-groups') {
      if (actor !== 'admin') return json({}, 403);
      return json({ items: [], tenants: ids.map(id => ({ id, groupId: group(id) })), pools: [{ id: 'default', groupId: 'default' }, { id: 'c', groupId: 'isolated' }] });
    }
    if (url.pathname.startsWith('/api/v1/tenant-groups/')) {
      if (actor !== 'admin') return json({}, 403);
      assert.equal(options.method, 'GET', 'Acceptance must not change administrator policies.');
      return json({ groupId: url.pathname.split('/')[4], mode: 'legacy', version: 0, modelIds: [], providerIds: [] });
    }
    if (url.pathname === '/api/v1/tenant-admission-monitor') {
      if (actor !== 'admin') return json({}, 403);
      const groups = ['default', 'isolated'].map(id => ({ id, tenantIds: ids.filter(tenant => group(tenant) === id), poolIds: [id === 'default' ? 'default' : 'c'],
        available: true, values: { active: 0, capacity: 4, queued: 0 } }));
      return json({ source: 'authenticated_runner_heartbeat', controllerLocal: true, groups,
        tenants: ids.map(id => ({ id, groupId: group(id), available: true, values: { capacity: 2, admitted: admitted[id], rejected: 0, waitP95Ms: 1, heldP95Ms: 10 } })),
        ...(monitorSecret ? { ignoredPrivateExtension: identities.tenantA.password } : {}) }, 200, { 'cache-control': 'no-store' });
    }
    if (url.pathname.startsWith('/runtime/v1/endpoints/')) {
      const id = ids.find(id => url.pathname.includes(`endpoint-${id}/`));
      assert.equal(headers.get('x-api-key'), fixtures.fixtures[id].endpoint.credential);
      assert.notEqual(url.origin, id === 'tenantC' ? runnerC : runnerAB,
        'Verifier must not manually compose positive Guard pipelines.');
      return json({}, wrongPoolStatus);
    }
    throw new Error('Unexpected verification request.');
  };
  return { controller, runnerAB, runnerC, identities, admin, fixtures, fetcher, gateways, modelStatusUrl, modelStatusToken,
    save: async value => { saved.push(value); }, requests, saved };
}

test('verification checks deployed authority boundaries without administrator mutations or recording credentials', async () => {
  const setup = deployment({ monitorSecret: true });
  const result = await runAcceptance(setup);
  assert.equal(result.status, 'passed');
  assert.equal(result.checks.length, 10);
  assert.equal(result.runtime.length, 3);
  assert(setup.requests.some(row => row.path === '/api/auth/sign-in/username'));
  assert(!setup.requests.some(row => row.actor === 'admin' && row.method !== 'GET'));
  assert.equal(setup.requests.filter(row => row.path === '/v1/chat/completions').length, 9);
  assert.equal(setup.requests.filter(row => row.path.startsWith('/runtime/v1/endpoints/')).length, 3);
  assert.equal(result.checks[6].facts.pairedGuardTelemetry, true);
  assert.deepEqual(result.checks[7].facts, { inputBlocks: 3, inputModelCalls: 0, outputBlocks: 3, outputModelCalls: 3, policiesEdited: false });
  const evidence = JSON.stringify(setup.saved);
  for (const secret of [setup.admin.password, ...Object.values(setup.identities).map(row => row.password),
    ...Object.values(setup.fixtures.fixtures).map(row => row.endpoint.credential), setup.modelStatusToken,
    ...Object.values(setup.gateways).map(row => row.gatewayApiKey)]) assert(!evidence.includes(JSON.stringify(secret).slice(1, -1)));
  assert(!evidence.includes('ignoredPrivateExtension'));
});

test('a wrong-pool authorization regression makes the verification fail and saves the boundary failure', async () => {
  const setup = deployment({ wrongPoolStatus: 200 });
  await assert.rejects(runAcceptance(setup), /credentials fail.*Expected HTTP 401; received HTTP 200/);
  assert.equal(setup.saved.at(-1).status, 'failed');
  assert.equal(setup.saved.at(-1).checks.at(-1).status, 'failed');
});

for (const [name, option] of [['Input', 'bypassInput'], ['Output', 'bypassOutput']]) {
  test(`a gateway that bypasses ${name} blocking fails acceptance`, async () => {
    const setup = deployment({ [option]: true });
    await assert.rejects(runAcceptance(setup), /blocks current policies.*Expected HTTP 400; received HTTP 200/);
    assert.equal(setup.saved.at(-1).status, 'failed');
  });
}

test('acceptance rejects a completion from a gateway that never reached the standalone model', async () => {
  const setup = deployment({ modelCounter: false });
  await assert.rejects(runAcceptance(setup), /Observed standalone model calls differ/);
  assert.equal(setup.saved.at(-1).status, 'failed');
});
