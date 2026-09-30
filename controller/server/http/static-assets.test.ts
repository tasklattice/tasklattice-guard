// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpApp } from './app.js';
import { loadConfig } from '../config.js';
import type { ControllerAuth } from '../auth.js';
import type { ControlPlaneService } from '../services/control-plane.js';
import type { RunnerControlServer } from '../control-channel/control-server.js';
import type { ControllerMetrics } from '../metrics.js';

const root = mkdtempSync(join(tmpdir(), 'guard-static-assets-'));
const html = '<!doctype html><html><head><link rel="stylesheet" href="/assets/index-current.css"></head><body>Guard UI</body></html>';
const config = loadConfig({ NODE_ENV: 'test', CONTROLLER_UI_DIST: root,
  CONTROLLER_DATABASE_URL: 'postgresql://test:test@localhost/test', CONTROLLER_RUNNER_TOKEN: 'runner-token-that-is-at-least-32-characters',
  CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: '/tmp/test-key.pem', CONTROLLER_POLICY_CATALOG_DIR: resolve('../runner/toolkit/policy_library/assets'),
  BETTER_AUTH_SECRET: 'better-auth-secret-that-is-at-least-32-characters' });
let app: ReturnType<typeof createHttpApp>;
beforeAll(() => {
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), html);
  writeFileSync(join(root, 'assets/index-current.css'), 'body { color: black; }');
  writeFileSync(join(root, 'assets/index-current.js'), 'export const ready = true;');
  app = createHttpApp({ config, auth: {} as ControllerAuth, service: {} as ControlPlaneService, runnerControl: {} as RunnerControlServer, metrics: {} as ControllerMetrics });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('SPA asset delivery across builds', () => {
  it.each(['css', 'js', 'woff2'])('returns an uncacheable 404 for a missing %s instead of HTML', async extension => {
    const response = await app.request(`/assets/index-previous.${extension}`);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('<html>');
  });
  it.each([['css', 'text/css'], ['js', 'javascript']])('serves a current %s asset with its MIME type and immutable caching', async (extension, mime) => {
    const response = await app.request(`/assets/index-current.${extension}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(mime);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await response.text()).not.toContain('<html>');
  });
  it.each(['/', '/guardrails', '/integration/routers/router-1', '/document', '/document/overview/quickstart-protection', '/document/operator/operator-create-policy'])('keeps SPA navigation at %s but never caches the document', async path => {
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe(html);
  });
  it('keeps HEAD asset misses out of the SPA fallback', async () => {
    const response = await app.request('/assets/index-old.css', { method: 'HEAD' });
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
