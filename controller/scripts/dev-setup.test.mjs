import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { verifyPassword } from 'better-auth/crypto';
import { setupDevelopment } from './dev-setup.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'guard-dev-setup-'));
  copyFileSync(new URL('../../.env.example', import.meta.url), join(root, '.env.example'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test('setup preserves provider settings and reuses credentials and keys', async t => {
  const root = fixture(t);
  const providerLine = 'PROVIDER_KEY="test-key-with-\\-backslash"';
  writeFileSync(join(root, '.env'), `${providerLine}\nCONTROLLER_DATABASE_URL=postgresql://custom:custom@localhost:6543/custom\n`);
  await setupDevelopment(root);
  const firstText = readFileSync(join(root, '.env'), 'utf8');
  const first = parseEnv(firstText);
  assert.ok(firstText.includes(providerLine));
  assert.equal(first.CONTROLLER_DATABASE_URL, 'postgresql://custom:custom@localhost:6543/custom');
  assert.equal(first.CONTROLLER_RUNNER_TOKEN, first.GUARD_CONTROLLER_TOKEN);
  assert.equal(first.CONTROLLER_METRICS_TOKEN, first.GUARD_METRICS_TOKEN);
  assert.equal(await verifyPassword({ password: 'password', hash: first.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD_HASH }), true);
  const privateKey = readFileSync(first.CONTROLLER_ARTIFACT_SIGNING_KEY_PATH);
  assert.equal(createPrivateKey(privateKey).asymmetricKeyType, 'ed25519');
  assert.deepEqual(createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }), readFileSync(first.GUARD_ARTIFACT_PUBLIC_KEY_PATH, 'utf8'));
  await setupDevelopment(root);
  assert.deepEqual(parseEnv(readFileSync(join(root, '.env'), 'utf8')), first);
  assert.deepEqual(readFileSync(first.CONTROLLER_ARTIFACT_SIGNING_KEY_PATH), privateKey);
  assert.equal(statSync(join(root, '.env')).mode & 0o777, 0o600);
});
test('setup refuses mismatched existing tokens without changing env', async t => {
  const root = fixture(t);
  const original = `CONTROLLER_RUNNER_TOKEN=${'a'.repeat(32)}\nGUARD_CONTROLLER_TOKEN=${'b'.repeat(32)}\n`;
  writeFileSync(join(root, '.env'), original);
  await assert.rejects(setupDevelopment(root), /tokens differ/);
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), original);
});
test('setup never silently replaces a missing configured signing key', async t => {
  const root = fixture(t);
  const original = 'CONTROLLER_ARTIFACT_SIGNING_KEY_PATH=/missing/local-key.pem\n';
  writeFileSync(join(root, '.env'), original);
  await assert.rejects(setupDevelopment(root), /signing key is missing/);
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), original);
});

test('setup completes a copied example and the real Controller config accepts it', async t => {
  const root = fixture(t);
  copyFileSync(join(root, '.env.example'), join(root, '.env'));
  await setupDevelopment(root);
  const result = spawnSync(process.execPath, [`--env-file=${join(root, '.env')}`, '--import', 'tsx', '--input-type=module', '-e', 'import { loadConfig } from "./server/config.ts"; loadConfig();'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, result.stderr);
});
