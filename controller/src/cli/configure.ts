import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

export type Api = (path: string, method?: string, body?: any) => Promise<any>;
type Flags = Record<string, string>;
type Journal = { data: any; save: () => Promise<void> };
const id = encodeURIComponent;
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex');
const required = (flags: Flags, key: string): string => {
  assert.ok(flags[key] && flags[key] !== 'true', `--${key} is required`);
  return flags[key];
};
const integer = (flags: Flags, key: string, fallback: number): number => {
  const value = Number(flags[key] ?? fallback);
  assert.ok(Number.isSafeInteger(value) && value > 0, `--${key} must be a positive integer`);
  return value;
};
const emit = (value: unknown): void => { console.log(JSON.stringify(value)); };

export const configurationHelp = `Non-interactive configuration (existing Controller APIs):
  guardctl platform register-model --provider-name NAME --provider-kind KIND
    --provider-url URL --model NAME --profile ID --key-env ENV_NAME
    [--timeout-seconds 30] [--max-tokens 512] [--refresh-credential]
  guardctl platform bind --binding content_safety.input --model-id ID --state FILE
    [--validation-id ID | --revalidate] [--wait-seconds 300]
  guardctl tenant test --guardrail-id ID [--version VERSION] [--local-only]
  guardctl tenant test-status --run-id ID [--detail]
  guardctl tenant test-cancel --run-id ID
  guardctl tenant provision --name NAME --patch FILE --state FILE
    --emergency-reason TEXT [--profile local-baseline | --source GUARDRAIL_ID] [--adapter litellm-generic-guardrail]
    [--endpoint-id ID] [--router-id ID] [--replace-change-id ID] [--wait-seconds 300]

Common: --url URL, --env-file FILE. Credentials come from environment only:
  GUARD_PLATFORM_TOKEN or GUARD_PLATFORM_USERNAME + GUARD_PLATFORM_PASSWORD
  GUARD_TENANT_TOKEN   or GUARD_TENANT_USERNAME   + GUARD_TENANT_PASSWORD
Optional GUARD_PLATFORM_URL / GUARD_TENANT_URL override the default Controller URL.
No interactive confirmation. Emergency apply requires an explicit audit reason.
State files contain the created Endpoint credential (mode 0600); keep them private.
Use the same state and arguments to resume. Use a new state for a different configuration.`;

export function parseConfigurationArgs(args: string[]): { command: string; flags: Flags } {
  const [command, ...rest] = args;
  const flags: Flags = {};
  const booleanFlags = new Set(['help', 'refresh-credential', 'revalidate', 'local-only', 'detail']);
  const known = new Set(['url', 'env-file', 'provider-name', 'provider-kind', 'provider-url', 'model', 'profile', 'key-env', 'timeout-seconds', 'max-tokens', 'binding', 'model-id', 'validation-id', 'state', 'wait-seconds', 'name', 'patch', 'emergency-reason', 'source', 'adapter', 'endpoint-id', 'router-id', 'replace-change-id', 'guardrail-id', 'version', 'run-id', ...booleanFlags]);
  for (let n = 0; n < rest.length; n++) {
    assert.ok(rest[n].startsWith('--'), `Unexpected argument: ${rest[n]}`);
    const [key, ...value] = rest[n].slice(2).split('=');
    assert.ok(known.has(key), `Unknown option --${key}`);
    assert.ok(flags[key] === undefined, `Duplicate option --${key}`);
    if (value.length) flags[key] = value.join('=');
    else if (booleanFlags.has(key)) flags[key] = 'true';
    else { assert.ok(rest[n + 1] && !rest[n + 1].startsWith('--'), `--${key} needs a value`); flags[key] = rest[++n]; }
  }
  return { command, flags };
}

/** Separate credentials per plane; never fall back to an admin session for tenant writes. */
export async function configurationApi(base: string, plane: 'platform' | 'tenant', env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch): Promise<Api> {
  const url = new URL(base);
  assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'Use an HTTP(S) Controller URL without credentials or query parameters');
  assert.equal(url.pathname.replace(/\/$/, ''), '', 'Controller URL must be an origin');
  const origin = url.origin, prefix = `GUARD_${plane.toUpperCase()}`;
  const headers: Record<string, string> = { 'content-type': 'application/json', origin };
  if (env[`${prefix}_TOKEN`]) headers.authorization = `Bearer ${env[`${prefix}_TOKEN`]}`;
  else {
    assert.ok(env[`${prefix}_USERNAME`] && env[`${prefix}_PASSWORD`], `Set ${prefix}_TOKEN or ${prefix}_USERNAME and ${prefix}_PASSWORD`);
    const response = await fetcher(`${origin}/api/auth/sign-in/username`, {
      method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ username: env[`${prefix}_USERNAME`], password: env[`${prefix}_PASSWORD`] }),
    });
    assert.ok(response.ok, `${plane} sign-in failed: HTTP ${response.status}`);
    headers.cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    assert.ok(headers.cookie, `${plane} sign-in returned no session`);
  }
  return async (path, method = 'GET', body) => {
    assert.ok(path.startsWith('/api/v1/') && new URL(path, origin).origin === origin, 'Management API paths only');
    const response = await fetcher(`${origin}${path}`, { method, headers, redirect: 'error', signal: AbortSignal.timeout(180_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) {
      // Provider error bodies can contain echoed credentials or request content.
      let code = ''; try { const data = await response.json(); code = String(data?.error?.code ?? ''); } catch { /* HTTP status remains actionable. */ }
      throw new Error(`${plane} ${method} ${path}: HTTP ${response.status}${/^[a-z0-9_]{1,80}$/.test(code) ? ` (${code})` : ''}`);
    }
    return response.status === 204 ? null : response.json();
  };
}

async function until(read: () => Promise<any>, ready: (value: any) => boolean, seconds: number, label: string): Promise<any> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await delay(1000);
  }
  throw new Error(`${label} timed out; inspect and resume with the same state file`);
}

async function withJournal(path: string, work: (journal: Journal) => Promise<void>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const lock = await open(`${path}.lock`, 'wx', 0o600);
  try {
    let data: any = {};
    try { data = JSON.parse(await readFile(path, 'utf8')); await chmod(path, 0o600); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    const save = async () => {
      const temp = `${path}.${randomUUID()}.tmp`;
      await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temp, path);
    };
    await work({ data, save });
  } finally { await lock.close(); await rm(`${path}.lock`); }
}

export async function registerModel(api: Api, flags: Flags, env: NodeJS.ProcessEnv): Promise<any> {
  const connection = { name: required(flags, 'provider-name'), kind: required(flags, 'provider-kind'), baseUrl: required(flags, 'provider-url').replace(/\/$/, '') };
  const model = required(flags, 'model'), profile = required(flags, 'profile');
  const timeoutSeconds = integer(flags, 'timeout-seconds', 30), maxTokens = integer(flags, 'max-tokens', 512);
  const view = await api('/api/v1/model-configuration');
  const found = view.providers.filter((p: any) => p.name === connection.name);
  assert.ok(found.length <= 1, 'Provider name is ambiguous');
  let provider = found[0];
  if (provider) assert.deepEqual({ kind: provider.kind, baseUrl: provider.baseUrl.replace(/\/$/, '') }, { kind: connection.kind, baseUrl: connection.baseUrl }, 'Existing provider connection differs');
  if (!provider || flags['refresh-credential'] === 'true') {
    const key = env[required(flags, 'key-env')]; assert.ok(key, 'Provider key environment variable is empty');
    provider = provider
      ? await api(`/api/v1/model-providers/${id(provider.id)}`, 'PATCH', { apiKey: key })
      : await api('/api/v1/model-providers', 'POST', { ...connection, apiKey: key });
  }
  const models = view.models.filter((m: any) => m.providerId === provider.id && m.model === model && m.profile === profile);
  assert.ok(models.length <= 1, 'Model identity is ambiguous');
  let definition = models[0];
  if (definition) assert.deepEqual({ timeoutSeconds: definition.timeoutSeconds, maxTokens: definition.maxTokens }, { timeoutSeconds, maxTokens }, 'Existing model settings differ; use its pinned settings');
  else definition = await api('/api/v1/models', 'POST', { providerId: provider.id, name: model, model, profile, timeoutSeconds, maxTokens });
  return { providerId: provider.id, modelId: definition.id, model, profile, reused: Boolean(models.length) };
}

export async function bindModel(api: Api, flags: Flags, journal: Journal): Promise<any> {
  const binding = required(flags, 'binding'), modelId = required(flags, 'model-id'), seconds = integer(flags, 'wait-seconds', 300);
  assert.ok(/^[a-z_]+\.(input|output)$/.test(binding), 'Use a capability.input or capability.output binding');
  const s = journal.data, request = { binding, modelId };
  if (s.request) assert.deepEqual(s.request, request, 'State belongs to another binding request');
  let view = await api('/api/v1/model-configuration');
  if (!s.request) { assert.ok(!view.activating, 'Another model activation is in progress'); Object.assign(s, { request, originalActive: view.active, originalDraft: view.draft }); await journal.save(); }
  const activeAssignments = (v: any) => v.active?.assignments ?? { controlPlane: null, bindings: Object.fromEntries(Object.keys(v.draft.assignments.bindings).map(k => [k, null])) };
  const originalAssignments = activeAssignments({ active: s.originalActive, draft: s.originalDraft });
  const withoutBinding = (a: any) => ({ ...a, bindings: { ...a.bindings, [binding]: null } });
  assert.deepEqual(withoutBinding(activeAssignments(view)), withoutBinding(originalAssignments), 'Unrelated active assignments changed');
  assert.deepEqual(withoutBinding(view.draft.assignments), withoutBinding(s.originalDraft.assignments), 'Unrelated draft assignments changed');
  if (view.activating) assert.equal(view.activating.id, s.activationId, 'Another model activation is in progress');
  if (!view.activating && activeAssignments(view).bindings[binding] !== modelId) {
    assert.equal(activeAssignments(view).bindings[binding], originalAssignments.bindings[binding], 'Binding changed outside this operation');
    assert.ok([modelId, s.originalDraft.assignments.bindings[binding]].includes(view.draft.assignments.bindings[binding]), 'Draft binding changed outside this operation');
    assert.ok(!(flags['validation-id'] && flags.revalidate === 'true'), 'Choose --validation-id or --revalidate');
    let validationId = flags.revalidate === 'true' ? undefined : flags['validation-id'] ?? s.validationId;
    let evidence: any;
    if (validationId) {
      const receipt = await api(`/api/v1/model-configuration/draft/assignments/${id(binding)}/candidate-validations/${id(validationId)}`);
      assert.equal(receipt.modelId, modelId, 'Validation belongs to another model');
      if (receipt.expired && !flags['validation-id']) validationId = undefined;
      else { assert.ok(!receipt.expired, 'Candidate validation expired; use --revalidate'); evidence = receipt.evidence; }
    }
    if (!validationId) {
      const validation = await api(`/api/v1/model-configuration/draft/assignments/${id(binding)}/candidate-validations`, 'POST', { modelId });
      validationId = validation.validationId;
      evidence = validation.validationReport?.checks?.find((check: any) => check.id === `probe:${binding}:${modelId}`);
      s.validationId = validationId; await journal.save();
    }
    assert.ok(validationId, 'Candidate validation returned no validation ID');
    assert.equal(evidence?.status, 'passed', `Candidate probe did not pass: ${validationId}; no model binding was applied`);
    // The API verifies receipt identity/freshness; the CLI additionally requires a passing probe.
    await api(`/api/v1/model-configuration/draft/assignments/${id(binding)}`, 'PUT', { modelId, validationId });
    const saved = await api('/api/v1/model-configuration');
    assert.equal(saved.active?.id ?? null, view.active?.id ?? null, 'Active model revision changed during validation');
    const applied = await api('/api/v1/model-configuration/apply', 'POST', { bindingIds: [binding], expectedDraftToken: saved.draft.reviewToken, expectedActiveId: view.active?.id ?? null });
    s.activationId = applied.activating?.id ?? applied.active?.id; await journal.save();
  }
  view = await until(() => api('/api/v1/model-configuration'), current => {
    if (current.failed?.id === s.activationId) throw new Error('Model activation failed; inspect the retained state');
    return !current.activating && current.active?.assignments.bindings[binding] === modelId;
  }, seconds, 'Model activation');
  assert.deepEqual(withoutBinding(view.active.assignments), withoutBinding(originalAssignments));
  assert.deepEqual(withoutBinding(view.draft.assignments), withoutBinding(s.originalDraft.assignments));
  s.activeRevision = view.active.id; s.completedAt = new Date().toISOString(); await journal.save();
  return { binding, modelId, activeRevision: s.activeRevision, previousModelId: originalAssignments.bindings[binding], state: 'active' };
}

export async function provisionTenant(api: Api, flags: Flags, patch: any, journal: Journal): Promise<any> {
  const name = required(flags, 'name'), reason = required(flags, 'emergency-reason');
  const sourceId = flags.source ?? journal.data.request?.sourceId, profileId = sourceId ? undefined : flags.profile ?? 'local-baseline', adapter = flags.adapter ?? 'litellm-generic-guardrail';
  assert.ok(!(flags.source && flags.profile), 'Choose --profile or --source');
  assert.ok(['litellm-generic-guardrail', 'f5-scan'].includes(adapter), 'Unsupported Endpoint adapter');
  assert.ok(patch && typeof patch === 'object' && !Array.isArray(patch), 'Patch must be a JSON object');
  assert.ok(Object.keys(patch).every(k => ['draftConfig', 'runtimeProfile'].includes(k)), 'Patch may contain draftConfig and runtimeProfile only');
  assert.ok(!patch.draftConfig || (typeof patch.draftConfig === 'object' && !Array.isArray(patch.draftConfig)), 'draftConfig must be an object');
  const seconds = integer(flags, 'wait-seconds', 300), s = journal.data;
  const request = JSON.parse(JSON.stringify({ name, sourceId, profileId, adapter, patch, endpointId: flags['endpoint-id'], routerId: flags['router-id'] }));
  if (s.request) assert.deepEqual(s.request, request, 'State belongs to a different provision request');
  if (!s.request) {
    const profile = profileId ? (await api('/api/v1/guardrail-profiles')).items.find((item: any) => item.id === profileId) : null;
    if (profileId) assert.ok(profile?.availability?.available, profile?.availability?.reason ?? 'Profile is unavailable');
    const source = sourceId ? await api(`/api/v1/guardrails/${id(sourceId)}`) : {
      id: null, draftRevision: 1, runtimeProfile: 'auto',
      draftConfig: { ...profile.draftSettings, policyBindings: profile.policyBindings, profileOrigin: { id: profile.id, version: profile.version } },
    };
    Object.assign(s, { request, source: { id: source.id, revision: source.draftRevision, draftConfig: source.draftConfig, runtimeProfile: source.runtimeProfile }, duplicateKey: randomUUID() }); await journal.save();
  }
  if (!s.guardId) {
    const copy = sourceId ? await api(`/api/v1/guardrails/${id(sourceId)}/duplicate`, 'POST', { name, sourceDraftRevision: s.source.revision, idempotencyKey: s.duplicateKey })
      : await api('/api/v1/guardrails', 'POST', { name, draftConfig: s.source.draftConfig, runtimeProfile: s.source.runtimeProfile, idempotencyKey: s.duplicateKey });
    assert.notEqual(copy.id, sourceId);
    s.guardId = copy.id; await journal.save();
  }
  const gp = `/api/v1/guardrails/${id(s.guardId)}`;
  let guard = await api(gp);
  const desired = { draftConfig: { ...s.source.draftConfig, ...patch.draftConfig }, runtimeProfile: patch.runtimeProfile ?? s.source.runtimeProfile };
  if (!s.patched) {
    // Only a fresh copy or this operation's desired draft may be edited on resume.
    assert.ok([digest(s.source.draftConfig), digest(desired.draftConfig)].includes(digest(guard.draftConfig)), 'Copied draft was edited outside this operation');
    guard = await api(gp, 'PATCH', { ...desired, expectedDraftRevision: guard.draftRevision });
    s.patched = { revision: guard.draftRevision, digest: digest(guard.draftConfig), runtimeProfile: guard.runtimeProfile }; await journal.save();
  }
  assert.equal(guard.draftRevision, s.patched.revision, 'Copied Guardrail has changed');
  assert.equal(digest(guard.draftConfig), s.patched.digest);
  if (!s.version) {
    const existing = guard.versions?.find((v: any) => v.sourceDraftRevision === guard.draftRevision && v.status === 'ready');
    s.version = existing?.version ?? (await api(`${gp}/publish`, 'POST', { expectedDraftRevision: guard.draftRevision })).version; await journal.save();
  }
  await until(() => api(gp), value => {
    const version = value.versions.find((v: any) => v.version === s.version);
    if (version?.status === 'failed') throw new Error('Guardrail compilation failed');
    return version?.status === 'ready';
  }, seconds, 'Guardrail publication');
  if (!s.endpoint) {
    if (flags['endpoint-id']) s.endpoint = await api(`/api/v1/endpoints/${id(flags['endpoint-id'])}`);
    else {
      const list = await api('/api/v1/endpoints');
      assert.ok(!(list.items ?? list).some((e: any) => e.name === name), 'An Endpoint with this name already exists; pass --endpoint-id to reuse it without rotating credentials');
      s.endpoint = await api('/api/v1/endpoints', 'POST', { name, adapter });
    }
    assert.equal(s.endpoint.adapter, adapter); await journal.save();
  }
  const draft = { routes: [{ id: 'fallback', name, kind: 'fallback', enabled: true, selector: { expression: { combinator: 'and', conditions: [] } }, targets: [{ id: 'primary', guardrailId: s.guardId, guardrailVersion: s.version, weightBps: 10000 }] }] };
  if (!s.routerId) {
    if (flags['router-id']) s.routerId = flags['router-id'];
    else {
      const list = await api('/api/v1/routers');
      assert.ok(!(list.items ?? list).some((r: any) => r.name === name), 'A Router with this name already exists; pass --router-id to reuse it');
      s.routerId = (await api('/api/v1/routers', 'POST', { name, endpointIds: [s.endpoint.id], draft })).id;
    }
    await journal.save();
  }
  const rp = `/api/v1/routers/${id(s.routerId)}`;
  let router = await api(rp);
  assert.deepEqual(router.endpointIds, [s.endpoint.id], 'Router must be dedicated to this Endpoint');
  if (router.pendingChangeRequest && router.pendingChangeRequest.id !== s.changeId) {
    assert.equal(router.pendingChangeRequest.id, flags['replace-change-id'], 'Another Router change is pending; pass its exact --replace-change-id to withdraw it');
    await api(`${rp}/change-requests/${id(router.pendingChangeRequest.id)}/withdraw`, 'POST');
    router = await api(rp);
  }
  if (!s.changeId && digest(router.activeSnapshot) !== digest(draft)) {
    if (digest(router.draft) !== digest(draft)) router = await api(`${rp}/draft`, 'PUT', { expectedDraftRevision: router.draftRevision, draft });
    const preview = await api(`${rp}/publication-preview`, 'POST', { expectedDraftRevision: router.draftRevision });
    assert.deepEqual(preview.snapshot, draft); assert.deepEqual(preview.endpointIds, [s.endpoint.id]);
    s.changeId = (await api(`${rp}/change-requests`, 'POST', { expectedDraftRevision: preview.draftRevision, reviewedSnapshot: preview.snapshot, reviewedEndpointIds: preview.endpointIds, reason, ticket: 'GUARDCTL' })).id; await journal.save();
  }
  if (s.changeId) {
    const cp = `${rp}/change-requests/${id(s.changeId)}`, change = await api(cp);
    assert.deepEqual(change.snapshot, draft, 'Change request does not match the prepared route');
    assert.deepEqual(change.endpointIds, [s.endpoint.id]);
    assert.ok(['pending', 'applied'].includes(change.status), 'Change request is no longer pending or applied');
    if (change.status === 'pending') await api(`${cp}/emergency-apply`, 'POST', { reason });
  }
  router = await until(() => api(rp), value => value.rolloutStatus === 'active' && digest(value.activeSnapshot) === digest(draft), seconds, 'Router rollout');
  const sourceAfter = await api(`/api/v1/guardrails/${id(sourceId)}`);
  assert.equal(digest(sourceAfter.draftConfig), digest(s.source.draftConfig), 'Source changed during provisioning');
  s.completedAt = new Date().toISOString(); s.routerRevision = router.activeRevision; await journal.save();
  return { guardrailId: s.guardId, sourceGuardrailId: sourceId ?? null, profileId: profileId ?? null, version: s.version, endpointId: s.endpoint.id, adapter, routerId: s.routerId, routerRevision: s.routerRevision, changeId: s.changeId, rollout: router.rolloutStatus, credentialSaved: Boolean(s.endpoint.credential) };
}

/** Same asynchronous test API as the UI; never implicitly resubmit while polling. */
export async function manageTestRun(api: Api, command: 'test' | 'test-status' | 'test-cancel', flags: Flags): Promise<any> {
  if (command === 'test') {
    const guardrail = required(flags, 'guardrail-id');
    const path = `/api/v1/guardrails/${id(guardrail)}${flags.version ? `/versions/${id(required(flags, 'version'))}` : ''}/test-runs`;
    return api(path, 'POST', { testModelRules: flags['local-only'] !== 'true' });
  }
  const path = `/api/v1/test-runs/${id(required(flags, 'run-id'))}`;
  return command === 'test-cancel' ? api(`${path}/cancel`, 'POST') : api(`${path}${flags.detail === 'true' ? '' : '?view=summary'}`);
}

export async function runConfiguration(plane: 'platform' | 'tenant', args: string[], defaultUrl: string): Promise<void> {
  const { command, flags } = parseConfigurationArgs(args);
  if (!command || command === 'help' || command === '--help' || flags.help) { console.log(configurationHelp); return; }
  assert.ok((plane === 'platform' && ['register-model', 'bind'].includes(command)) || (plane === 'tenant' && ['provision', 'test', 'test-status', 'test-cancel'].includes(command)), 'Unknown configuration command; use platform help or tenant help');
  const cwd = process.env.GUARDCTL_CWD ?? process.cwd();
  const env = { ...(flags['env-file'] ? parseEnv(await readFile(resolve(cwd, flags['env-file']), 'utf8')) : {}), ...process.env };
  const base = flags.url ?? env[`GUARD_${plane.toUpperCase()}_URL`] ?? defaultUrl;
  const api = await configurationApi(base, plane, env);
  if (command === 'register-model') { emit(await registerModel(api, flags, env)); return; }
  if (command === 'test' || command === 'test-status' || command === 'test-cancel') {
    emit(await manageTestRun(api, command, flags));
    return;
  }
  const state = resolve(cwd, required(flags, 'state'));
  await withJournal(state, async journal => {
    const connection = { base: new URL(base).origin, plane, identity: env[`GUARD_${plane.toUpperCase()}_USERNAME`] ?? 'token' };
    if (journal.data.connection) assert.deepEqual(journal.data.connection, connection, 'State belongs to another API connection');
    else { journal.data.connection = connection; await journal.save(); }
    const result = command === 'bind' ? await bindModel(api, flags, journal)
      : await provisionTenant(api, flags, JSON.parse(await readFile(resolve(cwd, required(flags, 'patch')), 'utf8')), journal);
    emit({ ...result, stateFile: state });
  });
}
