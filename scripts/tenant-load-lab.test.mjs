import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLab, createLabServer, LIMITS, peakDurationSeconds, parseRunnerMetrics, runGuardedChat, validateConfig } from './tenant-load-lab.mjs';

const config = { runnerBaseUrl: 'http://127.0.0.1:1', peakRps: 80,
  tenants: ['tenantA', 'tenantB', 'tenantC'].map(id => ({ id, name: id, endpointId: `endpoint-${id}`, credential: 'synthetic-test-only' })) };

function controlledLab(configuration = config, transport) {
  let time = 100000, nextTimer = 0;
  const timers = new Map(), signals = [], callIds = [];
  const lab = createLab(configuration, { now: () => time, random: () => 0.5,
    setInterval: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearInterval: id => timers.delete(id),
    fetch: async (url, { signal, body }) => {
      signals.push(signal);
      callIds.push(JSON.parse(body).litellm_call_id);
      if (transport) return transport(url, { signal, body });
      return new Promise((resolve, reject) => {
        if (signal.aborted) reject(new Error('Aborted'));
        else signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
      });
    } });
  lab.setModelBaseUrl('http://127.0.0.1:38110');
  return { lab, timers, signals, callIds,
    async advance(ms) { for (let i = 0; i < ms; i += 25) { time += 25; lab.tick(); await Promise.resolve(); } },
    setTime(value) { time = value; }, now: () => time };
}

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
    ? { ...item, runnerBaseUrl: 'http://127.0.0.1:2', groupId: 'separate', poolId: 'separate-pool' } : item) };
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
    ? { ...item, runnerBaseUrl: 'http://127.0.0.1:2', groupId: 'separate', poolId: 'separate-pool' } : item) };
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
    runnerBaseUrl: `http://127.0.0.1:${index + 1}`, groupId: `group-${index}`, poolId: `pool-${index}` })) });
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

test('a restarted workload instance uses new Runner call IDs for the same endpoints', async () => {
  const first = controlledLab(), restarted = controlledLab();
  try {
    first.lab.control({ action: 'start' }); restarted.lab.control({ action: 'start' });
    await first.advance(300); await restarted.advance(300);
    assert(first.callIds.length > 0 && restarted.callIds.length > 0);
    assert(first.callIds.every(id => !restarted.callIds.includes(id)), 'A process restart must not reuse retained Runner contexts.');
  } finally { first.lab.close(); restarted.lab.close(); }
});

test('fixed local HTTP model admits concurrent calls without a shared service queue', async () => {
  const service = createLabServer(config, { host: '127.0.0.1', port: 0 });
  await service.start();
  const base = `http://127.0.0.1:${service.server.address().port}`;
  try {
    assert.equal(service.lab.state().running, false);
    const started = performance.now();
    const calls = Array.from({ length: 24 }, () => fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [] }),
    }));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert(service.lab.state().fakeLlm.active >= 12, 'Model requests should overlap, not serialize.');
    const responses = await Promise.all(calls);
    assert(responses.every(response => response.status === 200));
    const values = await Promise.all(responses.map(response => response.json()));
    assert(values.every(value => value.choices[0].message.content === 'A brief, harmless local test response.'));
    const elapsed = performance.now() - started;
    assert(elapsed < 120 * 4, `Concurrent fixed model took ${elapsed}ms; a serial queue would take 2880ms.`);
    const state = service.lab.state();
    assert.equal(state.fakeLlm.completed, 24); assert.equal(state.fakeLlm.active, 0);
    assert(state.fakeLlm.p95Ms >= 110 && state.fakeLlm.p95Ms < 300);
    assert.equal(state.running, false, 'Direct model checks must not start Runner traffic.');
    assert(!JSON.stringify(state).includes('synthetic-test-only'));
  } finally { await service.close(); }
});

test('real HTTP pipeline performs input, measured local model HTTP, then output and records measured results', async () => {
  const phases = [];
  const runner = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(request.url === '/health/ready' ? 200 : 404, { 'content-type': 'application/json' });
      response.end(JSON.stringify(request.url === '/health/ready' ? { ready: true } : {}));
      return;
    }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); phases.push(body.input_type);
    assert.equal(request.headers['x-api-key'], 'synthetic-test-only');
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ action: 'NONE' }));
  });
  await new Promise(resolve => runner.listen(0, '127.0.0.1', resolve));
  const service = createLabServer({ ...config, runnerBaseUrl: `http://127.0.0.1:${runner.address().port}` }, { port: 0 });
  await service.start();
  try {
    service.lab.control({ action: 'start' });
    const deadline = Date.now() + 2500;
    while (!service.lab.state().tenants.some(item => item.completed > 0) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    const state = service.lab.state();
    assert(state.tenants.some(item => item.completed > 0 && item.modelP95Ms >= 110 && item.p95Ms >= item.modelP95Ms));
    assert(phases.includes('request') && phases.includes('response'));
    service.lab.control({ action: 'mode', mode: 'quota' });
    assert.equal(service.lab.state().running, false, 'A mode switch resets and requires an explicit Start.');
  } finally { await service.close(); runner.closeIdleConnections(); await new Promise(resolve => runner.close(resolve)); }
});

test('complete gateway forwards protected input to the model and returns protected output on the same call', async () => {
  for (const replacement of ['Protected input.', '']) {
    const checks = [], completions = [];
    const result = await runGuardedChat({ callId: 'same-call', input: 'Original input.',
      guard: async payload => {
        checks.push(payload);
        return { action: 'GUARDRAIL_INTERVENED', texts: [payload.input_type === 'request' ? replacement : 'Protected output.'] };
      },
      model: async payload => { completions.push(payload); return { choices: [{ message: { content: 'Original output.' } }] }; },
    });
    assert.equal(result.status, 'delivered');
    assert.equal(result.content, 'Protected output.');
    assert.equal(result.transformed, true);
    assert.deepEqual(completions[0].messages, [{ role: 'user', content: replacement }]);
    assert.deepEqual(checks.map(item => item.litellm_call_id), ['same-call', 'same-call']);
    assert.deepEqual(checks.map(item => item.texts), [['Original input.'], ['Original output.']]);
    assert(checks.every(item => item.model === completions[0].model));
    assert.deepEqual(checks[1].structured_messages, completions[0].messages);
  }
  const original = await runGuardedChat({ callId: 'untouched', guard: async () => ({ action: 'NONE' }),
    model: async () => ({ choices: [{ message: { content: 'Original output.' } }] }) });
  assert.equal(original.content, 'Original output.'); assert.equal(original.transformed, false);
  const emptyOutput = await runGuardedChat({ callId: 'empty-output',
    guard: async payload => payload.input_type === 'request' ? { action: 'NONE' } : { action: 'GUARDRAIL_INTERVENED', texts: [''] },
    model: async () => ({ choices: [{ message: { content: 'Withheld output.' } }] }) });
  assert.equal(emptyOutput.content, '');
});

test('Input and Output blocks stop the gateway before later stages or client delivery', async () => {
  for (const blockedPhase of ['input', 'output']) {
    const stages = [];
    const result = await runGuardedChat({ callId: 'blocked-call',
      guard: async payload => {
        stages.push(payload.input_type);
        return { action: payload.input_type === (blockedPhase === 'input' ? 'request' : 'response') ? 'BLOCKED' : 'NONE' };
      },
      model: async () => { stages.push('model'); return { choices: [{ message: { content: 'Private synthetic output.' } }] }; },
    });
    assert.deepEqual(result, { status: 'blocked', blockedPhase });
    assert.deepEqual(stages, blockedPhase === 'input' ? ['request'] : ['request', 'model', 'response']);
    assert(!('content' in result), 'A blocked response must never be delivered.');
  }
});

test('unknown decisions and malformed replacements fail closed at either guard stage', async () => {
  for (const invalidDecision of [null, {}, { action: 'allow' }, { action: 'GUARDRAIL_INTERVENED' },
    { action: 'GUARDRAIL_INTERVENED', texts: [] }, { action: 'GUARDRAIL_INTERVENED', texts: [null] },
    { action: 'GUARDRAIL_INTERVENED', texts: ['one', 'extra'] }]) {
    for (const phase of ['request', 'response']) {
      let modelCalls = 0;
      await assert.rejects(runGuardedChat({ callId: 'invalid-call',
        guard: async payload => payload.input_type === phase ? invalidDecision : { action: 'NONE' },
        model: async () => { modelCalls++; return { choices: [{ message: { content: 'Synthetic output.' } }] }; },
      }), /Runner decision was invalid/);
      assert.equal(modelCalls, phase === 'request' ? 0 : 1);
    }
  }
});

test('blocks, deliveries and failures have distinct counters and only delivered pipelines enter latency and throughput', async () => {
  const clock = controlledLab(config, async (url, { body }) => {
    const payload = JSON.parse(body), target = new URL(url);
    if (target.pathname === '/v1/chat/completions') {
      assert.equal(payload.messages[0].content, 'Protected input.');
      return Response.json({ choices: [{ message: { content: 'Private synthetic output.' } }] });
    }
    if (target.pathname.includes('endpoint-tenantA')) return Response.json({ action: 'BLOCKED' });
    if (target.pathname.includes('endpoint-tenantC')) return Response.json({ action: 'UNKNOWN' });
    return Response.json({ action: 'GUARDRAIL_INTERVENED', texts: [payload.input_type === 'request' ? 'Protected input.' : 'Protected output.'] });
  });
  try {
    clock.lab.control({ action: 'start' }); await clock.advance(3000);
    const state = clock.lab.state(), [a, b, c] = state.tenants;
    assert(a.blocked > 0 && a.inputBlocked === a.blocked && a.outputBlocked === 0);
    assert.equal(a.completed + a.errors + a.completedRps, 0); assert.equal(a.p95Ms, null);
    assert(b.completed > 0 && b.completedRps > 0 && b.transformed === b.completed);
    assert.equal(b.blocked + b.errors, 0); assert.notEqual(b.guardP95Ms, null);
    assert(c.errors > 0); assert.equal(c.completed + c.blocked + c.completedRps, 0); assert.equal(c.modelP95Ms, null);
    const serialized = JSON.stringify(state);
    for (const content of ['Private synthetic output.', 'Protected output.', 'Protected input.']) assert(!serialized.includes(content));
    const reset = clock.lab.control({ action: 'reset' });
    assert(reset.tenants.every(item => item.blocked + item.inputBlocked + item.outputBlocked + item.transformed === 0));
  } finally { clock.lab.close(); }
  const outputBlocked = controlledLab(config, async (url, { body }) => {
    const payload = JSON.parse(body);
    return Response.json(new URL(url).pathname === '/v1/chat/completions' ? { choices: [{ message: { content: 'Blocked output.' } }] }
      : { action: payload.input_type === 'request' ? 'NONE' : 'BLOCKED' });
  });
  try {
    outputBlocked.lab.control({ action: 'start' }); await outputBlocked.advance(3000);
    assert(outputBlocked.lab.state().tenants.every(item => item.outputBlocked > 0 && item.outputBlocked === item.blocked
      && item.inputBlocked + item.completed + item.errors + item.completedRps === 0 && item.p95Ms === null));
  } finally { outputBlocked.lab.close(); }
});

test('model and guard transport or JSON failures cannot become successful pipeline samples', async () => {
  for (const failedStage of ['request', 'model', 'response']) {
    const clock = controlledLab(config, async (url, { body }) => {
      const payload = JSON.parse(body), model = new URL(url).pathname === '/v1/chat/completions';
      if ((model ? 'model' : payload.input_type) === failedStage) return new Response('not JSON', { status: failedStage === 'model' ? 502 : 200 });
      return Response.json(model ? { choices: [{ message: { content: 'Synthetic output.' } }] } : { action: 'NONE' });
    });
    try {
      clock.lab.control({ action: 'start' }); await clock.advance(3000);
      assert(clock.lab.state().tenants.every(item => item.errors > 0 && item.completed + item.blocked + item.completedRps === 0 && item.p95Ms === null));
    } finally { clock.lab.close(); }
  }
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
    ? { ...item, runnerBaseUrl: 'http://127.0.0.1:2', groupId: 'group-demo', groupName: 'Group Demo', poolId: 'demo-pool' } : item) };
  const parsed = validateConfig(mixed);
  assert.equal(parsed.pools.length, 2);
  assert.equal(parsed.tenants[2].runnerMetricsToken, 'private-metrics-token');
  assert.throws(() => validateConfig({ ...mixed, tenants: mixed.tenants.map(item => ({ ...item, poolId: 'same-pool' })) }), /one Runner address/);
  assert.throws(() => validateConfig({ ...config, tenants: config.tenants.map(item => ({ ...item, poolId: item.id })) }), /one poolId/);
  assert.throws(() => validateConfig({ ...mixed, tenants: mixed.tenants.map(item => item.id === 'tenantC' ? { ...item, runnerBaseUrl: 'file:///private/config' } : item) }), /HTTP URL/);
});

test('actual HTTP pipelines target each configured Runner and group gauges count a shared pool only once', { timeout: 10000 }, async () => {
  const calls = [], wrongTargets = [], metricCalls = new Map();
  const credentials = new Map(config.tenants.map(item => [item.id, `private-${item.id}`]));
  const startRunner = async (poolId, accepted, inflight, capacity, cpu, memory) => {
    const server = createServer(async (request, response) => {
      if (request.url === '/health/ready') {
        response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ready":true}'); return;
      }
      if (request.url === '/metrics') {
        metricCalls.set(poolId, (metricCalls.get(poolId) ?? 0) + 1);
        if (request.headers.authorization !== 'Bearer private-metrics-token') { wrongTargets.push('metrics-token'); response.writeHead(401); response.end(); return; }
        response.end(`guard_runner_admission_in_flight ${inflight}\nguard_runner_admission_queue_depth 0\nguard_runner_admission_capacity ${capacity}\nguard_runner_process_cpu_utilization_ratio ${cpu}\nguard_runner_process_resident_memory_bytes ${memory * 1048576}\n`); return;
      }
      const tenantId = accepted.find(id => request.url === `/runtime/v1/endpoints/endpoint-${id}/beta/litellm_basic_guardrail_api`);
      let raw = ''; for await (const chunk of request) raw += chunk;
      if (!tenantId || request.headers['x-api-key'] !== credentials.get(tenantId)) {
        wrongTargets.push(poolId); response.writeHead(401); response.end(); return;
      }
      calls.push({ poolId, tenantId, phase: JSON.parse(raw).input_type });
      response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"action":"NONE"}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return server;
  };
  const sharedRunner = await startRunner('default', ['tenantA', 'tenantB'], 3, 8, 0.25, 100);
  const separateRunner = await startRunner('demo-pool', ['tenantC'], 1, 4, 0.5, 80);
  const service = createLabServer({ ...config, runnerBaseUrl: `http://127.0.0.1:${sharedRunner.address().port}`, runnerMetricsToken: 'private-metrics-token',
    tenants: config.tenants.map(item => ({ ...item, credential: credentials.get(item.id), ...(item.id === 'tenantC'
      ? { runnerBaseUrl: `http://127.0.0.1:${separateRunner.address().port}`, groupId: 'group-demo', groupName: 'Group Demo', poolId: 'demo-pool' } : {}) })) }, { port: 0 });
  try {
    await service.start(); service.lab.control({ action: 'start' });
    const deadline = Date.now() + 3000;
    while (!service.lab.state().tenants.every(item => item.completed > 0) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    const state = service.lab.state();
    assert(state.tenants.every(item => item.completed > 0), 'Every tenant must complete both guard phases through its assigned Runner.');
    assert.deepEqual(wrongTargets, []);
    for (const tenantId of ['tenantA', 'tenantB', 'tenantC']) for (const phase of ['request', 'response'])
      assert(calls.some(item => item.tenantId === tenantId && item.phase === phase && item.poolId === (tenantId === 'tenantC' ? 'demo-pool' : 'default')));
    assert.deepEqual(state.groups, [
      { id: 'default', name: 'Default group', tenantIds: ['tenantA', 'tenantB'], poolIds: ['default'],
        runner: { ready: true, metricsAvailable: true, inflight: 3, queue: 0, capacity: 8, cpuPercent: 25, memoryMiB: 100 } },
      { id: 'group-demo', name: 'Group Demo', tenantIds: ['tenantC'], poolIds: ['demo-pool'],
        runner: { ready: true, metricsAvailable: true, inflight: 1, queue: 0, capacity: 4, cpuPercent: 50, memoryMiB: 80 } },
    ]);
    assert.deepEqual(state.runner, { ready: true, inflight: 4, queue: 0, capacity: 12, cpuPercent: 75, memoryMiB: 180 });
    assert.equal(metricCalls.get('default'), metricCalls.get('demo-pool'), 'Shared A/B pool must be scraped once per monitoring pass.');
    service.lab.sample();
    assert.deepEqual(service.lab.state().history.at(-1).groups, Object.fromEntries(state.groups.map(group => [group.id, group.runner])));
    const serialized = JSON.stringify(service.lab.state());
    assert(!serialized.includes('private-') && !serialized.includes('127.0.0.1'), 'State must not reveal addresses or credentials.');
  } finally {
    await service.close();
    for (const server of [sharedRunner, separateRunner]) { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); }
  }
});

test('a failed group metrics scrape clears only that group while healthy group measurements remain real', async () => {
  let failed = false;
  const lab = createLab({ ...config, tenants: config.tenants.map(item => item.id === 'tenantC'
    ? { ...item, runnerBaseUrl: 'http://127.0.0.1:2', groupId: 'group-demo', poolId: 'demo-pool' } : item) }, {
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
