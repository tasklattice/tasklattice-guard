import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASELINE_MIN_RPS, BASELINE_MAX_RPS, BASELINE_INITIAL_RPS,
  createLab, createLabServer, LIMITS, peakDurationSeconds, parseRunnerMetrics, validateConfig } from './tenant-load-lab.mjs';

const config = { runnerBaseUrl: 'http://127.0.0.1:1', peakRps: 80,
  tenants: ['tenantA', 'tenantB', 'tenantC'].map(id => ({ id, name: id, gatewayBaseUrl: 'http://127.0.0.1:1/v1', gatewayApiKey: `private-${id}`, model: 'guarded-model' })) };

function controlledLab(configuration = config, transport, random = () => 0.5) {
  let time = 100000, nextTimer = 0;
  const timers = new Map(), signals = [], callIds = [];
  const lab = createLab(configuration, { now: () => time, random,
    setInterval: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearInterval: id => timers.delete(id),
    fetch: async (url, { signal, body, ...options }) => {
      signals.push(signal);
      callIds.push(JSON.parse(body).metadata.lab_request_id);
      if (transport) return transport(url, { signal, body, ...options });
      return new Promise((resolve, reject) => {
        if (signal.aborted) reject(new Error('Aborted'));
        else signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
      });
    } });
  return { lab, timers, signals, callIds,
    async advance(ms) { for (let i = 0; i < ms; i += 25) { time += 25; lab.tick(); await Promise.resolve(); } },
    setTime(value) { time = value; }, now: () => time };
}

test('optional local baseline requires a complete bounded ordered profile and keeps default traffic unchanged', () => {
  assert.equal(BASELINE_MIN_RPS, 3); assert.equal(BASELINE_MAX_RPS, 5); assert.equal(BASELINE_INITIAL_RPS, 4);
  const defaults = validateConfig(config);
  assert.deepEqual([defaults.baselineMinRps, defaults.baselineMaxRps, defaults.baselineInitialRps], [3, 5, 4]);
  const local = validateConfig({ ...config, baselineMinRps: 0.75, baselineMaxRps: 1.25, baselineInitialRps: 1 });
  assert.deepEqual([local.baselineMinRps, local.baselineMaxRps, local.baselineInitialRps], [0.75, 1.25, 1]);
  assert.equal(local.peakRps, defaults.peakRps, 'Baseline tuning must not silently reduce an explicit peak.');
  for (const input of [
    { baselineMinRps: 1 }, { baselineMaxRps: 1 }, { baselineInitialRps: 1 },
    { baselineMinRps: 2, baselineMaxRps: 1, baselineInitialRps: 1 },
    { baselineMinRps: 1, baselineMaxRps: 2, baselineInitialRps: 3 },
  ]) assert.throws(() => validateConfig({ ...config, ...input }), /together|minimum <= initial <= maximum/);
  for (const key of ['baselineMinRps', 'baselineMaxRps', 'baselineInitialRps']) {
    for (const invalid of [undefined, null, false, '1', NaN, Infinity, -1, 0, 0.249, 20.001]) {
      assert.throws(() => validateConfig({ ...config, baselineMinRps: 1, baselineMaxRps: 1, baselineInitialRps: 1, [key]: invalid }), /finite numbers/);
    }
  }
});

test('low-resource baseline drives actual starts and reset restores the configured initial rate after a peak', async () => {
  const clock = controlledLab({ ...config, baselineMinRps: 0.75, baselineMaxRps: 1.25, baselineInitialRps: 1 });
  try {
    clock.lab.control({ action: 'start' });
    await clock.advance(2000);
    assert(clock.lab.state().tenants.every(row => row.inflight === 2), 'Each tenant should offer one pipeline/s at the midpoint baseline.');
    clock.lab.control({ action: 'peak', tenantId: 'tenantA', durationSeconds: 15 });
    await clock.advance(250);
    assert(clock.lab.state().tenants[0].inflight > 10, 'The peak must still use its configured rate.');
    clock.lab.control({ action: 'reset' });
    assert(clock.lab.state().tenants.every(row => row.inflight === 0 && row.peakUntil === null));
    clock.lab.control({ action: 'start' }); await clock.advance(1000);
    assert(clock.lab.state().tenants.every(row => row.inflight === 1), 'Reset must restore the local initial rate rather than the default four pipelines/s.');
  } finally { clock.lab.close(); }
});

test('baseline goals rise and fall smoothly within the configured local range', async () => {
  let draw = 1;
  const clock = controlledLab({ ...config, baselineMinRps: 0.25, baselineMaxRps: 4, baselineInitialRps: 1 }, undefined, () => draw);
  try {
    clock.lab.control({ action: 'start' });
    await clock.advance(500);
    assert(clock.lab.state().tenants.every(row => row.inflight === 0), 'Choosing the high goal must not immediately jump the initial traffic to four pipelines/s.');
    await clock.advance(7500);
    assert(clock.lab.state().tenants.every(row => row.offeredRps >= 3 && row.offeredRps <= 4), 'The high goal should approach the configured maximum.');
    draw = 0; await clock.advance(12000);
    assert(clock.lab.state().tenants.every(row => row.offeredRps <= 1), 'Later low goals should approach the configured minimum instead of the default three pipelines/s.');
  } finally { clock.lab.close(); }
});

test('peak duration is bounded, peaks expire, and manual release is recorded', async () => {
  assert.equal(peakDurationSeconds(), 30);
  assert.equal(peakDurationSeconds(100000), 60);
  assert.equal(peakDurationSeconds(-5), 15);
  assert.throws(() => peakDurationSeconds(NaN));
  const clock = controlledLab();
  try {
    assert.throws(() => clock.lab.control({ action: 'peak', tenantId: 'tenantA' }), /Start/);
    clock.lab.control({ action: 'start' });
    const state = clock.lab.control({ action: 'peak', tenantId: 'tenantA', durationSeconds: 100000 });
    assert.equal(state.tenants[0].peakUntil, clock.now() + 60000);
    clock.setTime(clock.now() + 60001); clock.lab.tick();
    assert.equal(clock.lab.state().tenants[0].peakUntil, null);
    assert(clock.lab.state().events.some(item => item.kind === 'release' && item.tenantId === 'tenantA'));
    clock.lab.control({ action: 'release', tenantId: 'tenantB' });
    assert.equal(clock.lab.state().events.at(-1).kind, 'release');
  } finally { clock.lab.close(); }
});

test('quota admission preserves peer slots while shared mode has no four-slot tenant cap', async () => {
  for (const mode of ['shared', 'quota']) {
    const clock = controlledLab();
    try {
      clock.lab.control({ action: 'mode', mode }); clock.lab.control({ action: 'start' });
      clock.lab.control({ action: 'peak', tenantId: 'tenantA', durationSeconds: 30 });
      await clock.advance(3000);
      const state = clock.lab.state(), [a, b, c] = state.tenants;
      assert(b.inflight > 0 && c.inflight > 0, 'Peer tenants must be admitted despite the A peak.');
      assert(state.tenants.every(item => item.queued <= LIMITS.queueLimit));
      assert(state.tenants.reduce((sum, item) => sum + item.inflight, 0) <= LIMITS.maxInflight);
      if (mode === 'quota') assert(state.tenants.every(item => item.inflight <= 4));
      else assert(a.inflight > 48, 'A single-group shared configuration must retain the full global generator budget.');
      assert.equal(state.measurement.quotaSimulation, mode === 'quota');
      assert.equal(state.tenants[0].p95Ms, null, 'Uncompleted requests are not fabricated latency samples.');
    } finally { clock.lab.close(); }
  }
});

test('a stalled peak group cannot monopolize generator slots while peers complete in either mode', async () => {
  const multiGroup = { ...config, tenants: config.tenants.map(item => item.id === 'tenantC'
    ? { ...item, runnerBaseUrl: 'http://127.0.0.1:2', gatewayBaseUrl: 'http://127.0.0.1:2/v1', groupId: 'separate', poolId: 'separate-pool' } : item) };
  for (const mode of ['shared', 'quota']) {
    const clock = controlledLab(multiGroup, async (url, { signal }) => {
      const target = new URL(url);
      if (target.port === '2') return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
      });
      return Response.json(target.pathname === '/v1/chat/completions'
        ? { choices: [{ message: { content: 'Harmless test response.' } }] } : { action: 'NONE' });
    });
    try {
      clock.lab.control({ action: 'mode', mode }); clock.lab.control({ action: 'start' });
      clock.lab.control({ action: 'peak', tenantId: 'tenantC', durationSeconds: 30 });
      await clock.advance(5000);
      const state = clock.lab.state(), [a, b, c] = state.tenants;
      assert(a.completed > 10 && b.completed > 10, 'Both tenants in the other group must keep completing pipelines during a stalled peak.');
      assert.equal(a.errors + b.errors, 0, 'A slow foreign group must not cause peer client queue drops.');
      assert.equal(a.queued + b.queued, 0);
      assert.equal(c.inflight, mode === 'shared' ? 48 : 4, 'Group reservation and optional per-tenant quotas must remain separate limits.');
      assert(state.tenants.every(item => item.queued <= LIMITS.queueLimit));
      assert(state.tenants.reduce((sum, item) => sum + item.inflight, 0) <= LIMITS.maxInflight);
      assert.match(state.measurement.occupancyDefinition, /reserve 16 generator slots.*at most 48 of 64/);
    } finally { clock.lab.close(); }
  }
});

test('group reservation counts all member tenants together and scales to three groups', async () => {
  const twoGroups = { ...config, tenants: config.tenants.map(item => item.id === 'tenantC'
    ? { ...item, runnerBaseUrl: 'http://127.0.0.1:2', gatewayBaseUrl: 'http://127.0.0.1:2/v1', groupId: 'separate', poolId: 'separate-pool' } : item) };
  const together = controlledLab(twoGroups);
  try {
    together.lab.control({ action: 'start' });
    for (const tenantId of ['tenantA', 'tenantB']) together.lab.control({ action: 'peak', tenantId, durationSeconds: 30 });
    await together.advance(2000);
    const [a, b, c] = together.lab.state().tenants;
    assert.equal(a.inflight + b.inflight, 48, 'Two tenants in one group must share its 48-slot generator ceiling.');
    assert(c.inflight > 0 && c.queued === 0, 'The separate group must retain admission capacity.');
  } finally { together.lab.close(); }
  const threeGroups = controlledLab({ ...config, tenants: config.tenants.map((item, index) => ({ ...item,
    runnerBaseUrl: `http://127.0.0.1:${index + 1}`, gatewayBaseUrl: `http://127.0.0.1:${index + 1}/v1`, groupId: `group-${index}`, poolId: `pool-${index}` })) });
  try {
    threeGroups.lab.control({ action: 'start' });
    threeGroups.lab.control({ action: 'peak', tenantId: 'tenantC', durationSeconds: 30 });
    await threeGroups.advance(1500);
    const state = threeGroups.lab.state(), [a, b, c] = state.tenants;
    assert.equal(c.inflight, 32, 'A peak must reserve 16 slots for each of the two other groups.');
    assert(a.inflight > 0 && b.inflight > 0);
    assert.match(state.measurement.occupancyDefinition, /at most 32 of 64/);
  } finally { threeGroups.lab.close(); }
});

test('stop cancels scheduler, active HTTP signals and queued jobs; reset clears measurements', async () => {
  const clock = controlledLab();
  try {
    clock.lab.control({ action: 'mode', mode: 'quota' }); clock.lab.control({ action: 'start' });
    clock.lab.control({ action: 'peak', tenantId: 'tenantA', durationSeconds: 30 });
    await clock.advance(2000);
    assert(clock.lab.state().tenants.some(item => item.queued > 0));
    assert(clock.signals.length > 0);
    const stopped = clock.lab.control({ action: 'stop' });
    assert.equal(stopped.running, false); assert.equal(clock.timers.size, 0);
    assert(stopped.tenants.every(item => item.inflight === 0 && item.queued === 0 && item.peakUntil === null));
    assert(clock.signals.every(signal => signal.aborted));
    const startedCalls = clock.signals.length;
    await clock.advance(1000);
    assert.equal(clock.signals.length, startedCalls, 'A stopped scheduler must not create more HTTP work.');
    const reset = clock.lab.control({ action: 'reset' });
    assert(reset.tenants.every(item => item.completed === 0 && item.errors === 0 && item.p95Ms === null));
    assert.equal(reset.history.length, 0);
  } finally { clock.lab.close(); }
});

test('reset and mode changes cannot bypass the rolling global admission limit', async () => {
  const clock = controlledLab();
  const peakAll = () => {
    clock.lab.control({ action: 'start' });
    for (const tenantId of ['tenantA', 'tenantB', 'tenantC']) clock.lab.control({ action: 'peak', tenantId, durationSeconds: 30 });
  };
  try {
    peakAll(); await clock.advance(300);
    assert.equal(clock.signals.length, LIMITS.maxInflight);
    clock.lab.control({ action: 'reset' });
    peakAll(); await clock.advance(300);
    assert.equal(clock.signals.length, LIMITS.maxRps, 'Reset must not forget starts from the preceding second.');
    clock.lab.control({ action: 'mode', mode: 'quota' });
    peakAll(); await clock.advance(100);
    assert.equal(clock.signals.length, LIMITS.maxRps, 'Mode switching must retain the global safety budget.');
  } finally { clock.lab.close(); }
});

test('a restarted generator uses new gateway correlation IDs for the same configured targets', async () => {
  const first = controlledLab(), restarted = controlledLab();
  try {
    first.lab.control({ action: 'start' }); restarted.lab.control({ action: 'start' });
    await first.advance(300); await restarted.advance(300);
    assert(first.callIds.length > 0 && restarted.callIds.length > 0);
    assert(first.callIds.every(id => !restarted.callIds.includes(id)), 'A process restart must not reuse gateway correlation IDs.');
  } finally { first.lab.close(); restarted.lab.close(); }
});

test('strict external gateway configuration refuses the old embedded-model setup and unsafe targets', () => {
  assert.throws(() => validateConfig({ ...config, tenants: config.tenants.map(({ gatewayBaseUrl, gatewayApiKey, model, ...rest }) =>
    ({ ...rest, endpointId: 'old-endpoint', credential: 'old-credential' })) }), /gatewayBaseUrl/);
  const parsed = validateConfig(config);
  assert.equal(parsed.tenants[0].gatewayBaseUrl, 'http://127.0.0.1:1/v1');
  assert.equal(validateConfig({ ...config, tenants: config.tenants.map(t => ({ ...t, gatewayBaseUrl: 'http://127.0.0.1:1' })) }).tenants[0].gatewayBaseUrl,
    'http://127.0.0.1:1/v1');
  assert.equal(validateConfig({ ...config, tenants: config.tenants.map(t => ({ ...t, gatewayBaseUrl: 'http://127.0.0.1:1/proxy/v1/' })) }).tenants[0].gatewayBaseUrl,
    'http://127.0.0.1:1/proxy/v1');
  for (const gatewayBaseUrl of ['file:///private/config', 'http://user:pass@localhost/v1', 'http://localhost/v1?token=secret', 'http://localhost/v1#fragment'])
    assert.throws(() => validateConfig({ ...config, tenants: config.tenants.map(t => ({ ...t, gatewayBaseUrl })) }), /gatewayBaseUrl/);
  for (const gatewayApiKey of ['', 'has space', 'line\nbreak', 'x'.repeat(4097)])
    assert.throws(() => validateConfig({ ...config, tenants: config.tenants.map(t => ({ ...t, gatewayApiKey })) }), /gatewayApiKey/);
  for (const model of ['', ' padded ', null, 'x'.repeat(257)])
    assert.throws(() => validateConfig({ ...config, tenants: config.tenants.map(t => ({ ...t, model })) }), /gateway model/);
  assert.throws(() => validateConfig({ ...config, modelStatusToken: 'secret' }), /requires modelStatusUrl/);
});

test('every completion goes only through its configured gateway and opaque stage metrics remain unavailable', async () => {
  const calls = [];
  const clock = controlledLab(config, async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url: String(url), headers: options.headers, body });
    return Response.json({ choices: [{ message: { content: 'Synthetic gateway completion.' } }] });
  });
  try {
    clock.lab.control({ action: 'start' }); await clock.advance(3000);
    const state = clock.lab.state();
    assert(calls.length >= 3);
    assert(calls.every(call => new URL(call.url).pathname === '/v1/chat/completions'));
    assert(calls.every(call => call.body.model === 'guarded-model' && call.body.stream === false));
    assert(calls.every(call => call.body.messages[0].content === 'Hello.' && call.body.metadata.lab_request_id));
    assert(new Set(calls.map(call => call.headers.authorization)).size === 3);
    assert(state.tenants.every(row => row.completed > 0 && row.p95Ms !== null && row.guardP95Ms === null && row.modelP95Ms === null));
    assert.equal(state.measurement.stageTimingAvailable, false);
    assert.equal(state.measurement.gatewayDecisionDetailsAvailable, false);
    assert.equal(state.fakeLlm.available, false); assert.equal(state.fakeLlm.active, null);
    const encoded = JSON.stringify(state);
    for (const value of ['private-', '127.0.0.1', 'Synthetic gateway completion.']) assert(!encoded.includes(value));
  } finally { clock.lab.close(); }
});

test('gateway HTTP errors, ambiguous policy errors and malformed completions cannot become delivered samples', async () => {
  for (const response of [() => new Response('not JSON'), () => Response.json({}),
    () => Response.json({ choices: [{ message: { content: null } }] }),
    () => Response.json({ error: { message: 'Guardrail blocked or request invalid', code: 400 } }, { status: 400 }),
    () => new Response('Unavailable', { status: 503 }),
    () => Response.json({ choices: [{ message: { content: 'x'.repeat(262145) } }] })]) {
    const clock = controlledLab(config, async () => response());
    try {
      clock.lab.control({ action: 'start' }); await clock.advance(3000);
      assert(clock.lab.state().tenants.every(t => t.errors > 0 && t.completed === 0 && t.blocked === 0 && t.p95Ms === null));
    } finally { clock.lab.close(); }
  }
});

test('lab HTTP service exposes controls and measurements but never an embedded completion model', async () => {
  const service = createLabServer(config, { host: '127.0.0.1', port: 0 }); await service.start();
  const base = `http://127.0.0.1:${service.server.address().port}`;
  try {
    assert.equal((await fetch(base + '/state')).status, 200);
    const completion = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(completion.status, 404);
    const state = service.lab.state();
    assert.equal(state.running, false); assert.equal(state.fakeLlm.source, 'external_service');
    assert.equal(state.fakeLlm.fixedLatencyMs, null); assert.equal(state.fakeLlm.capacity, null);
    assert(!('setModelBaseUrl' in service.lab)); assert(!('fakeLlm' in service.lab));
  } finally { await service.close(); }
});

test('configuration rejects duplicate normalized gateway credential bindings', () => {
  const bad = structuredClone(config);
  bad.tenants[1].gatewayApiKey = bad.tenants[0].gatewayApiKey;
  bad.tenants[1].gatewayBaseUrl += '///';
  assert.throws(() => validateConfig(bad), /distinct gateway credential binding/);
});

test('Runner metrics remain unavailable until real named gauges exist', () => {
  assert.equal(parseRunnerMetrics('unrelated 123\n'), null);
  const metrics = parseRunnerMetrics(`guard_runner_admission_in_flight 3
guard_runner_admission_queue_depth 2
guard_runner_admission_capacity 8
guard_runner_process_cpu_utilization_ratio 0.25
guard_runner_process_resident_memory_bytes 104857600\n`);
  assert.deepEqual(metrics, { inflight: 3, queue: 2, capacity: 8, cpuPercent: 25, memoryMiB: 100 });
});

test('per-tenant Runner configuration inherits legacy defaults and rejects ambiguous pool identities', () => {
  const legacy = validateConfig(config);
  assert.equal(legacy.pools.length, 1);
  assert(legacy.tenants.every(item => item.groupId === 'default' && item.poolId === 'default' && item.runnerBaseUrl === config.runnerBaseUrl));
  const mixed = { ...config, runnerMetricsToken: 'private-metrics-token', tenants: config.tenants.map(item => item.id === 'tenantC'
    ? { ...item, runnerBaseUrl: 'http://127.0.0.1:2', gatewayBaseUrl: 'http://127.0.0.1:2/v1', groupId: 'group-demo', groupName: 'Group Demo', poolId: 'demo-pool' } : item) };
  const parsed = validateConfig(mixed);
  assert.equal(parsed.pools.length, 2);
  assert.equal(parsed.tenants[2].runnerMetricsToken, 'private-metrics-token');
  assert.throws(() => validateConfig({ ...mixed, tenants: mixed.tenants.map(item => ({ ...item, poolId: 'same-pool' })) }), /one Runner address/);
  assert.throws(() => validateConfig({ ...config, tenants: config.tenants.map(item => ({ ...item, poolId: item.id })) }), /one poolId/);
  assert.throws(() => validateConfig({ ...mixed, tenants: mixed.tenants.map(item => item.id === 'tenantC' ? { ...item, runnerBaseUrl: 'file:///private/config' } : item) }), /HTTP URL/);
});

test('actual HTTP traffic uses configured gateways while Runner metrics count each pool once', { timeout: 10000 }, async () => {
  const calls = [], wrongTargets = [], metricCalls = new Map();
  const startGateway = async (poolId, accepted, inflight, capacity, cpu, memory) => {
    const server = createServer(async (request, response) => {
      if (request.url === '/health/ready') { response.end('{"ready":true}'); return; }
      if (request.url === '/metrics') {
        metricCalls.set(poolId, (metricCalls.get(poolId) ?? 0) + 1);
        if (request.headers.authorization !== 'Bearer private-metrics-token') { wrongTargets.push('metrics-token'); response.writeHead(401); response.end(); return; }
        response.end(`guard_runner_admission_in_flight ${inflight}\nguard_runner_admission_queue_depth 0\nguard_runner_admission_capacity ${capacity}\nguard_runner_process_cpu_utilization_ratio ${cpu}\nguard_runner_process_resident_memory_bytes ${memory * 1048576}\n`); return;
      }
      const tenantId = accepted.find(id => request.headers.authorization === `Bearer private-${id}`);
      if (request.url !== '/v1/chat/completions' || !tenantId) { wrongTargets.push(poolId); response.writeHead(401); response.end(); return; }
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); assert.equal(body.model, 'guarded-model'); calls.push({ poolId, tenantId });
      response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"choices":[{"message":{"content":"Gateway completion."}}]}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server;
  };
  const shared = await startGateway('default', ['tenantA', 'tenantB'], 3, 8, 0.25, 100);
  const separate = await startGateway('demo-pool', ['tenantC'], 1, 4, 0.5, 80);
  const address = server => `http://127.0.0.1:${server.address().port}`;
  const service = createLabServer({ ...config, runnerBaseUrl: address(shared), runnerMetricsToken: 'private-metrics-token',
    tenants: config.tenants.map(item => ({ ...item, gatewayBaseUrl: address(item.id === 'tenantC' ? separate : shared), ...(item.id === 'tenantC'
      ? { runnerBaseUrl: address(separate), groupId: 'group-demo', groupName: 'Group Demo', poolId: 'demo-pool' } : {}) })) }, { port: 0 });
  try {
    await service.start(); service.lab.control({ action: 'start' });
    const deadline = Date.now() + 3000;
    while (!service.lab.state().tenants.every(item => item.completed > 0) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    const state = service.lab.state(); assert(state.tenants.every(item => item.completed > 0)); assert.deepEqual(wrongTargets, []);
    for (const tenantId of ['tenantA', 'tenantB', 'tenantC'])
      assert(calls.some(item => item.tenantId === tenantId && item.poolId === (tenantId === 'tenantC' ? 'demo-pool' : 'default')));
    assert.deepEqual(state.groups, [
      { id: 'default', name: 'Default group', tenantIds: ['tenantA', 'tenantB'], poolIds: ['default'], runner: { ready: true, metricsAvailable: true, inflight: 3, queue: 0, capacity: 8, cpuPercent: 25, memoryMiB: 100 } },
      { id: 'group-demo', name: 'Group Demo', tenantIds: ['tenantC'], poolIds: ['demo-pool'], runner: { ready: true, metricsAvailable: true, inflight: 1, queue: 0, capacity: 4, cpuPercent: 50, memoryMiB: 80 } },
    ]);
    assert.deepEqual(state.runner, { ready: true, inflight: 4, queue: 0, capacity: 12, cpuPercent: 75, memoryMiB: 180 });
    assert.equal(metricCalls.get('default'), metricCalls.get('demo-pool'));
    const encoded = JSON.stringify(state); assert(!encoded.includes('private-') && !encoded.includes('127.0.0.1'));
  } finally { await service.close(); for (const server of [shared, separate]) { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); } }
});

test('external model status is read-only authenticated diagnostics and failures clear stale values', async () => {
  let failing = false; const requests = [];
  const lab = createLab({ ...config, modelStatusUrl: 'http://127.0.0.1:3/state', modelStatusToken: 'private-status-token' }, { fetch: async (url, options = {}) => {
    const target = new URL(url); requests.push({ path: target.pathname, method: options.method ?? 'GET', headers: options.headers });
    if (target.pathname === '/state') {
      assert.equal(options.headers.authorization, 'Bearer private-status-token');
      return failing ? new Response('Unavailable', { status: 503 }) : Response.json({ fixedLatencyMs: 120, p95Ms: 122, active: 2, capacity: 1024, completed: 17 });
    }
    return target.pathname === '/health/ready' ? Response.json({ ready: true }) : new Response('guard_runner_admission_in_flight 0\nguard_runner_admission_queue_depth 0\nguard_runner_admission_capacity 2');
  } });
  try {
    await lab.observeRunner(); assert.deepEqual(lab.state().fakeLlm, { source: 'external_service', available: true, fixedLatencyMs: 120, p95Ms: 122, active: 2, capacity: 1024, completed: 17 });
    lab.control({ action: 'reset' }); assert.equal(lab.state().fakeLlm.completed, 17, 'Resetting the generator cannot reset a separate service.');
    failing = true; await lab.observeRunner();
    assert.deepEqual(lab.state().fakeLlm, { source: 'external_service', available: false, fixedLatencyMs: null, p95Ms: null, active: null, capacity: null, completed: null });
    assert(requests.every(request => request.method === 'GET')); assert(!JSON.stringify(lab.state()).includes('private-status-token'));
  } finally { lab.close(); }
});

test('malformed or oversized external model diagnostics fail closed without invented gauges', async () => {
  for (const body of [ { fixedLatencyMs: 120 }, { fixedLatencyMs: 120, p95Ms: 1, active: 5, capacity: 2, completed: 3 },
    { fixedLatencyMs: 120, p95Ms: 1, active: 0, capacity: 2, completed: -1 }, { padding: 'x'.repeat(16385) } ]) {
    const lab = createLab({ ...config, modelStatusUrl: 'http://127.0.0.1:3/state' }, { fetch: async url =>
      new URL(url).pathname === '/state' ? Response.json(body) : new Response('', { status: 503 }) });
    try { await lab.observeRunner(); assert.equal(lab.state().fakeLlm.available, false); assert.equal(lab.state().fakeLlm.active, null); }
    finally { lab.close(); }
  }
});

test('a failed group metrics scrape clears only that group while healthy group measurements remain real', async () => {
  let failed = false;
  const lab = createLab({ ...config, tenants: config.tenants.map(item => item.id === 'tenantC'
    ? { ...item, runnerBaseUrl: 'http://127.0.0.1:2', gatewayBaseUrl: 'http://127.0.0.1:2/v1', groupId: 'group-demo', poolId: 'demo-pool' } : item) }, {
    fetch: async url => {
      const target = new URL(url);
      if (target.pathname === '/health/ready') return Response.json({ ready: true });
      if (failed && target.port === '2') return new Response('Unavailable', { status: 503 });
      return new Response('guard_runner_admission_in_flight 2\nguard_runner_admission_queue_depth 1\nguard_runner_admission_capacity 8\nguard_runner_process_cpu_utilization_ratio 0.25\nguard_runner_process_resident_memory_bytes 104857600\n');
    },
  });
  try {
    await lab.observeRunner();
    assert(lab.state().groups.every(group => group.runner.metricsAvailable));
    failed = true; await lab.observeRunner();
    const state = lab.state();
    assert.deepEqual(state.groups[1].runner, { ready: true, metricsAvailable: false, inflight: 0, queue: 0, capacity: 0 });
    assert.equal(state.groups[0].runner.cpuPercent, 25);
    assert.equal(state.groups[0].runner.inflight, 2);
    assert.equal(state.measurement.runnerMetricsAvailable, false);
    assert(!('cpuPercent' in state.runner));
  } finally { lab.close(); }
});

test('failed Runner scrapes remove stale CPU/memory instead of displaying them as current', async () => {
  let scrapes = 0;
  const lab = createLab(config, { fetch: async url => {
    if (new URL(url).pathname === '/health/ready') return Response.json({ ready: true });
    if (++scrapes > 1) return new Response('Unavailable', { status: 503 });
    return new Response(`guard_runner_admission_in_flight 3\nguard_runner_admission_queue_depth 2\nguard_runner_admission_capacity 8\nguard_runner_process_cpu_utilization_ratio 0.25\nguard_runner_process_resident_memory_bytes 104857600\n`);
  } });
  try {
    await lab.observeRunner();
    assert.equal(lab.state().measurement.runnerMetricsAvailable, true);
    assert.equal(lab.state().runner.cpuPercent, 25);
    await lab.observeRunner();
    assert.equal(lab.state().measurement.runnerMetricsAvailable, false);
    assert.deepEqual(lab.state().runner, { ready: true, inflight: 0, queue: 0, capacity: 0 });
  } finally { lab.close(); }
});

test('history stays empty before Start and continues sampling an existing experiment after Stop', () => {
  const clock = controlledLab();
  try {
    clock.lab.sample();
    assert.deepEqual(clock.lab.state().history, []);
    clock.lab.control({ action: 'start' }); clock.lab.sample();
    assert.equal(clock.lab.state().history.length, 1);
    clock.lab.control({ action: 'stop' }); clock.lab.sample();
    assert.equal(clock.lab.state().history.length, 2);
  } finally { clock.lab.close(); }
});

test('the CLI starts through a ConfigMap-style symlink without starting guard traffic', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tenant-load-lab-cli-'));
  let child;
  try {
    const mounted = join(directory, 'tenant-load-lab.mjs');
    const data = join(directory, '..2026_10_26');
    await mkdir(data);
    await symlink(fileURLToPath(new URL('./tenant-load-lab.mjs', import.meta.url)), join(data, 'tenant-load-lab.mjs'));
    await symlink('..2026_10_26', join(directory, '..data'));
    await symlink('..data/tenant-load-lab.mjs', mounted);
    const configuration = join(directory, 'fixtures.json');
    await writeFile(configuration, JSON.stringify(config), { mode: 0o600 });
    child = spawn(process.execPath, [mounted], { env: { ...process.env, TENANT_LOAD_LAB_CONFIG: configuration,
      TENANT_LOAD_LAB_HOST: '127.0.0.1', TENANT_LOAD_LAB_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const address = await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('Symlinked CLI did not report a listening socket.')), 5000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`CLI exited before listening (code ${code}).`)); });
      child.stdout.on('data', bytes => {
        output += bytes.toString();
        const match = /listening on 127\.0\.0\.1:(\d+)/.exec(output);
        if (match) { clearTimeout(timeout); resolve(`http://127.0.0.1:${match[1]}`); }
      });
    });
    const response = await fetch(`${address}/state`);
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.running, false);
    assert(state.tenants.every(tenant => tenant.completed === 0 && tenant.inflight === 0));
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited; clearTimeout(timeout);
    }
    await rm(directory, { recursive: true, force: true });
  }
});
