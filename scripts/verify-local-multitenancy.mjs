#!/usr/bin/env node
/** Local deployed-feature acceptance. Node 24, native dependencies only.
 * Uses existing synthetic fixtures; never edits Policies, groups or credentials.
 * Login sessions, runtime evidence and admission counters are created by tests.
 * Application traffic uses actual upstream LiteLLM gateways and a separately
 * deployed model service. This script never implements or serves an LLM.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const tenants = ['tenantA', 'tenantB', 'tenantC'];
const suffix = endpoint => `/runtime/v1/endpoints/${encodeURIComponent(endpoint)}/beta/litellm_basic_guardrail_api`;
const defaults = '.local-secrets/tenant-runtime-20261104';

export function localOrigin(raw) {
  const url = new URL(raw);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Only loopback deployments are supported.');
  assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
    'Use an HTTP(S) origin without credentials, path, query or fragment.');
  return url.origin;
}

export function signIn(identity) {
  assert(identity && typeof identity.password === 'string' && identity.password, 'A private identity password is required.');
  if (typeof identity.username === 'string' && identity.username) return {
    path: '/api/auth/sign-in/username', body: { username: identity.username, password: identity.password },
  };
  // Compatibility for explicitly selected older local deployments only.
  assert(typeof identity.email === 'string' && identity.email, 'A private username/password identity is required.');
  return { path: '/api/auth/sign-in/email', body: { email: identity.email, password: identity.password } };
}

function redact(value, secrets) {
  let text = String(value);
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, '[REDACTED]');
  return text.replace(/\btg_[A-Za-z0-9_-]{43}\b/g, '[REDACTED]');
}

function sanitize(value, secrets) {
  if (typeof value === 'string') return redact(value, secrets);
  if (Array.isArray(value)) return value.map(item => sanitize(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item, secrets)]));
  return value;
}

export async function runAcceptance({ controller, runnerAB, runnerC, identities, admin, fixtures,
  timeoutMs = 120000, origin = controller, fetcher = fetch, sleep = delay, save = async () => {},
  gateways, modelStatusUrl, modelStatusToken }) {
  for (const url of [controller, runnerAB, runnerC]) localOrigin(url);
  assert.notEqual(runnerAB, runnerC, 'Use distinct ports for the shared A/B and isolated C Runner pools.');
  assert(Number.isFinite(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 600000, 'Timeout must be between 1000 and 600000 ms.');
  assert(fixtures?.fixtures && fixtures?.guardrail?.id && fixtures.guardrail.version, 'Use a completed private lab fixture file.');
  assert(gateways && typeof gateways === 'object', 'Configure the three upstream LiteLLM gateway targets.');
  for (const id of tenants) {
    const target = gateways[id];
    assert(target && typeof target.gatewayApiKey === 'string' && target.gatewayApiKey && typeof target.model === 'string' && target.model,
      `Missing ${id} gateway configuration.`);
    const gatewayUrl = new URL(target.gatewayBaseUrl);
    localOrigin(gatewayUrl.origin);
    assert(['/','/v1','/v1/'].includes(gatewayUrl.pathname) && !gatewayUrl.search && !gatewayUrl.hash && !gatewayUrl.username && !gatewayUrl.password,
      'Use a loopback upstream gateway origin or /v1 base URL without embedded credentials.');
  }
  assert.equal(new Set(tenants.map(id => new URL(gateways[id].gatewayBaseUrl).origin)).size, 3, 'Use separately configured upstream gateway targets for the three Guard Endpoints.');
  const statusUrl = new URL(modelStatusUrl);
  localOrigin(statusUrl.origin);
  assert(statusUrl.pathname === '/state' && !statusUrl.search && !statusUrl.hash && !statusUrl.username && !statusUrl.password,
    'Use the standalone model aggregate /state endpoint without embedded credentials.');
  assert(typeof modelStatusToken === 'string' && modelStatusToken, 'Configure the external model status credential.');
  const secrets = new Set([modelStatusToken, ...tenants.map(id => gateways[id].gatewayApiKey)]);
  for (const identity of [admin, ...tenants.map(id => identities[id])]) {
    signIn(identity); secrets.add(identity.password);
  }
  for (const id of tenants) {
    const fixture = fixtures.fixtures[id];
    assert(fixture?.endpoint?.id && fixture.endpoint.credential && fixture.router?.id, `Missing ${id} private fixture.`);
    secrets.add(fixture.endpoint.credential);
  }
  const cookies = {};
  let beforeMonitor;
  const result = { schemaVersion: 1, startedAt: new Date().toISOString(), status: 'running',
    deployment: { controller, runnerAB, runnerC }, checks: [], runtime: [],
    limitations: [
      'Requests traverse upstream LiteLLM Guard callbacks and the separately deployed OpenAI-compatible model service.',
      'This verifier serves no model and does not manually compose the positive Guard pipeline.',
      'Local admission occupancy measures held permits, not reserved CPU/memory or whole application concurrency.',
      'This serial happy-path check does not prove peak isolation, HA/failover, permanent fencing or Provider billing isolation.',
      'No standalone Scan Endpoint is created or reconfigured by this check.',
    ] };
  const persist = () => save(sanitize(result, secrets));
  async function check(name, action) {
    const started = performance.now();
    try {
      const facts = await action();
      result.checks.push({ name, status: 'passed', durationMs: Math.round(performance.now() - started), ...(facts ? { facts } : {}) });
      await persist();
      return facts;
    } catch (error) {
      result.checks.push({ name, status: 'failed', error: redact(error.message, secrets) });
      result.status = 'failed'; result.completedAt = new Date().toISOString(); await persist();
      throw new Error(`${name}: ${redact(error.message, secrets)}`, { cause: error });
    }
  }
  async function request(base, path, { actor, body, method = 'GET', headers = {}, expect = 200 } = {}) {
    const response = await fetcher(new URL(path, base), { method, redirect: 'error', signal: AbortSignal.timeout(Math.min(timeoutMs, 15000)),
      headers: { ...(base === controller ? { origin, ...(actor ? { cookie: cookies[actor] ?? '' } : {}) } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const raw = await response.text(); let value;
    try { value = raw ? JSON.parse(raw) : null; } catch { value = null; }
    // Do not put upstream bodies, credentials or transport internals into proof files.
    if (expect !== null) assert([].concat(expect).includes(response.status), `Expected HTTP ${expect}; received HTTP ${response.status}.`);
    return { value, headers: response.headers, status: response.status };
  }
  const api = async (actor, path, options) => (await request(controller, path, { ...options, actor })).value;
  async function until(read, ready) {
    const deadline = Date.now() + timeoutMs;
    let latest;
    while (Date.now() < deadline) {
      latest = await read();
      if (ready(latest)) return latest;
      await sleep(2000);
    }
    throw new Error('Timed out waiting for current deployment evidence.');
  }
  async function modelState() {
    const state = (await request(statusUrl.origin, statusUrl.pathname, { headers: { authorization: `Bearer ${modelStatusToken}` } })).value;
    assert(Number.isSafeInteger(state?.completed) && state.completed >= 0 && Number.isSafeInteger(state.active) && state.active >= 0,
      'Standalone model status is invalid.');
    assert.equal(state.active, 0, 'Pause other model traffic before the serial acceptance run.');
    return state;
  }
  async function gateway(id, content, expect = 200) {
    const target = gateways[id];
    return request(target.gatewayBaseUrl, '/v1/chat/completions', { method: 'POST', expect,
      headers: { authorization: `Bearer ${target.gatewayApiKey}` },
      body: { model: target.model, stream: false, messages: [{ role: 'user', content }] } });
  }
  async function modelDelta(action, expectedDelta) {
    const before = await modelState();
    const response = await action();
    const after = await modelState();
    assert.equal(after.completed - before.completed, expectedDelta,
      'Observed standalone model calls differ from the guarded pipeline; pause other traffic and verify upstream wiring.');
    return response;
  }

  await persist();
  await check('Controller, both real Runner pools and standalone model are healthy', async () => {
    await request(controller, '/health/ready');
    for (const base of [runnerAB, runnerC]) {
      const ready = (await request(base, '/health/ready')).value;
      assert(ready?.ready && ready.controller_connected && ready.desired_state_synchronized, 'Runner has not synchronized with Controller.');
    }
    const external = await modelState();
    return { externalModel: true, targetDelayMs: external.fixedLatencyMs ?? null };
  });
  await check('Administrator and tenant sessions use persisted roles and tenants', async () => {
    for (const [id, identity] of [['admin', admin], ...tenants.map(id => [id, identities[id]])]) {
      const login = signIn(identity);
      const response = await request(controller, login.path, { method: 'POST', body: login.body });
      cookies[id] = response.headers.getSetCookie().map(item => item.split(';')[0]).join('; ');
      assert(cookies[id], 'Login omitted a session cookie.'); secrets.add(cookies[id]);
      const current = await api(id, '/api/v1/account/identity');
      assert.equal(current.role, id === 'admin' ? 'admin' : 'user', 'Unexpected session role.');
      if (id !== 'admin') assert.equal(current.tenantId, id, 'Unexpected persisted tenant identity.');
    }
    return { roles: { administrator: 'admin', tenants: 'user' } };
  });

  let placement;
  await check('A/B share a group and C has a separate allocated Runner pool', async () => {
    const directory = await api('admin', '/api/v1/tenant-groups');
    const byTenant = Object.fromEntries(tenants.map(id => [id, directory.tenants.find(item => item.id === id)?.groupId]));
    assert(byTenant.tenantA && byTenant.tenantB && byTenant.tenantC, 'Tenant allocation is incomplete.');
    assert.equal(byTenant.tenantA, byTenant.tenantB, 'A and B must share a group for this demonstration.');
    assert.notEqual(byTenant.tenantA, byTenant.tenantC, 'C must be isolated into another group.');
    const poolSets = Object.fromEntries(tenants.map(id => [id, directory.pools.filter(pool => pool.groupId === byTenant[id]).map(pool => pool.id).sort()]));
    for (const id of tenants) assert(poolSets[id].length, `${id} has no allocated pool.`);
    assert(poolSets.tenantA.every(id => !poolSets.tenantC.includes(id)), 'Groups share a pool identity.');
    for (const id of tenants) {
      const visible = (await api(id, '/api/v1/runner-pools')).items.map(pool => pool.id).sort();
      assert.deepEqual(visible, poolSets[id], 'Tenant pool visibility differs from database allocation.');
    }
    placement = { tenantGroups: byTenant, tenantPools: poolSets };
    return placement;
  });

  await check('Same-group tenants retain private application ownership', async () => {
    for (const viewer of tenants) for (const owner of tenants) {
      for (const [kind, key] of [['endpoints', 'endpoint'], ['routers', 'router']]) {
        const path = `/api/v1/${kind}/${encodeURIComponent(fixtures.fixtures[owner][key].id)}`;
        await request(controller, path, { actor: viewer, expect: viewer === owner ? 200 : 404 });
      }
    }
  });

  await check('Tenant callers cannot access group controls or administrator monitoring', async () => {
    for (const id of tenants) {
      const groupId = placement.tenantGroups[id];
      for (const path of ['/api/v1/tenant-groups', '/api/v1/tenant-admission-monitor', `/api/v1/tenant-groups/${encodeURIComponent(groupId)}/model-configuration`])
        await request(controller, path, { actor: id, expect: 403 });
      await request(controller, `/api/v1/tenant-groups/${encodeURIComponent(groupId)}/model-configuration`, {
        actor: id, method: 'PUT', expect: 403, body: { mode: 'blocked', expectedVersion: 0 },
      });
    }
  });

  await check('Group Model policy API is readable without returning secret snapshots', async () => {
    const groups = [...new Set(Object.values(placement.tenantGroups))], policies = [];
    for (const groupId of groups) {
      const policy = await api('admin', `/api/v1/tenant-groups/${encodeURIComponent(groupId)}/model-configuration`);
      assert.equal(policy.groupId, groupId); assert(['legacy', 'scoped', 'blocked'].includes(policy.mode));
      for (const field of ['credentialCiphertexts', 'runtimePayload', 'credentials', 'baseUrl'])
        assert(!Object.hasOwn(policy, field), 'Group policy response exposes private runtime/credential data.');
      policies.push({ groupId, mode: policy.mode, version: policy.version, modelCount: policy.modelIds.length, providerCount: policy.providerIds.length });
    }
    return { policies };
  });

  await check('Each upstream gateway delivers through real Input, standalone LLM and real Output', async () => {
    beforeMonitor = await api('admin', '/api/v1/tenant-admission-monitor');
    const since = new Date().toISOString();
    for (const id of tenants) {
      const started = performance.now();
      const response = await modelDelta(() => gateway(id, 'A plain synthetic load lab request.'), 1);
      assert.equal(typeof response.value?.choices?.[0]?.message?.content, 'string', 'Gateway did not return an OpenAI completion.');
      assert(!response.value.choices[0].message.content.includes('LAB_BLOCK_MARKER'), 'Unchecked blocked output reached the client.');
      result.runtime.push({ tenantId: id, status: 'delivered', gateway: gateways[id].gatewayBaseUrl,
        durationMs: Math.round(performance.now() - started), model: gateways[id].model,
        endpointId: fixtures.fixtures[id].endpoint.id, guardrailId: fixtures.guardrail.id, guardrailVersion: fixtures.guardrail.version });
    }
    for (const id of tenants) {
      const endpointId = fixtures.fixtures[id].endpoint.id;
      const events = await until(() => api(id, `/api/v1/telemetry/events?endpointId=${encodeURIComponent(endpointId)}&since=${encodeURIComponent(since)}&limit=50`), value => {
        const pairs = new Map();
        for (const row of value?.items ?? []) {
          if (row.endpointId !== endpointId || row.routerId !== fixtures.fixtures[id].router.id
            || row.guardrailId !== fixtures.guardrail.id || row.guardrailVersion !== fixtures.guardrail.version) continue;
          const pair = pairs.get(row.requestId) ?? new Set(); pair.add(row.direction); pairs.set(row.requestId, pair);
        }
        return [...pairs.values()].some(pair => pair.has('incoming') && pair.has('outgoing'));
      });
      const related = events.items.filter(row => row.endpointId === endpointId && row.routerId === fixtures.fixtures[id].router.id
        && row.guardrailId === fixtures.guardrail.id && row.guardrailVersion === fixtures.guardrail.version);
      const incoming = related.find(row => row.requestId && row.runnerId && row.direction === 'incoming' && related.some(other =>
        other.requestId === row.requestId && other.runnerId === row.runnerId && other.direction === 'outgoing'));
      assert(incoming, 'No paired Input/Output execution evidence on the same Runner was found.');
      const runtime = result.runtime.find(row => row.tenantId === id);
      runtime.runnerId = incoming.runnerId; runtime.requestId = incoming.requestId;
    }
    for (const row of result.runtime.filter(row => row.tenantId !== 'tenantC'))
      assert.notEqual(row.runnerId, result.runtime.find(row => row.tenantId === 'tenantC').runnerId,
        'Shared-group and isolated-group telemetry came from the same Runner.');
    return { delivered: 3, externalModelCalls: 3, path: 'upstream_litellm_guard_provider', pairedGuardTelemetry: true };
  });

  await check('Upstream gateway blocks current policies on Input and Output with external call proof', async () => {
    for (const id of tenants) {
      const input = await modelDelta(() => gateway(id, 'LAB_BLOCK_MARKER', 400), 0);
      assert(input.value?.error && !input.value?.choices, 'Input policy failure returned an unexpected public body.');
      const output = await modelDelta(() => gateway(id, '[mock:block-output]', 400), 1);
      assert(output.value?.error && !output.value?.choices, 'Output policy failure delivered unchecked content.');
    }
    return { inputBlocks: 3, inputModelCalls: 0, outputBlocks: 3, outputModelCalls: 3, policiesEdited: false };
  });

  await check('A/B Endpoint credentials fail on C pool and C credentials fail on A/B pool', async () => {
    for (const id of tenants) {
      const fixture = fixtures.fixtures[id];
      await request(id === 'tenantC' ? runnerAB : runnerC, suffix(fixture.endpoint.id), { method: 'POST', expect: 401,
        headers: { 'x-api-key': fixture.endpoint.credential, 'x-tenant-id': id },
        body: { input_type: 'request', litellm_call_id: `local-mt-wrong-${randomUUID()}`, texts: ['Hello.'] } });
    }
    return { denied: 3 };
  });

  await check('Measured admin monitoring reports current group placement and real completed permits', async () => {
    const state = await until(async () => {
      const response = await request(controller, '/api/v1/tenant-admission-monitor', { actor: 'admin' });
      assert.equal(response.headers.get('cache-control'), 'no-store'); return response.value;
    }, state => state?.source === 'authenticated_runner_heartbeat'
      && [...new Set(Object.values(placement.tenantGroups))].every(id => {
        const row = state.groups.find(item => item.id === id);
        return row?.available && row.values.capacity > 0;
      }) && tenants.every(id => {
      const row = state.tenants.find(item => item.id === id);
      const initial = beforeMonitor?.tenants.find(item => item.id === id)?.values.admitted ?? 0;
      return row?.available && row.groupId === placement.tenantGroups[id] && row.values.admitted >= initial + 2 && row.values.capacity > 0;
    }));
    return { source: state.source, controllerLocal: state.controllerLocal,
      groups: state.groups.filter(row => Object.values(placement.tenantGroups).includes(row.id)).map(row => ({
        id: row.id, tenantIds: row.tenantIds, poolIds: row.poolIds, available: row.available,
        active: row.values.active, capacity: row.values.capacity, queued: row.values.queued,
      })), tenants: state.tenants.filter(row => tenants.includes(row.id)).map(row => ({
        id: row.id, groupId: row.groupId, available: row.available, admitted: row.values.admitted, rejected: row.values.rejected,
        waitP95Ms: row.values.waitP95Ms, heldP95Ms: row.values.heldP95Ms,
      })) };
  });
  result.status = 'passed'; result.completedAt = new Date().toISOString(); await persist(); return sanitize(result, secrets);
}

async function main() {
  if (process.argv.includes('--help') || !process.argv.includes('--execute')) {
    console.log(`Verify an already deployed local A/B-shared + C-isolated demonstration.
Use --execute to create login sessions and run real existing pipeline requests.
Required: GUARD_LOCAL_ADMIN_IDENTITIES_FILE JSON {username,password}
Optional:
  GUARD_LOCAL_IDENTITIES_FILE   ${defaults}/identities.json
  GUARD_LOCAL_FIXTURES_FILE     ${defaults}/load-lab-fixtures.json
  GUARD_LOCAL_CONTROLLER_URL    http://127.0.0.1:38081
  GUARD_LOCAL_RUNNER_AB_URL     http://127.0.0.1:38082
  GUARD_LOCAL_RUNNER_C_URL      http://127.0.0.1:38083
  GUARD_LOCAL_GATEWAYS_FILE     ${defaults}/external-llm/gateways.json
  GUARD_LOCAL_MODEL_STATUS_CONFIG_FILE ${defaults}/load-lab-config.json
  GUARD_LOCAL_ORIGIN            http://localhost:38081
  GUARD_LOCAL_TIMEOUT_MS        120000
  GUARD_LOCAL_RESULT_FILE       /tmp/tasklattice-local-multitenancy.json
No fixtures, groups, Model policies, credentials or deployment flags are edited.
The configured model is external. Upstream LiteLLM performs both Guard phases; this script serves no model.
Pause the lab first so external model call-counter deltas are attributable.
Use fresh fixture paths for a fresh release, not old deployment credentials.`);
    return;
  }
  assert(process.env.GUARD_LOCAL_ADMIN_IDENTITIES_FILE, 'Set GUARD_LOCAL_ADMIN_IDENTITIES_FILE to a private administrator identity file.');
  const [identities, admin, fixtures, gateways, modelStatus] = await Promise.all([
    process.env.GUARD_LOCAL_IDENTITIES_FILE ?? `${defaults}/identities.json`, process.env.GUARD_LOCAL_ADMIN_IDENTITIES_FILE,
    process.env.GUARD_LOCAL_FIXTURES_FILE ?? `${defaults}/load-lab-fixtures.json`,
    process.env.GUARD_LOCAL_GATEWAYS_FILE ?? `${defaults}/external-llm/gateways.json`,
    process.env.GUARD_LOCAL_MODEL_STATUS_CONFIG_FILE ?? `${defaults}/load-lab-config.json`,
  ].map(async path => {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch { throw new Error('A private identity or fixture input file is unreadable or malformed.'); }
  }));
  const target = resolve(process.env.GUARD_LOCAL_RESULT_FILE ?? '/tmp/tasklattice-local-multitenancy.json');
  async function save(result) {
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, target); await chmod(target, 0o600);
  }
  const rawStatusUrl = new URL(modelStatus.modelStatusUrl);
  // The K8s lab uses Docker's host alias; the host-side verifier uses loopback.
  if (rawStatusUrl.hostname === 'host.docker.internal') rawStatusUrl.hostname = '127.0.0.1';
  const result = await runAcceptance({ controller: localOrigin(process.env.GUARD_LOCAL_CONTROLLER_URL ?? 'http://127.0.0.1:38081'),
    runnerAB: localOrigin(process.env.GUARD_LOCAL_RUNNER_AB_URL ?? 'http://127.0.0.1:38082'),
    runnerC: localOrigin(process.env.GUARD_LOCAL_RUNNER_C_URL ?? 'http://127.0.0.1:38083'),
    identities, admin, fixtures, gateways, modelStatusUrl: rawStatusUrl.href, modelStatusToken: modelStatus.modelStatusToken,
    timeoutMs: Number(process.env.GUARD_LOCAL_TIMEOUT_MS ?? 120000),
    origin: process.env.GUARD_LOCAL_ORIGIN ?? 'http://localhost:38081', save });
  console.log(JSON.stringify({ status: result.status, checks: result.checks.length, resultFile: target }));

}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  // The runner deliberately reports controlled assertions/statuses, not upstream
  // response bodies or file contents. Secrets never belong in stdout/stderr.
  console.error(JSON.stringify({ status: 'failed', error: error.message })); process.exitCode = 1;
});
