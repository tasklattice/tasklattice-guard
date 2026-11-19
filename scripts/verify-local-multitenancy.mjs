#!/usr/bin/env node
/** Standalone acceptance against an operator-configured Project deployment.
 * Uses existing Project-scoped access tokens or browser sessions. Configuration
 * and resources are read-only; gateway requests create runtime evidence only.
 * No sign-in, fixture provisioning, SSO implementation or model server is here.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const resourceKinds = { endpointId: 'endpoints', routerId: 'routers', guardrailId: 'guardrails' };
function requireValue(condition, message) { if (!condition) throw new Error(message); }
function text(value, field, maximum = 256) {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= maximum && value === value.trim()
    && !/[\x00-\x1f\x7f]/.test(value), `${field} must be a bounded nonempty string without control characters.`);
  return value;
}
function credential(value, field) {
  requireValue(typeof value === 'string' && /^[\x21-\x7e]{1,8192}$/.test(value), `${field} must be a bounded ASCII header credential.`);
  return value;
}
function httpUrl(value, field, originOnly = false) {
  let parsed; try { parsed = new URL(value); } catch { throw new Error(`${field} must be an HTTP(S) URL.`); }
  requireValue(['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
    && (!originOnly || parsed.pathname === '/'), `${field} must be an HTTP(S) ${originOnly ? 'origin' : 'URL'} without embedded credentials, query or fragment.`);
  return originOnly ? parsed.origin : parsed.href.replace(/\/+$/, '');
}
function authentication(value, field) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${field} must provide an existing access token or session cookie.`);
  const keys = Object.keys(value);
  requireValue(keys.length === 1 && ['bearerToken', 'sessionCookie'].includes(keys[0]), `${field} must contain exactly bearerToken or sessionCookie.`);
  if (keys[0] === 'sessionCookie') {
    const cookie = value.sessionCookie;
    requireValue(typeof cookie === 'string' && /^[\x20-\x7e]{1,8192}$/.test(cookie) && cookie === cookie.trim(),
      `${field} must contain a bounded Cookie header without control characters.`);
    return { sessionCookie: cookie };
  }
  return { bearerToken: credential(value.bearerToken, field) };
}
export function validateConfiguration(raw) {
  requireValue(raw && typeof raw === 'object' && !Array.isArray(raw), 'Project acceptance configuration is required.');
  requireValue(raw.schemaVersion === undefined || raw.schemaVersion === 1, 'Unsupported configuration schemaVersion.');
  const controllerBaseUrl = httpUrl(raw.controllerBaseUrl, 'controllerBaseUrl', true);
  const timeoutMs = raw.timeoutMs ?? 120000;
  requireValue(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 600000, 'timeoutMs must be an integer from 1000 to 600000.');
  requireValue(Array.isArray(raw.projects) && raw.projects.length >= 2 && raw.projects.length <= 8, 'Configure between two and eight existing Projects.');
  const projects = raw.projects.map(item => {
    requireValue(item && typeof item === 'object' && !Array.isArray(item), 'Each Project requires a configuration object.');
    const id = text(item.id, 'Project id', 128);
    requireValue(/^[A-Za-z0-9_-]+$/.test(id), 'Project ids must use letters, numbers, underscores or hyphens.');
    requireValue(item.gateway && typeof item.gateway === 'object', 'Each Project requires a gateway configuration.');
    requireValue(item.resources && typeof item.resources === 'object', 'Each Project requires existing resource identities.');
    const resources = Object.fromEntries([...Object.keys(resourceKinds), 'guardrailVersion'].map(key => [key, text(item.resources[key], key)]));
    if (item.resources.endpointCredential !== undefined) resources.endpointCredential = credential(item.resources.endpointCredential, 'Endpoint credential');
    const gatewayUrl = new URL(httpUrl(item.gateway.baseUrl, 'Gateway baseUrl'));
    if (gatewayUrl.pathname === '/') gatewayUrl.pathname = '/v1';
    return { id, auth: authentication(item.auth, 'Project auth'), runnerBaseUrl: httpUrl(item.runnerBaseUrl, 'Runner baseUrl', true),
      gateway: { baseUrl: gatewayUrl.href.replace(/\/+$/, ''), apiKey: credential(item.gateway.apiKey, 'Gateway API key'), model: text(item.gateway.model, 'Gateway model') },
      resources, ...(item.expectedGroupId === undefined ? {} : { expectedGroupId: text(item.expectedGroupId, 'Expected group id') }),
      ...(item.expectedPoolId === undefined ? {} : { expectedPoolId: text(item.expectedPoolId, 'Expected pool id') }) };
  });
  requireValue(new Set(projects.map(item => item.id)).size === projects.length, 'Project identities must be distinct.');
  for (const key of Object.keys(resourceKinds)) requireValue(new Set(projects.map(item => item.resources[key])).size === projects.length,
    'Use distinct Project-owned resource identities for isolation checks.');
  requireValue(new Set(projects.map(item => JSON.stringify(Object.values(item.auth)))).size === projects.length, 'Use a distinct Project-bound credential for each Project.');
  requireValue(new Set(projects.map(item => JSON.stringify([item.gateway.baseUrl, item.gateway.apiKey, item.gateway.model]))).size === projects.length,
    'Use a distinct configured gateway binding for each Project.');
  requireValue(raw.modelStatus === undefined || raw.modelStatus && typeof raw.modelStatus === 'object' && !Array.isArray(raw.modelStatus),
    'modelStatus must provide an external counter URL and token.');
  const modelStatus = raw.modelStatus === undefined ? null : { url: httpUrl(raw.modelStatus.url, 'Model status URL'),
    token: credential(raw.modelStatus.token, 'Model status token') };
  return { controllerBaseUrl, timeoutMs, projects, modelStatus,
    administratorAuth: raw.administratorAuth === undefined ? null : authentication(raw.administratorAuth, 'Administrator auth'),
    origin: raw.origin === undefined ? controllerBaseUrl : httpUrl(raw.origin, 'origin', true),
    requestText: raw.requestText === undefined ? 'Hello.' : text(raw.requestText, 'requestText', 4096) };
}
function secretValues(config) {
  return new Set([config.modelStatus?.token, ...Object.values(config.administratorAuth ?? {}), ...config.projects.flatMap(project =>
    [...Object.values(project.auth), project.gateway.apiKey, project.resources.endpointCredential]),
  ...[config.administratorAuth, ...config.projects.map(project => project.auth)].flatMap(auth => cookieSecrets(auth?.sessionCookie))].filter(Boolean));
}
function cookieSecrets(header) {
  if (!header) return [];
  return header.split(';').flatMap(part => {
    const separator = part.indexOf('=');
    if (separator < 1) return [];
    const name = part.slice(0, separator).trim(), raw = part.slice(separator + 1).trim();
    const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    let decoded = value; try { decoded = decodeURIComponent(value); } catch {}
    // Short, ordinary display preferences are not authentication secrets.
    if (/^(?:locale|lang|language|theme|preference|preferences)$/i.test(name) && decoded.length < 8) return [];
    return [raw, value, decoded].filter(Boolean);
  });
}
function sanitize(value, secrets) {
  if (typeof value === 'string') {
    let result = value;
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) result = result.replaceAll(secret, '[REDACTED]');
    return result.replace(/\btg_[A-Za-z0-9_-]{43}\b/g, '[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(item => sanitize(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item, secrets)]));
  return value;
}
async function responseJson(response) {
  requireValue(response.body, 'HTTP response body is unavailable.');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; requireValue(size <= 2 * 1024 * 1024, 'HTTP response exceeds the acceptance response budget.'); chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('HTTP response is not valid JSON.'); }
}
const authHeaders = auth => auth.bearerToken ? { authorization: `Bearer ${auth.bearerToken}` } : { cookie: auth.sessionCookie };

export async function runAcceptance(raw, { fetcher = fetch, sleep = delay, save = async () => {}, now = Date.now } = {}) {
  const config = validateConfiguration(raw), secrets = secretValues(config);
  const result = { schemaVersion: 1, startedAt: new Date(now()).toISOString(), status: 'running', checks: [], runtime: [],
    capabilities: { resourceIsolation: true, projectBoundIdentity: true, gatewayCompletion: true, pairedGuardTelemetry: true,
      telemetryIsolation: true,
      administratorPlacement: Boolean(config.administratorAuth), externalModelDispatch: Boolean(config.modelStatus),
      wrongPoolCredentialDenial: config.projects.some(project => project.resources.endpointCredential
        && config.projects.some(other => other.runnerBaseUrl !== project.runnerBaseUrl)) },
    limitations: [
      'Uses operator-provided existing Project credentials and resources; it does not provision or edit product configuration.',
      'Gateway calls create application traffic, runtime telemetry and admission counters.',
      'Paired telemetry observes the configured Guard path, not a gateway-supplied correlation identifier. Use quiet test resources and synchronized clocks; unrelated traffic can make attribution ambiguous.',
      'A serial acceptance run does not establish load isolation, failover, infrastructure reservation or billing separation.',
      ...(!config.modelStatus ? ['External model dispatch is unverified because no modelStatus counter endpoint was configured.'] : []),
      ...(!config.administratorAuth ? ['Administrator allocation and Model policy checks were not requested.'] : []),
    ] };
  const persist = () => save(sanitize(result, secrets));
  async function check(name, action) {
    const started = now();
    try {
      const facts = await action();
      result.checks.push({ name, status: 'passed', durationMs: Math.max(0, now() - started), ...(facts ? { facts } : {}) }); await persist();
      return facts;
    } catch (error) {
      const message = sanitize(error.message, secrets);
      result.checks.push({ name, status: 'failed', error: message }); result.status = 'failed'; result.completedAt = new Date(now()).toISOString(); await persist();
      throw new Error(`${name}: ${message}`);
    }
  }
  async function request(base, path, { auth, projectId, body, method = 'GET', headers = {}, expect = 200 } = {}) {
    let response;
    try {
      response = await fetcher(new URL(path, base), { method, redirect: 'error', signal: AbortSignal.timeout(Math.min(config.timeoutMs, 15000)),
        headers: { ...(auth ? authHeaders(auth) : {}), ...(projectId ? { 'x-project-id': projectId } : {}),
          ...(base === config.controllerBaseUrl ? { origin: config.origin } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new Error('External HTTP request failed.'); }
    if (response.status !== expect) {
      if (response.body) await response.body.cancel().catch(() => {});
      throw new Error(`Expected HTTP ${expect}; received HTTP ${response.status}.`);
    }
    return response;
  }
  const api = async (auth, path, projectId) => responseJson(await request(config.controllerBaseUrl, path, { auth, projectId }));
  async function status(base, path, options) {
    const response = await request(base, path, options);
    if (response.body) await response.body.cancel().catch(() => {});
  }
  async function until(read, ready) {
    const deadline = now() + config.timeoutMs;
    while (now() < deadline) { const value = await read(); if (ready(value)) return value; await sleep(1000); }
    throw new Error('Timed out waiting for paired runtime evidence.');
  }
  async function modelState() {
    const state = await responseJson(await request(config.modelStatus.url, '', { headers: { authorization: `Bearer ${config.modelStatus.token}` } }));
    requireValue(Number.isSafeInteger(state?.completed) && state.completed >= 0 && state.active === 0, 'Model status must expose an idle nonnegative completed counter; pause other traffic.');
    return state.completed;
  }
  await persist();
  await check('Supplied credentials identify the configured Projects', async () => {
    for (const project of config.projects) {
      const identity = await api(project.auth, '/api/v1/account/identity', project.id);
      requireValue(identity.role === 'user' && identity.projectId === project.id, 'Credential is not a business-user credential for the configured Project.');
    }
    return { projectIds: config.projects.map(item => item.id), signInsCreated: 0 };
  });
  await check('Existing resources remain private across Projects', async () => {
    let reads = 0;
    for (const viewer of config.projects) for (const owner of config.projects) for (const [key, kind] of Object.entries(resourceKinds)) {
      await status(config.controllerBaseUrl, `/api/v1/${kind}/${encodeURIComponent(owner.resources[key])}`,
        { auth: viewer.auth, projectId: viewer.id, expect: viewer.id === owner.id ? 200 : 404 }); reads++;
    }
    return { reads, distinctProjects: config.projects.length };
  });
  await check('Project credentials cannot read administrator controls', async () => {
    for (const project of config.projects) for (const path of ['/api/v1/project-groups', '/api/v1/project-admission-monitor'])
      await status(config.controllerBaseUrl, path, { auth: project.auth, projectId: project.id, expect: 403 });
  });
  if (config.administratorAuth) await check('Administrator observes configured current Project allocation and Model policy', async () => {
    const identity = await api(config.administratorAuth, '/api/v1/account/identity');
    requireValue(identity.role === 'admin' && identity.projectId === null, 'Administrator credential does not identify a platform administrator.');
    const allocations = [];
    for (const project of config.projects) {
      const allocation = await api(config.administratorAuth, `/api/v1/projects/${encodeURIComponent(project.id)}/runner`);
      requireValue(allocation.projectId === project.id && allocation.groupId && allocation.pool?.id, 'Project has no current Runner allocation.');
      if (project.expectedGroupId !== undefined) assert.equal(allocation.groupId, project.expectedGroupId, 'Current Project group differs from operator expectation.');
      if (project.expectedPoolId !== undefined) assert.equal(allocation.pool.id, project.expectedPoolId, 'Current Runner pool differs from operator expectation.');
      const policy = await api(config.administratorAuth, `/api/v1/project-groups/${encodeURIComponent(allocation.groupId)}/model-configuration`);
      requireValue(policy.groupId === allocation.groupId && ['platform', 'scoped', 'blocked'].includes(policy.mode), 'Current group Model policy is invalid.');
      for (const field of ['credentials', 'credentialCiphertexts', 'runtimePayload', 'baseUrl']) requireValue(!Object.hasOwn(policy, field), 'Public Model policy exposes private runtime/credential data.');
      allocations.push({ projectId: project.id, groupId: allocation.groupId, poolId: allocation.pool.id, modelPolicy: policy.mode });
    }
    return { allocations };
  });
  await check('Configured Runner origins are synchronized', async () => {
    for (const base of new Set(config.projects.map(item => item.runnerBaseUrl))) {
      const ready = await responseJson(await request(base, '/health/ready'));
      requireValue(ready?.ready && ready.controller_connected && ready.desired_state_synchronized, 'Configured Runner has not synchronized with Controller.');
    }
  });
  const runtimeEvidence = [];
  await check('Gateways complete through the configured Project Guard path', async () => {
    for (const project of config.projects) {
      const since = new Date(now()).toISOString(), before = config.modelStatus ? await modelState() : null;
      const started = now();
      const completion = await responseJson(await request(project.gateway.baseUrl + '/', 'chat/completions', { method: 'POST',
        headers: { authorization: `Bearer ${project.gateway.apiKey}` },
        body: { model: project.gateway.model, stream: false, messages: [{ role: 'user', content: config.requestText }], metadata: { acceptance_request_id: randomUUID() } } }));
      requireValue(typeof completion?.choices?.[0]?.message?.content === 'string', 'Gateway did not return an OpenAI-compatible completion.');
      if (config.modelStatus) assert.equal(await modelState() - before, 1, 'Gateway request did not dispatch exactly one external model call; pause other traffic.');
      const query = new URLSearchParams({ endpointId: project.resources.endpointId, since, limit: '100' });
      const matches = row => row.endpointId === project.resources.endpointId && row.routerId === project.resources.routerId
        && row.guardrailId === project.resources.guardrailId && row.guardrailVersion === project.resources.guardrailVersion;
      const identity = value => typeof value === 'string' && value.trim().length > 0;
      const identified = row => identity(row.id) && identity(row.requestId) && identity(row.runnerId);
      const paired = value => {
        const rows = value.items.filter(matches);
        const incoming = rows.find(row => row.direction === 'incoming' && identified(row)
          && rows.some(other => other.direction === 'outgoing' && other.requestId === row.requestId && identified(other)));
        const outgoing = incoming && rows.find(row => row.direction === 'outgoing' && row.requestId === incoming.requestId && identified(row));
        return incoming && outgoing ? { incoming, outgoing } : null;
      };
      const events = await until(async () => {
        const value = await api(project.auth, `/api/v1/telemetry/events?${query}`, project.id);
        requireValue(Array.isArray(value?.items), 'Runtime evidence response does not contain an event list.');
        return value;
      }, value => paired(value) !== null);
      const { incoming, outgoing } = paired(events);
      runtimeEvidence.push({ owner: project, eventIds: [incoming.id, outgoing.id] });
      result.runtime.push({ projectId: project.id, status: 'delivered', durationMs: Math.max(0, now() - started),
        endpointId: project.resources.endpointId, guardrailId: project.resources.guardrailId,
        guardrailVersion: project.resources.guardrailVersion, inputRunnerId: incoming.runnerId, outputRunnerId: outgoing.runnerId, requestId: incoming.requestId,
        externalModelDispatchVerified: Boolean(config.modelStatus) });
    }
    return { delivered: config.projects.length, pairedGuardTelemetry: true, externalModelDispatchVerified: Boolean(config.modelStatus) };
  });
  await check('Runtime telemetry remains private across Projects', async () => {
    let ownDetails = 0, foreignLists = 0, foreignDetails = 0;
    for (const { owner, eventIds } of runtimeEvidence) {
      const paths = eventIds.map(id => `/api/v1/telemetry/events/${encodeURIComponent(id)}`);
      for (const path of paths) {
        await status(config.controllerBaseUrl, path, { auth: owner.auth, projectId: owner.id });
        ownDetails++;
      }
      const query = new URLSearchParams({ endpointId: owner.resources.endpointId, limit: '1' });
      for (const viewer of config.projects.filter(project => project.id !== owner.id)) {
        const value = await api(viewer.auth, `/api/v1/telemetry/events?${query}`, viewer.id);
        requireValue(Array.isArray(value?.items), 'Runtime evidence response does not contain an event list.');
        requireValue(value.items.length === 0, 'Foreign Project telemetry list is not empty.');
        foreignLists++;
        for (const path of paths) {
          await status(config.controllerBaseUrl, path, { auth: viewer.auth, projectId: viewer.id, expect: 404 });
          foreignDetails++;
        }
      }
    }
    return { ownDetails, foreignLists, foreignDetails };
  });
  if (result.capabilities.wrongPoolCredentialDenial) await check('Endpoint credentials are valid only on their configured Runner origins', async () => {
    let verified = 0, denied = 0;
    for (const project of config.projects.filter(item => item.resources.endpointCredential)) {
      const path = `/runtime/v1/endpoints/${encodeURIComponent(project.resources.endpointId)}/verify`;
      const headers = { 'x-api-key': project.resources.endpointCredential };
      const own = await responseJson(await request(project.runnerBaseUrl, path, { method: 'POST', headers }));
      requireValue(own.ready === true && own.adapter_id === 'litellm-generic-guardrail', 'Endpoint credential is not valid on its configured LiteLLM Runner.');
      verified++;
      for (const base of new Set(config.projects.map(item => item.runnerBaseUrl).filter(base => base !== project.runnerBaseUrl))) {
        await status(base, path, { method: 'POST', expect: 401, headers }); denied++;
      }
    }
    return { verified, denied };
  });
  result.status = 'passed'; result.completedAt = new Date(now()).toISOString(); await persist(); return sanitize(result, secrets);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--help') || !argv.includes('--execute')) {
    console.log(`Usage: node scripts/verify-local-multitenancy.mjs --config /private/project-acceptance.json --execute [--result /private/result.json]
Standalone external acceptance for existing Projects; Node 24, no dependencies.
The private JSON config supplies controllerBaseUrl, projects[2..8], and optional
administratorAuth, modelStatus, origin, timeoutMs and requestText. Each Project:
{id, auth:{bearerToken OR sessionCookie}, runnerBaseUrl,
 gateway:{baseUrl,apiKey,model},
 resources:{endpointId,routerId,guardrailId,guardrailVersion,endpointCredential?},
 expectedGroupId?,expectedPoolId?}
Use distinct Project-bound credentials and private resource IDs. Access tokens
need read permissions for account identity, resources and runtime evidence.
Sessions must already select the configured Project. No login is performed.
Optional administratorAuth uses the same credential shape for allocation and
Model policy reads. Optional modelStatus:{url,token} exposes an idle external
model /state endpoint with completed and active counters; pause other traffic.
Each gateway must already own real Input/LLM/Output integration. Resources,
configuration and policies are read-only; real gateway calls create telemetry.
No SSO, sharing, model server, fixture creation or deployment is implemented.
A/B/C names and Kubernetes Service names are never inferred.
Default result: /tmp/tasklattice-project-acceptance.json (mode0600).`);
    return;
  }
  const options = new Map();
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]; if (key === '--execute') continue;
    requireValue(['--config', '--result'].includes(key) && argv[index + 1] && !argv[index + 1].startsWith('--') && !options.has(key), 'Use --config FILE --execute [--result FILE].');
    options.set(key, argv[++index]);
  }
  requireValue(options.has('--config'), 'Set --config to a private operator configuration file.');
  let raw; try { raw = JSON.parse(await readFile(resolve(options.get('--config')), 'utf8')); } catch { throw new Error('Private acceptance configuration is unreadable or malformed.'); }
  const target = resolve(options.get('--result') ?? '/tmp/tasklattice-project-acceptance.json');
  requireValue(target !== resolve(options.get('--config')), 'Configuration and result paths must differ.');
  async function save(result) {
    await mkdir(dirname(target), { recursive: true }); const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    let created = false;
    try {
      await writeFile(temporary, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      created = true;
      await rename(temporary, target); await chmod(target, 0o600);
    } finally { if (created) await rm(temporary, { force: true }); }
  }
  const result = await runAcceptance(raw, { save });
  console.log(JSON.stringify({ status: result.status, checks: result.checks.length, resultFile: target }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error => { console.error(JSON.stringify({ status: 'failed', error: error.message })); process.exitCode = 1; });
