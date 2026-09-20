import { generateKeyPairSync, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { hashPassword } from 'better-auth/crypto';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const placeholder = value => !value || value.startsWith('replace-');

export async function setupDevelopment(root = projectRoot) {
  const path = join(root, '.env');
  const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const current = parseEnv(original);
  const values = { ...parseEnv(readFileSync(join(root, '.env.example'), 'utf8')), ...current };
  const runnerTokens = [current.CONTROLLER_RUNNER_TOKEN, current.GUARD_CONTROLLER_TOKEN].filter(value => !placeholder(value));
  if (new Set(runnerTokens).size > 1) throw new Error('Existing Controller and Runner tokens differ. Align them in .env before running dev:setup.');
  values.CONTROLLER_RUNNER_TOKEN = values.GUARD_CONTROLLER_TOKEN = runnerTokens[0] ?? randomBytes(32).toString('hex');
  for (const key of ['BETTER_AUTH_SECRET', 'CONTROLLER_METRICS_TOKEN']) {
    if (placeholder(values[key])) values[key] = randomBytes(32).toString('hex');
  }
  values.GUARD_METRICS_TOKEN = placeholder(current.GUARD_METRICS_TOKEN) ? values.CONTROLLER_METRICS_TOKEN : current.GUARD_METRICS_TOKEN;
  const keyDir = join(root, '.local-secrets');
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const privatePath = current.CONTROLLER_ARTIFACT_SIGNING_KEY_PATH
    ? resolve(root, 'controller', current.CONTROLLER_ARTIFACT_SIGNING_KEY_PATH)
    : join(keyDir, 'artifact-private.pem');
  const publicPath = current.GUARD_ARTIFACT_PUBLIC_KEY_PATH
    ? resolve(root, current.GUARD_ARTIFACT_PUBLIC_KEY_PATH)
    : join(keyDir, 'artifact-public.pem');
  if (current.CONTROLLER_ARTIFACT_SIGNING_KEY_PATH && !existsSync(privatePath)) {
    throw new Error('The configured signing key is missing. Restore it or remove its .env path to initialize a new local key explicitly.');
  }
  const privateKey = existsSync(privatePath)
    ? createPrivateKey(readFileSync(privatePath))
    : generateKeyPairSync('ed25519').privateKey;
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('The configured signing key must be Ed25519.');
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  if (existsSync(publicPath) && createPublicKey(readFileSync(publicPath)).export({ type: 'spki', format: 'pem' }) !== publicKey) {
    throw new Error('The existing public key does not match the signing key. Restore the matching pair before running dev:setup.');
  }
  if (!existsSync(privatePath)) writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  if (!existsSync(publicPath)) writeFileSync(publicPath, publicKey, { mode: 0o600, flag: 'wx' });
  values.CONTROLLER_ARTIFACT_SIGNING_KEY_PATH = privatePath;
  values.GUARD_ARTIFACT_PUBLIC_KEY_PATH = publicPath;
  values.GUARD_RUNNER_STATE_PATH = current.GUARD_RUNNER_STATE_PATH ?? join(root, 'data', 'runner');
  if (current.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD && !current.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD_HASH) {
    delete values.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD_HASH;
  } else if (!current.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD_HASH) {
    delete values.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD;
    values.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD_HASH = await hashPassword('password');
  }
  // Leave existing values byte-for-byte intact, including quoted provider secrets.
  const pending = new Map(Object.entries(values));
  function encode(value) {
    for (const quote of ['"', "'", '`']) {
      if (!value.includes(quote)) return `${quote}${value}${quote}`;
    }
    throw new Error('A new .env value contains all quote delimiters; configure that value manually.');
  }
  const lines = original.split(/\r?\n/).map(line => {
    const key = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
    if (!key || !pending.has(key)) return line;
    pending.delete(key);
    return current[key] === values[key] ? line : `${key}=${encode(values[key])}`;
  });
  for (const [key, value] of pending) lines.push(`${key}=${encode(value)}`);
  writeFileSync(path, lines.join('\n').replace(/^\n+/, '') + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await setupDevelopment();
    console.log('Local .env and Ed25519 keys are ready; existing credentials were preserved.');
    console.log('Ensure PostgreSQL is reachable at CONTROLLER_DATABASE_URL, then run npm run dev from the repository root.');
    console.log('New default accounts use admin / password; existing accounts are not reset.');
  } catch (error) {
    console.error(`dev:setup: ${error.message}`);
    process.exitCode = 1;
  }
}
