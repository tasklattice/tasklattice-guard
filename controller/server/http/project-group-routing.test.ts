// @vitest-environment node
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import type { ControllerAuth } from '../auth.js';
import type { ControlPlaneService } from '../services/control-plane.js';
import type { RunnerControlServer } from '../control-channel/control-server.js';
import type { ControllerMetrics } from '../metrics.js';
import { RunnerPlaygroundClient } from '../playground/service.js';
import { createHttpApp } from './app.js';

const config = loadConfig({ NODE_ENV: 'test', CONTROLLER_DATABASE_URL: 'postgresql://a:b@localhost/a',
  CONTROLLER_RUNNER_TOKEN: 'runner-token-that-is-at-least-32-characters', CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: '/tmp/key',
  CONTROLLER_POLICY_CATALOG_DIR: resolve('../runner/toolkit/policy_library/assets'), BETTER_AUTH_SECRET: 'better-auth-secret-that-is-at-least-32-characters',
  CONTROLLER_RUNTIME_SERVICE_URL: 'http://default-runner:8091', CONTROLLER_RUNTIME_PUBLIC_URL: 'https://default.example.test' });

function setup() {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ action: 'NONE' }));
  const groupRouting = { poolForProject: vi.fn(async () => ({ poolId: 'beta', groupId: 'beta', runtimeUrl: 'http://beta-runner:8091', publicUrl: 'https://beta.example.test' })) };
  const service = { groupRouting, getEndpoint: vi.fn(async () => ({ id: 'endpoint-b', projectId: 'projectB', adapter: 'litellm-generic-guardrail' })) };
  const runnerControl = { distributionStatus: vi.fn(async () => ({ desiredGeneration: 1, distributionStatus: 'ready' })) };
  const app = createHttpApp({ config, auth: { api: { getSession: vi.fn().mockResolvedValue({ session: { id: 'fixture-session', activeProjectId: 'projectB' }, user: { id: 'user-b', role: 'user' } }) } } as unknown as ControllerAuth,
    service: service as unknown as ControlPlaneService, runnerControl: runnerControl as unknown as RunnerControlServer, metrics: {} as ControllerMetrics,
    playgroundRunner: new RunnerPlaygroundClient({ baseUrl: config.runtimeServiceUrl, token: config.runnerToken, fetcher }) });
  return { app, groupRouting, runnerControl, fetcher };
}

describe('group-specific Endpoint and Playground addresses', () => {
  it('advertises the owning group public URL and checks that pool distribution', async () => {
    const { app, groupRouting, runnerControl } = setup();
    const response = await app.request('/api/v1/endpoints/endpoint-b');
    expect(response.status).toBe(200);
    expect((await response.json()).setup.api_base_url).toBe('https://beta.example.test/runtime/v1/endpoints/endpoint-b');
    expect(groupRouting.poolForProject).toHaveBeenCalledWith('projectB');
    expect(runnerControl.distributionStatus).toHaveBeenCalledWith('beta');
  });
  it('runs a project path test on its own group internal URL', async () => {
    const { app, fetcher } = setup();
    const response = await app.request('/api/v1/playground/path-tests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      target: 'endpoint', targetId: 'endpoint-b', endpointId: 'endpoint-b', expectedRevision: 1, callId: 'call-1', credential: 'endpoint-key',
      configuration: 'published', action: 'execute', request: 'POST /runtime/v1/endpoints/endpoint-b/beta/litellm_basic_guardrail_api HTTP/1.1\n\n{"texts":["hello"]}' }) });
    expect(response.status).toBe(200);
    expect(fetcher.mock.calls[0]![0]).toBe('http://beta-runner:8091/runtime/v1/endpoints/endpoint-b/beta/litellm_basic_guardrail_api');
  });
});
