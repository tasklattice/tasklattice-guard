#!/usr/bin/env node
/**
 * Private, opt-in tenant load demonstration. Node 24; no dependencies.
 * Each admitted client pipeline calls the REAL Runner input endpoint, then,
 * if allowed, the local fixed-delay HTTP model and REAL Runner output endpoint. Quotas below
 * belong to this load generator, not to the Guard Runner product.
 * Multi-group configurations reserve 16 generator slots for every other group;
 * this prevents client admission from masking separate Runner behavior.
 *
 * TENANT_LOAD_LAB_CONFIG=/private/config.json node scripts/tenant-load-lab.mjs
 * Config: {runnerBaseUrl, runnerMetricsToken?, peakRps?, tenants:[
 *   {id:'tenantA',name:'Tenant A',endpointId,credential,
 *    runnerBaseUrl?,runnerMetricsToken?,groupId?,groupName?,poolId?}, ... B/C ...]}
 * Bind: TENANT_LOAD_LAB_HOST=127.0.0.1, TENANT_LOAD_LAB_PORT=38110.
 * Starting the server does not start guard traffic. POST /control action=start.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const LIMITS = Object.freeze({ maxRps: 120, maxInflight: 64, queueLimit: 32 });
export const FIXED_MODEL_LATENCY_MS = 120;
export const BASELINE_MIN_RPS = 3;
export const BASELINE_MAX_RPS = 5;
export const BASELINE_INITIAL_RPS = 4;
const TENANT_IDS = ['tenantA', 'tenantB', 'tenantC'];
const COLORS = ['#5b8ff9', '#eab75a', '#8bd3ac'];
const SAMPLE_INTERVAL_MS = 1000;
const METRIC_WINDOW_MS = 15000;
const MAX_SAMPLES = 2400;
const SLOT_BUDGET = 4;
export const GROUP_RESERVED_SLOTS = 16;
export const QUOTA_RPS = 10;
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function invalid(message) { return Object.assign(new Error(message), { status: 400 }); }
export function peakDurationSeconds(value = 30) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid('durationSeconds must be a finite number.');
  return Math.max(15, Math.min(60, Math.round(value)));
}
export function validateConfig(value) {
  if (!value || typeof value !== 'object') throw invalid('Load lab configuration is required.');
  const runnerUrl = raw => {
    let base;
    try { base = new URL(raw); } catch { throw invalid('runnerBaseUrl must be an HTTP URL.'); }
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw invalid('runnerBaseUrl must be an HTTP URL without credentials.');
    return base.origin;
  };
  const metricsToken = raw => {
    if (raw !== null && (typeof raw !== 'string' || /[\r\n]/.test(raw))) throw invalid('runnerMetricsToken must be a string without line breaks.');
    return raw;
  };
  const label = (raw, fallback, maximum) => {
    const result = raw ?? fallback;
    if (typeof result !== 'string' || !result.trim() || result.length > maximum) throw invalid('Runner pool and group labels must be nonempty bounded strings.');
    return result;
  };
  const base = value.runnerBaseUrl === undefined ? null : runnerUrl(value.runnerBaseUrl);
  const token = metricsToken(value.runnerMetricsToken ?? process.env.TENANT_LOAD_LAB_RUNNER_METRICS_TOKEN ?? null);
  if (!Array.isArray(value.tenants) || value.tenants.length !== 3) throw invalid('Configure tenantA, tenantB and tenantC.');
  const urls = base ? [base] : [];
  const tenants = TENANT_IDS.map((id, index) => {
    const matches = value.tenants.filter(item => item?.id === id);
    if (matches.length !== 1 || typeof matches[0].endpointId !== 'string' || !matches[0].endpointId ||
      typeof matches[0].credential !== 'string' || !matches[0].credential) throw invalid(`Missing endpoint configuration for ${id}.`);
    const item = matches[0], target = runnerUrl(item.runnerBaseUrl ?? base);
    if (!urls.includes(target)) urls.push(target);
    const groupId = label(item.groupId, 'default', 128);
    return { id, name: String(item.name ?? `Tenant ${id.at(-1)}`).slice(0, 80), color: COLORS[index],
      endpointId: item.endpointId, credential: item.credential, runnerBaseUrl: target,
      runnerMetricsToken: metricsToken(item.runnerMetricsToken ?? token),
      groupId, groupName: label(item.groupName, groupId === 'default' ? 'Default group' : groupId, 80),
      poolId: label(item.poolId, target === base ? 'default' : `configured-pool-${urls.indexOf(target) + 1}`, 128) };
  });
  const pools = [];
  const groupNames = new Map();
  for (const tenant of tenants) {
    const existing = pools.find(pool => pool.id === tenant.poolId);
    if (pools.some(pool => pool.runnerBaseUrl === tenant.runnerBaseUrl && pool.id !== tenant.poolId))
      throw invalid('One Runner address must use one poolId so its measurements are not counted twice.');
    if (existing && (existing.groupId !== tenant.groupId || existing.runnerBaseUrl !== tenant.runnerBaseUrl || existing.runnerMetricsToken !== tenant.runnerMetricsToken))
      throw invalid('Each poolId must identify one Runner address, metrics token and tenant group.');
    if (groupNames.has(tenant.groupId) && groupNames.get(tenant.groupId) !== tenant.groupName) throw invalid('A groupId must have one groupName.');
    groupNames.set(tenant.groupId, tenant.groupName);
    if (!existing) pools.push({ id: tenant.poolId, groupId: tenant.groupId, groupName: tenant.groupName,
      runnerBaseUrl: tenant.runnerBaseUrl, runnerMetricsToken: tenant.runnerMetricsToken });
  }
  const peakRps = value.peakRps === undefined ? 60 : value.peakRps;
  if (typeof peakRps !== 'number' || !Number.isFinite(peakRps)) throw invalid('peakRps must be numeric.');
  return { runnerBaseUrl: base, runnerMetricsToken: token, tenants, pools, peakRps: Math.max(12, Math.min(80, peakRps)) };
}

export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] * 10) / 10;
}
function pruneTimes(values, cutoff) { while (values.length && values[0] <= cutoff) values.shift(); }
function trimSamples(samples, now) {
  while (samples.length && (samples[0].time < now - METRIC_WINDOW_MS || samples.length > MAX_SAMPLES)) samples.shift();
}
function sendJson(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, jsonHeaders); response.end(JSON.stringify(value));
}
async function readJson(request, maximum = 16384) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw invalid('A JSON request body is required.'); }
}
export function parseRunnerMetrics(text) {
  const wanted = new Set(['guard_runner_admission_in_flight', 'guard_runner_admission_queue_depth',
    'guard_runner_admission_capacity', 'guard_runner_process_cpu_utilization_ratio', 'guard_runner_process_resident_memory_bytes']);
  const found = {};
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][\w:]*)(?:\{[^}]*\})?\s+([-+0-9.eE]+)(?:\s|$)/.exec(line);
    if (match && wanted.has(match[1]) && Number.isFinite(Number(match[2]))) found[match[1]] = (found[match[1]] ?? 0) + Number(match[2]);
  }
  if (!['guard_runner_admission_in_flight', 'guard_runner_admission_queue_depth', 'guard_runner_admission_capacity'].every(key => key in found)) return null;
  return { inflight: found.guard_runner_admission_in_flight, queue: found.guard_runner_admission_queue_depth,
    capacity: found.guard_runner_admission_capacity,
    ...('guard_runner_process_cpu_utilization_ratio' in found ? { cpuPercent: found.guard_runner_process_cpu_utilization_ratio * 100 } : {}),
    ...('guard_runner_process_resident_memory_bytes' in found ? { memoryMiB: found.guard_runner_process_resident_memory_bytes / 1048576 } : {}) };
}

export function createFakeLlm({ now = Date.now, setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: cancel = globalThis.clearTimeout } = {}) {
  const pending = new Set();
  const samples = [];
  let completed = 0;
  return {
    async handle(request, response) {
      await readJson(request);
      if (pending.size >= 1024) { sendJson(response, 429, { error: 'Local model capacity reached.' }); return; }
      const started = now();
      let finished = false;
      const finish = (cancelled) => {
        if (finished) return;
        finished = true; cancel(entry.timer); pending.delete(entry);
        if (cancelled) { response.destroy(); return; }
        completed++; samples.push({ time: now(), duration: Math.max(0, now() - started) }); trimSamples(samples, now());
        sendJson(response, 200, { id: 'tenant-load-lab-local', object: 'chat.completion', model: 'local-fixed-delay',
          choices: [{ index: 0, message: { role: 'assistant', content: 'A brief, harmless local test response.' }, finish_reason: 'stop' }] });
      };
      const entry = { timer: null, cancel: () => finish(true) };
      pending.add(entry);
      entry.timer = schedule(() => finish(false), FIXED_MODEL_LATENCY_MS);
      response.once('close', () => { if (!response.writableEnded) finish(true); });
      request.once('aborted', entry.cancel);
    },
    state() {
      trimSamples(samples, now());
      return { fixedLatencyMs: FIXED_MODEL_LATENCY_MS, p95Ms: percentile(samples.map(item => item.duration), 0.95),
        active: pending.size, capacity: 1024, completed };
    },
    cancelAll() { for (const entry of [...pending]) entry.cancel(); },
    reset() { this.cancelAll(); samples.length = 0; completed = 0; },
  };
}

/** Apply the normal complete-text gateway contract; returned content is never put in lab state. */
export async function runGuardedChat({ guard, model, callId, now = Date.now, input = 'Hello.', modelName = 'local-fixed-delay' }) {
  let guardMs = 0;
  const originalMessages = [{ role: 'user', content: input }];
  const check = async (input_type, text, messages) => {
    const started = now();
    const decision = await guard({ input_type, litellm_call_id: callId, texts: [text],
      structured_messages: messages, model: modelName });
    guardMs += Math.max(0, now() - started);
    if (decision?.action === 'BLOCKED') return { blocked: true };
    if (decision?.action === 'NONE') return { text, transformed: false };
    if (decision?.action === 'GUARDRAIL_INTERVENED' && Array.isArray(decision.texts)
      && decision.texts.length === 1 && typeof decision.texts[0] === 'string')
      return { text: decision.texts[0], transformed: true };
    throw new Error('The Runner decision was invalid.');
  };
  const checkedInput = await check('request', input, originalMessages);
  if (checkedInput.blocked) return { status: 'blocked', blockedPhase: 'input' };
  const messages = [{ role: 'user', content: checkedInput.text }];
  const modelStarted = now();
  const completion = await model({ model: modelName, messages });
  const modelMs = Math.max(0, now() - modelStarted);
  const content = completion?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('The local model response was malformed.');
  const checkedOutput = await check('response', content, messages);
  if (checkedOutput.blocked) return { status: 'blocked', blockedPhase: 'output' };
  return { status: 'delivered', content: checkedOutput.text, guardMs, modelMs,
    transformed: checkedInput.transformed || checkedOutput.transformed };
}

export function createLab(rawConfig, dependencies = {}) {
  const config = validateConfig(rawConfig);
  const groupCount = new Set(config.tenants.map(tenant => tenant.groupId)).size;
  const groupInflightLimit = LIMITS.maxInflight - GROUP_RESERVED_SLOTS * (groupCount - 1);
  const now = dependencies.now ?? Date.now;
  const random = dependencies.random ?? Math.random;
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const interval = dependencies.setInterval ?? globalThis.setInterval;
  const clear = dependencies.clearInterval ?? globalThis.clearInterval;
  const fakeLlm = dependencies.fakeLlm ?? createFakeLlm({ now });
  // Runner input/output contexts outlive this process. Never reuse their call
  // IDs when a Pod restarts with the same synthetic Endpoint configuration.
  const processId = randomUUID();
  let mode = 'shared', running = false, scheduler = null, monitor = null, modelBaseUrl = null;
  let lastTick = now(), epoch = 0, cursor = 0, sequence = 0, monitorRequest = null;
  const globalStarts = [], jobs = new Map(), history = [], events = [];
  const poolMetrics = new Map(config.pools.map(pool => [pool.id, { ready: false, metricsAvailable: false, inflight: 0, queue: 0, capacity: 0 }]));
  const aggregateRunner = poolIds => {
    const measurements = poolIds.map(id => poolMetrics.get(id));
    const metricsAvailable = measurements.every(item => item.metricsAvailable);
    const result = { ready: measurements.every(item => item.ready), metricsAvailable, inflight: 0, queue: 0, capacity: 0 };
    if (metricsAvailable) {
      for (const field of ['inflight', 'queue', 'capacity']) result[field] = measurements.reduce((sum, item) => sum + item[field], 0);
      for (const field of ['cpuPercent', 'memoryMiB']) if (measurements.every(item => Number.isFinite(item[field])))
        result[field] = measurements.reduce((sum, item) => sum + item[field], 0);
    }
    return result;
  };
  const groupStates = () => [...new Set(config.tenants.map(tenant => tenant.groupId))].map(id => {
    const members = config.tenants.filter(tenant => tenant.groupId === id);
    const poolIds = [...new Set(members.map(tenant => tenant.poolId))];
    return { id, name: members[0].groupName, tenantIds: members.map(tenant => tenant.id), poolIds, runner: aggregateRunner(poolIds) };
  });
  const tenants = config.tenants.map(item => ({ ...item, baseline: BASELINE_INITIAL_RPS, goal: BASELINE_INITIAL_RPS, nextGoal: 0, credit: 0,
    queue: [], inflight: 0, errors: 0, completed: 0, blocked: 0, inputBlocked: 0, outputBlocked: 0, transformed: 0, peakUntil: null,
    starts: [], arrivals: [], completions: [], samples: [], lastWarning: -Infinity }));
  const groupHasCapacity = tenant => tenants.reduce((sum, member) => sum + (member.groupId === tenant.groupId ? member.inflight : 0), 0) < groupInflightLimit;
  const tenantById = id => {
    const tenant = tenants.find(item => item.id === id);
    if (!tenant) throw invalid('Select tenantA, tenantB or tenantC.');
    return tenant;
  };
  const event = (kind, message, tenantId) => {
    events.push({ id: String(++sequence), time: now(), ...(tenantId ? { tenantId } : {}), kind, message });
    if (events.length > 30) events.shift();
  };
  const tenantState = (tenant, time) => {
    pruneTimes(tenant.arrivals, time - 1000); pruneTimes(tenant.completions, time - 1000); trimSamples(tenant.samples, time);
    return { id: tenant.id, name: tenant.name, color: tenant.color, groupId: tenant.groupId, groupName: tenant.groupName, poolId: tenant.poolId, slotBudget: SLOT_BUDGET,
      inflight: tenant.inflight, queued: tenant.queue.length, offeredRps: tenant.arrivals.length,
      completedRps: tenant.completions.length, occupancyPercent: Math.min(100, tenant.inflight / SLOT_BUDGET * 100),
      p50Ms: percentile(tenant.samples.map(item => item.totalMs), 0.5),
      p95Ms: percentile(tenant.samples.map(item => item.totalMs), 0.95),
      guardP95Ms: percentile(tenant.samples.map(item => item.guardMs), 0.95),
      modelP95Ms: percentile(tenant.samples.map(item => item.modelMs), 0.95),
      queueP95Ms: percentile(tenant.samples.map(item => item.queueMs), 0.95),
      errors: tenant.errors, completed: tenant.completed, blocked: tenant.blocked,
      inputBlocked: tenant.inputBlocked, outputBlocked: tenant.outputBlocked, transformed: tenant.transformed, peakUntil: tenant.peakUntil };
  };
  const state = () => {
    const { metricsAvailable: runnerMetricsAvailable, ...runner } = aggregateRunner(config.pools.map(pool => pool.id));
    return { running, mode, sampleIntervalMs: SAMPLE_INTERVAL_MS, fakeLlm: fakeLlm.state(), runner, groups: groupStates(),
    tenants: tenants.map(item => tenantState(item, now())), history: [...history], events: [...events], limits: { ...LIMITS },
    measurement: { occupancyDefinition: 'Lab client pipeline in-flight / 4 reference slots, capped at 100%; not tenant CPU. In-flight includes real input guard HTTP, local model HTTP, and real output guard HTTP. Throughput and latencies measure successfully delivered pipelines over the last 15 seconds, including client queue wait. Policy blocks are counted separately, stop subsequent stages, and are excluded from delivery throughput and latency. Replacements are forwarded before continuing. maxRps counts client pipelines (two guard calls when delivered); queueLimit applies per tenant. Quota mode is harness-only: 4 in-flight and 10 starts/s per tenant. '
      + (groupCount > 1 ? `Both modes reserve ${GROUP_RESERVED_SLOTS} generator slots for each other group: at most ${groupInflightLimit} of ${LIMITS.maxInflight} in-flight pipelines per group. This is generator admission, not a Runner quota.`
        : `One group can use all ${LIMITS.maxInflight} generator slots; no group reservation applies.`),
      quotaSimulation: mode === 'quota', runnerMetricsAvailable,
      runnerMetricsDefinition: 'Real Runner process gauges, summed once per configured pool in each group. CPU percent is the sum of process CPU measurements; memory is summed resident MiB. Unavailable group scrapes hide all aggregate gauges. Groups sharing host CPU can still contend for physical host resources.' } };
  };
  const sample = () => {
    if (!running && history.length === 0) return;
    const point = { time: now(), groups: Object.fromEntries(groupStates().map(group => [group.id, group.runner])) };
    for (const tenant of tenants) {
      const view = tenantState(tenant, point.time);
      point[tenant.id] = Object.fromEntries(['occupancyPercent', 'p95Ms', 'guardP95Ms', 'modelP95Ms', 'completedRps', 'queueP95Ms'].map(key => [key, view[key]]));
    }
    history.push(point); if (history.length > 180) history.shift();
  };
  const finish = (job, outcome) => {
    if (job.closed) return;
    job.closed = true; jobs.delete(job.id); job.tenant.inflight--;
    if (outcome?.cancelled || job.epoch !== epoch) return;
    if (outcome?.error) {
      job.tenant.errors++;
      if (now() - job.tenant.lastWarning >= 5000) {
        event('error', 'A live client pipeline failed; inspect Runner health. Credentials and request bodies are withheld.', job.tenant.id);
        job.tenant.lastWarning = now();
      }
      return;
    }
    if (outcome.status === 'blocked') {
      job.tenant.blocked++;
      job.tenant[outcome.blockedPhase === 'input' ? 'inputBlocked' : 'outputBlocked']++;
      return;
    }
    job.tenant.completed++; job.tenant.completions.push(now());
    if (outcome.transformed) job.tenant.transformed++;
    job.tenant.samples.push({ time: now(), totalMs: Math.max(0, now() - job.createdAt), queueMs: job.queueMs,
      guardMs: outcome.guardMs, modelMs: outcome.modelMs });
    trimSamples(job.tenant.samples, now());
  };
  const jsonCall = async (url, body, headers, signal) => {
    const response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), redirect: 'error' });
    if (!response.ok) throw new Error(`Live HTTP request failed (${response.status}).`);
    return response.json();
  };
  const execute = async job => {
    if (!modelBaseUrl) throw new Error('Local model HTTP server is not initialized.');
    const path = `/runtime/v1/endpoints/${encodeURIComponent(job.tenant.endpointId)}/beta/litellm_basic_guardrail_api`;
    const endpoint = new URL(path, job.tenant.runnerBaseUrl);
    const callId = `load-lab-${processId}-${job.id}`;
    return runGuardedChat({ callId, now,
      guard: body => jsonCall(endpoint, body, { 'x-api-key': job.tenant.credential }, job.controller.signal),
      model: body => jsonCall(new URL('/v1/chat/completions', modelBaseUrl), body, {}, job.controller.signal) });
  };
  const dispatch = tenant => {
    const queued = tenant.queue.shift();
    const job = { ...queued, id: `${epoch}-${++sequence}`, tenant, epoch, controller: new AbortController(), closed: false,
      queueMs: Math.max(0, now() - queued.createdAt) };
    tenant.inflight++; tenant.starts.push(now()); globalStarts.push(now()); jobs.set(job.id, job);
    // At most 64 promises exist here; queued arrivals are plain bounded records.
    Promise.resolve().then(() => execute(job)).then(value => finish(job, value), () => finish(job, { error: true }));
  };
  const tick = () => {
    if (!running) return;
    const time = now();
    const elapsed = Math.max(0, Math.min(250, time - lastTick)); lastTick = time;
    pruneTimes(globalStarts, time - 1000);
    for (const tenant of tenants) {
      pruneTimes(tenant.starts, time - 1000);
      if (tenant.peakUntil !== null && tenant.peakUntil <= time) {
        tenant.peakUntil = null; event('release', 'Peak expired; returning to the smooth baseline.', tenant.id);
      }
      if (time >= tenant.nextGoal) {
        tenant.goal = BASELINE_MIN_RPS + random() * (BASELINE_MAX_RPS - BASELINE_MIN_RPS);
        tenant.nextGoal = time + 3000;
      }
      tenant.baseline += (tenant.goal - tenant.baseline) * Math.min(1, elapsed / 4000);
      tenant.credit += (tenant.peakUntil === null ? tenant.baseline : config.peakRps) * elapsed / 1000;
      const arrivals = Math.floor(tenant.credit); tenant.credit -= arrivals;
      for (let i = 0; i < arrivals; i++) {
        tenant.arrivals.push(time);
        if (tenant.queue.length < LIMITS.queueLimit) tenant.queue.push({ createdAt: time });
        else {
          tenant.errors++;
          if (time - tenant.lastWarning >= 5000) { event('limit', 'This tenant reached the bounded client queue; excess arrivals were dropped.', tenant.id); tenant.lastWarning = time; }
        }
      }
      pruneTimes(tenant.arrivals, time - 1000);
    }
    while (jobs.size < LIMITS.maxInflight && globalStarts.length < LIMITS.maxRps) {
      let selected;
      if (mode === 'shared') {
        selected = tenants.filter(tenant => tenant.queue.length && groupHasCapacity(tenant)).sort((a, b) => a.queue[0].createdAt - b.queue[0].createdAt)[0];
      } else {
        for (let i = 0; i < tenants.length; i++) {
          const index = (cursor + i) % tenants.length, tenant = tenants[index];
          if (tenant.queue.length && groupHasCapacity(tenant) && tenant.inflight < SLOT_BUDGET && tenant.starts.length < QUOTA_RPS) {
            selected = tenant; cursor = (index + 1) % tenants.length; break;
          }
        }
      }
      if (!selected) break;
      dispatch(selected);
    }
  };
  const stop = () => {
    running = false; epoch++;
    if (scheduler !== null) clear(scheduler); scheduler = null;
    for (const tenant of tenants) { tenant.queue.length = 0; tenant.credit = 0; tenant.peakUntil = null; }
    for (const job of [...jobs.values()]) { job.controller.abort(); finish(job, { cancelled: true }); }
    fakeLlm.cancelAll();
  };
  const reset = () => {
    stop(); history.length = 0; events.length = 0;
    // Reset measurements, not safety accounting. Rapid mode/reset/start
    // controls must not bypass either rolling one-second admission limit.
    pruneTimes(globalStarts, now() - 1000);
    for (const tenant of tenants) {
      tenant.baseline = tenant.goal = BASELINE_INITIAL_RPS; tenant.nextGoal = 0;
      tenant.errors = tenant.completed = tenant.blocked = tenant.inputBlocked = tenant.outputBlocked = tenant.transformed = 0;
      pruneTimes(tenant.starts, now() - 1000);
      tenant.arrivals.length = tenant.completions.length = tenant.samples.length = 0;
      tenant.lastWarning = -Infinity;
    }
    fakeLlm.reset();
  };
  const control = value => {
    if (!value || typeof value !== 'object' || typeof value.action !== 'string') throw invalid('A control action is required.');
    switch (value.action) {
      case 'start':
        if (!modelBaseUrl) throw invalid('The local model HTTP server is not initialized.');
        if (!running) { running = true; epoch++; lastTick = now(); scheduler = interval(tick, 25); event('start', 'Live tenant traffic started.'); }
        break;
      case 'stop': stop(); event('stop', 'Traffic stopped; client queues and in-flight HTTP calls were cancelled.'); break;
      case 'reset': reset(); event('reset', 'Experiment reset. Start to generate new traffic.'); break;
      case 'mode':
        if (!['shared', 'quota'].includes(value.mode)) throw invalid('mode must be shared or quota.');
        if (value.mode !== mode) { reset(); mode = value.mode; event('mode', `${mode === 'quota' ? 'Harness quota simulation' : 'Shared Runner traffic'} selected. Press Start.`); }
        break;
      case 'peak': {
        const tenant = tenantById(value.tenantId), seconds = peakDurationSeconds(value.durationSeconds);
        if (!running) throw invalid('Start traffic before requesting a peak.');
        tenant.peakUntil = now() + seconds * 1000;
        event('peak', `${config.peakRps} client pipelines/s for ${seconds} seconds.`, tenant.id); break;
      }
      case 'release': {
        const tenant = tenantById(value.tenantId); tenant.peakUntil = null;
        event('release', 'Peak released; returning to the smooth baseline.', tenant.id); break;
      }
      default: throw invalid('Unknown control action.');
    }
    return state();
  };
  const observeRunner = async () => {
    if (monitorRequest) return;
    const controller = new AbortController(); monitorRequest = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(2500)]);
    try {
      await Promise.all(config.pools.map(async pool => {
        const values = await Promise.allSettled([
          fetcher(new URL('/health/ready', pool.runnerBaseUrl), { signal, redirect: 'error' }).then(async response => response.ok ? response.json() : null),
          fetcher(new URL('/metrics', pool.runnerBaseUrl), { signal, redirect: 'error',
            headers: pool.runnerMetricsToken ? { authorization: `Bearer ${pool.runnerMetricsToken}` } : {} })
            .then(async response => response.ok ? parseRunnerMetrics(await response.text()) : null),
        ]);
        const health = values[0].status === 'fulfilled' ? values[0].value : null;
        const metrics = values[1].status === 'fulfilled' ? values[1].value : null;
        poolMetrics.set(pool.id, metrics ? { ready: Boolean(health?.ready), metricsAvailable: true, ...metrics }
          : { ready: Boolean(health?.ready), metricsAvailable: false, inflight: 0, queue: 0, capacity: 0 });
      }));
    } finally { monitorRequest = null; }
  };
  return {
    state, control, tick, sample, observeRunner, fakeLlm,
    setModelBaseUrl(value) { modelBaseUrl = value; },
    startMonitoring() {
      if (monitor !== null) return;
      sample(); void observeRunner();
      monitor = interval(() => { sample(); void observeRunner(); }, SAMPLE_INTERVAL_MS);
    },
    close() { stop(); if (monitor !== null) clear(monitor); monitor = null; monitorRequest?.abort(); },
  };
}

export function createLabServer(config, options = {}) {
  const lab = createLab(config, options);
  const host = options.host ?? process.env.TENANT_LOAD_LAB_HOST ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.TENANT_LOAD_LAB_PORT ?? 38110);
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (request.method === 'GET' && path === '/state') sendJson(response, 200, lab.state());
      else if (request.method === 'POST' && path === '/control') sendJson(response, 200, lab.control(await readJson(request)));
      else if (request.method === 'POST' && path === '/v1/chat/completions') await lab.fakeLlm.handle(request, response);
      else sendJson(response, 404, { error: 'Not found.' });
    } catch (error) { sendJson(response, error.status ?? 500, { error: error.status ? error.message : 'Load lab request failed.' }); }
  });
  server.requestTimeout = 10000;
  return { lab, server,
    async start() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      const address = server.address();
      lab.setModelBaseUrl(`http://127.0.0.1:${address.port}`); lab.startMonitoring();
      return address;
    },
    async close() {
      lab.close(); server.closeIdleConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

// Kubernetes ConfigMap mounts are symlinks through a timestamped directory.
// Node resolves the module URL while argv retains the visible mount path.
const mainPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
const modulePath = await realpath(fileURLToPath(import.meta.url));
if (mainPath !== null && mainPath === modulePath) {
  let service;
  try {
    if (!process.env.TENANT_LOAD_LAB_CONFIG) throw new Error('Set TENANT_LOAD_LAB_CONFIG to a private fixture configuration.');
    service = createLabServer(JSON.parse(await readFile(process.env.TENANT_LOAD_LAB_CONFIG, 'utf8')));
    const address = await service.start();
    console.log(`Tenant load lab listening on ${address.address}:${address.port}; no guard traffic until Start.`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void service.close().then(() => process.exit(0)); });
  } catch {
    console.error('Tenant load lab could not start. Check its private configuration, bind address and port.');
    if (service) await service.close(); process.exitCode = 1;
  }
}
