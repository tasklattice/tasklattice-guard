import { describe, expect, it, vi } from 'vitest';
import { bindModel, configurationApi, parseConfigurationArgs, provisionTenant, registerModel, type Api } from './configure.js';

const journal = () => ({ data: {} as any, save: vi.fn(async () => {}) });
const assignments = (model = 'nvidia') => ({ controlPlane: null, bindings: { 'content_safety.input': model, 'content_safety.output': 'nvidia', 'jailbreak.input': 'jev' } });

describe('guardctl configuration', () => {
  it('preserves spaces and equals in shell arguments and rejects typo flags', () => {
    expect(parseConfigurationArgs(['provision', '--name', 'Content Safety test', '--emergency-reason=case=42 approved'])).toEqual({ command: 'provision', flags: { name: 'Content Safety test', 'emergency-reason': 'case=42 approved' } });
    expect(() => parseConfigurationArgs(['bind', '--modeld', 'x'])).toThrow('Unknown option');
  });

  it('uses only the selected plane credential and never follows redirects', async () => {
    const fetcher = vi.fn(async (_url: any, options: any) => { expect(options.headers.authorization).toBe('Bearer tenant-token'); expect(options.redirect).toBe('error'); return new Response('{}'); });
    const api = await configurationApi('http://localhost:38081', 'tenant', { GUARD_PLATFORM_TOKEN: 'admin-token', GUARD_TENANT_TOKEN: 'tenant-token' }, fetcher as typeof fetch);
    await api('/api/v1/guardrails');
    await expect(configurationApi('http://localhost:38081', 'tenant', { GUARD_PLATFORM_TOKEN: 'admin-token' })).rejects.toThrow('GUARD_TENANT');
    await expect(api('//elsewhere.test/api/v1/models')).rejects.toThrow('Management API paths');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['platform', 'tenant'] as const)('uses the %s username login contract', async plane => {
    const fetcher = vi.fn(async (url: any, options: any) => {
      expect(url).toBe('http://localhost:38081/api/auth/sign-in/username');
      expect(JSON.parse(options.body)).toEqual({ username: plane, password: 'password' });
      return new Response('{}', { headers: { 'set-cookie': 'test-session=fixture; HttpOnly; Path=/' } });
    });
    const prefix = `GUARD_${plane.toUpperCase()}`;
    await configurationApi('http://localhost:38081', plane, { [`${prefix}_USERNAME`]: plane, [`${prefix}_PASSWORD`]: 'password' }, fetcher as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not echo provider error bodies or secrets', async () => {
    const api = await configurationApi('http://localhost:38081', 'platform', { GUARD_PLATFORM_TOKEN: 'secret' }, vi.fn(async () => new Response(JSON.stringify({ error: { code: 'bad_provider', message: 'echoed-secret', detail: 'api-key' } }), { status: 400 })) as typeof fetch);
    await expect(api('/api/v1/models')).rejects.toThrow('HTTP 400 (bad_provider)');
    try { await api('/api/v1/models'); } catch (e) { expect(String(e)).not.toMatch(/echoed-secret|api-key/); }
  });

  it('reuses model definitions without rotating credentials or making probes', async () => {
    const api = vi.fn(async () => ({ providers: [{ id: 'p', name: 'JEV', kind: 'typesafe', baseUrl: 'https://api.typesafe.ai/v1' }], models: [{ id: 'm', providerId: 'p', model: 'jev-1.13.0', profile: 'tali.typesafe-jev.v1', timeoutSeconds: 20, maxTokens: 512 }] }));
    expect(await registerModel(api, { 'provider-name': 'JEV', 'provider-kind': 'typesafe', 'provider-url': 'https://api.typesafe.ai/v1', model: 'jev-1.13.0', profile: 'tali.typesafe-jev.v1', 'timeout-seconds': '20' }, {})).toMatchObject({ modelId: 'm', reused: true });
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('applies only the requested binding with an optimistic revision and preserves restore information', async () => {
    let view: any = { active: { id: 'old', assignments: assignments() }, draft: { reviewToken: 'before', assignments: assignments() }, activating: null };
    const api = vi.fn(async (path: string, method = 'GET', body?: any) => {
      if (method === 'GET') return structuredClone(view);
      if (path.endsWith('candidate-validations')) return { validationId: 'validation', validationReport: { checks: [{ id: 'probe:content_safety.input:jev', status: 'passed' }] } };
      if (method === 'PUT') { expect(body).toEqual({ modelId: 'jev', validationId: 'validation' }); view.draft = { reviewToken: 'after', assignments: assignments('jev') }; return view.draft; }
      expect(body).toEqual({ bindingIds: ['content_safety.input'], expectedDraftToken: 'after', expectedActiveId: 'old' });
      view.active = { id: 'new', assignments: assignments('jev') }; return view;
    });
    const j = journal();
    expect(await bindModel(api, { binding: 'content_safety.input', 'model-id': 'jev' }, j)).toMatchObject({ activeRevision: 'new', previousModelId: 'nvidia' });
    expect(j.data.originalActive.assignments).toEqual(assignments());
    const mutations = api.mock.calls.filter(([, method]) => method && method !== 'GET').length;
    await bindModel(api, { binding: 'content_safety.input', 'model-id': 'jev' }, j);
    expect(api.mock.calls.filter(([, method]) => method && method !== 'GET')).toHaveLength(mutations);
  });

  it('stops on failed candidate validation without applying models', async () => {
    const api = vi.fn(async (path: string, method = 'GET') => {
      if (method === 'GET') return { active: { id: 'old', assignments: assignments() }, draft: { assignments: assignments() } };
      if (path.endsWith('candidate-validations')) return { validationId: 'failed', validationReport: { checks: [{ id: 'probe:content_safety.input:jev', status: 'failed' }] } };
      throw Error('candidate_validation_failed');
    });
    await expect(bindModel(api, { binding: 'content_safety.input', 'model-id': 'jev' }, journal())).rejects.toThrow('Candidate probe did not pass');
    expect(api.mock.calls.some(([, method]) => method === 'PUT')).toBe(false);
    expect(api.mock.calls.some(([path]) => path.endsWith('/apply'))).toBe(false);
  });

  it('can initialize a binding when no active model revision exists', async () => {
    const empty = { controlPlane: null, bindings: { 'content_safety.input': null, 'content_safety.output': null } };
    let view: any = { active: null, draft: { reviewToken: 'draft', assignments: structuredClone(empty) } };
    const api: Api = async (path, method = 'GET', body) => {
      if (method === 'GET') return structuredClone(view);
      if (path.endsWith('candidate-validations')) return { validationId: 'v', validationReport: { checks: [{ id: 'probe:content_safety.input:jev', status: 'passed' }] } };
      if (method === 'PUT') { view.draft.assignments.bindings['content_safety.input'] = body.modelId; return view.draft; }
      expect(body.expectedActiveId).toBeNull();
      view.active = { id: 'first', assignments: structuredClone(view.draft.assignments) }; return view;
    };
    expect(await bindModel(api, { binding: 'content_safety.input', 'model-id': 'jev' }, journal())).toMatchObject({ activeRevision: 'first', previousModelId: null });
  });

  it('duplicates an explicit source and preserves the copy after a compilation failure', async () => {
    const source = { id: 'guardrail-default', draftRevision: 1, draftConfig: { policyBindings: ['local'], outputDelivery: 'full_buffered' }, runtimeProfile: 'auto' };
    const calls: any[] = [];
    const api: Api = async (path, method = 'GET', body) => {
      calls.push({ path, method, body });
      if (path.endsWith('/duplicate')) return { ...source, id: 'copy' };
      if (path.endsWith('/publish')) throw Error('Compilation failed');
      if (path.includes('/test-runs/')) return { status: 'failed' };
      if (method === 'PATCH') return { ...source, ...body, id: 'copy', draftRevision: 2 };
      return path.endsWith('/copy') ? { ...source, id: 'copy' } : source;
    };
    const j = journal();
    await expect(provisionTenant(api, { name: 'Test', source: 'guardrail-default', 'emergency-reason': 'Authorized test' }, { draftConfig: { policyBindings: ['model'] } }, j)).rejects.toThrow('Compilation failed');
    expect(calls.find(c => c.path.endsWith('/duplicate')).body).toMatchObject({ sourceDraftRevision: 1 });
    expect(calls.find(c => c.method === 'PATCH')).toMatchObject({ path: '/api/v1/guardrails/copy', body: { draftConfig: { policyBindings: ['model'], outputDelivery: 'full_buffered' }, expectedDraftRevision: 1 } });
    expect(calls.some(c => c.path.includes('routers') || c.path.includes('emergency-apply'))).toBe(false);
  });

  it('publishes the reviewed snapshot with an audit reason and resumes without another mutation', async () => {
    const source = { id: 'guardrail-default', draftRevision: 1, draftConfig: { policyBindings: [] }, runtimeProfile: 'auto' };
    let guard: any, router: any, change: any;
    const calls: any[] = [];
    const api: Api = async (path, method = 'GET', body) => {
      calls.push({ path, method, body });
      if (path === '/api/v1/guardrails/guardrail-default') return structuredClone(source);
      if (path.endsWith('/duplicate')) { guard = { ...structuredClone(source), id: 'copy', versions: [] }; return structuredClone(guard); }
      if (path === '/api/v1/guardrails/copy') {
        if (method === 'PATCH') guard = { ...guard, ...body, draftRevision: 2 };
        return structuredClone(guard);
      }
      if (path.endsWith('/test-runs')) return { id: 'v' };
      if (path === '/api/v1/test-runs/v') return { status: 'passed' };
      if (path.endsWith('/publish')) { guard.versions = [{ version: 'release', sourceDraftRevision: 2, status: 'ready' }]; return { version: 'release' }; }
      if (path === '/api/v1/endpoints') return method === 'GET' ? { items: [] } : { id: 'ep', adapter: body.adapter, credential: 'private-endpoint-key' };
      if (path === '/api/v1/routers') { if (method === 'GET') return { items: [] }; router = { ...body, id: 'router', draftRevision: 1, activeSnapshot: null }; return structuredClone(router); }
      if (path.endsWith('/publication-preview')) return { snapshot: router.draft, endpointIds: ['ep'], draftRevision: 1 };
      if (path.endsWith('/change-requests')) { change = { ...body, id: 'change', status: 'pending', snapshot: body.reviewedSnapshot, endpointIds: body.reviewedEndpointIds }; return structuredClone(change); }
      if (path.endsWith('/emergency-apply')) { expect(body).toEqual({ reason: 'Authorized local regression' }); change.status = 'applied'; router.activeSnapshot = router.draft; router.activeRevision = 1; router.rolloutStatus = 'active'; return {}; }
      if (path.endsWith('/change')) return structuredClone(change);
      if (path.endsWith('/router')) return structuredClone(router);
      throw Error(`Unexpected API: ${method} ${path}`);
    };
    const flags = { name: 'Copy', source: 'guardrail-default', 'emergency-reason': 'Authorized local regression' }, j = journal();
    const result = await provisionTenant(api, flags, {}, j);
    expect(result).toMatchObject({ sourceGuardrailId: 'guardrail-default', guardrailId: 'copy', rollout: 'active', credentialSaved: true });
    expect(JSON.stringify(result)).not.toContain('private-endpoint-key');
    expect(calls.some(c => c.path.includes('test-runs'))).toBe(false);
    const mutations = calls.filter(c => c.method !== 'GET').length;
    await provisionTenant(api, flags, {}, j);
    expect(calls.filter(c => c.method !== 'GET')).toHaveLength(mutations);
    expect(calls.filter(c => c.path.endsWith('/emergency-apply'))).toHaveLength(1);
  });
  it('creates from the pinned Profile and resumes compilation without another creation or test', async () => {
    const profile = { id: 'local-baseline', version: '1.0.0', runtimeProfile: 'auto', availability: { available: true },
      draftSettings: { outputDelivery: 'full_buffered' }, policyBindings: ['local'] };
    let guard: any;
    const calls: any[] = [];
    const api: Api = async (path, method = 'GET', body) => {
      calls.push({ path, method, body });
      if (path === '/api/v1/guardrail-profiles') return { items: [profile] };
      if (path === '/api/v1/guardrails' && method === 'POST') { guard = { ...body, id: 'profile-copy', draftRevision: 1, versions: [] }; return structuredClone(guard); }
      if (path.endsWith('/profile-copy')) { if (method === 'PATCH') guard = { ...guard, ...body, draftRevision: 2 }; return structuredClone(guard); }
      if (path.endsWith('/publish')) throw Error('Compiler temporarily unavailable');
      throw Error(`Unexpected API: ${method} ${path}`);
    };
    const flags = { name: 'From Profile', 'emergency-reason': 'Local regression' }, state = journal();
    for (let retry = 0; retry < 2; retry++) await expect(provisionTenant(api, flags, {}, state)).rejects.toThrow('Compiler temporarily unavailable');
    const creates = calls.filter(call => call.method === 'POST' && call.path === '/api/v1/guardrails');
    expect(creates).toHaveLength(1);
    expect(creates[0].body).toMatchObject({ idempotencyKey: expect.any(String), draftConfig: { profileOrigin: { id: 'local-baseline', version: '1.0.0' } } });
    expect(calls.filter(call => call.path.endsWith('/publish'))).toHaveLength(2);
    expect(calls.some(call => call.path.includes('test-runs') || call.path.includes('guardrail-default'))).toBe(false);
  });

});
