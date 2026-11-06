#!/usr/bin/env node
/** Persistent macOS network bridge to the existing local Kubernetes Controller.
 * No Controller, gateway or model process runs on the host through this helper.
 */
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LABEL = 'io.tasklattice.guard.local-k8s-access';
const MARKER = '<!-- Managed by scripts/local-k8s-access.mjs -->';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function xml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
}

export function configuration(env = process.env, { root = repository, userHome = homedir() } = {}) {
  const name = (value, fallback, field) => {
    const result = value ?? fallback;
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(result)) throw new Error(`${field} must be a Kubernetes DNS label.`);
    return result;
  };
  const port = (value, fallback, minimum, field) => {
    const result = value === undefined ? fallback : Number(value);
    if (value !== undefined && !/^\d+$/.test(value) || !Number.isSafeInteger(result) || result < minimum || result > 65535)
      throw new Error(`${field} must be an integer from ${minimum} to 65535.`);
    return result;
  };
  const path = (value, fallback, field) => {
    const result = value ?? fallback;
    if (typeof result !== 'string' || !result || /[\x00-\x1f\x7f]/.test(result)) throw new Error(`${field} must be a nonempty filesystem path without control characters.`);
    return resolve(root, result);
  };
  const logs = join(root, '.local-secrets', 'local-k8s-access');
  return {
    namespace: name(env.GUARD_K8S_ACCESS_NAMESPACE, 'mt-demo', 'namespace'),
    service: name(env.GUARD_K8S_ACCESS_SERVICE, 'mt-demo-controller', 'service'),
    port: port(env.GUARD_K8S_ACCESS_PORT, 38081, 1024, 'local port'),
    targetPort: port(env.GUARD_K8S_ACCESS_TARGET_PORT, 8080, 1, 'target port'),
    kubeconfig: path(env.GUARD_K8S_ACCESS_KUBECONFIG, '.local-secrets/tenant-runtime-20261026/kubeconfig', 'kubeconfig'),
    kubectl: env.GUARD_K8S_ACCESS_KUBECTL === undefined ? null : path(env.GUARD_K8S_ACCESS_KUBECTL, '', 'kubectl'),
    plist: join(userHome, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    stdout: join(logs, 'stdout.log'), stderr: join(logs, 'stderr.log'), logs,
  };
}

export function renderPlist(config, kubectl) {
  if (!isAbsolute(kubectl)) throw new Error('kubectl executable must be an absolute path.');
  const args = [kubectl, '--kubeconfig', config.kubeconfig, '-n', config.namespace,
    'port-forward', '--address', '127.0.0.1', `service/${config.service}`, `${config.port}:${config.targetPort}`];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
${MARKER}
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(config.stdout)}</string>
  <key>StandardErrorPath</key><string>${xml(config.stderr)}</string>
</dict></plist>
`;
}

export function managedPlist(text) {
  return text.includes(MARKER) && text.includes(`<key>Label</key><string>${LABEL}</string>`);
}

async function existingPlist(path) {
  let stat;
  try { stat = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Refusing to replace a non-regular LaunchAgent file.');
  const text = await readFile(path, 'utf8');
  if (!managedPlist(text)) throw new Error('Refusing to change a LaunchAgent not managed by this helper.');
  return text;
}

function launchctl(args) {
  return spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 10000, maxBuffer: 262144 });
}
function checkedLaunchctl(args) {
  const result = launchctl(args);
  if (result.error || result.status !== 0) throw new Error(`launchctl ${args[0]} failed; exit=${result.status ?? 'unavailable'}.`);
  return result;
}
async function executable(config) {
  const candidates = config.kubectl ? [config.kubectl] : [join(homedir(), '.docker', 'bin', 'kubectl'),
    ...(process.env.PATH ?? '').split(':').filter(Boolean).map(folder => resolve(folder, 'kubectl'))];
  for (const candidate of candidates) { try { await access(candidate, constants.X_OK); return candidate; } catch {} }
  throw new Error('kubectl is unavailable; set GUARD_K8S_ACCESS_KUBECTL to its absolute path.');
}
async function atomicPlist(path, text) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let created = false;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' }); created = true;
    await rename(temporary, path);
  } finally { if (created) await rm(temporary, { force: true }); }
}
async function openPort(port) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
    socket.setTimeout(750, () => finish(false));
  });
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0] ?? 'status';
  if (['help', '--help', '-h'].includes(command)) {
    console.log(`Usage: node scripts/local-k8s-access.mjs status|install|uninstall

macOS launchd keeps a loopback-only kubectl port-forward alive across chat/tool
sessions and restarts it after Controller Pod changes. This is a network bridge;
all application processes remain in Kubernetes. Docker Desktop kind currently
publishes no application ports, so a NodePort alone does not expose localhost.

Defaults: 127.0.0.1:38081 -> mt-demo/service/mt-demo-controller:8080
Environment: GUARD_K8S_ACCESS_KUBECONFIG, GUARD_K8S_ACCESS_KUBECTL,
GUARD_K8S_ACCESS_NAMESPACE, GUARD_K8S_ACCESS_SERVICE,
GUARD_K8S_ACCESS_PORT, GUARD_K8S_ACCESS_TARGET_PORT.
Kubeconfig defaults to .local-secrets/tenant-runtime-20261026/kubeconfig.
Install never creates a cluster or changes Kubernetes resources. Uninstall
removes only this helper's LaunchAgent; private logs are retained. Stop any
temporary forward on the same localhost port before installing. The bridge
requires Docker Desktop and Kubernetes to be running, and resumes after login.`);
    return;
  }
  if (argv.length > 1 || !['status', 'install', 'uninstall'].includes(command)) throw new Error('Use status, install, uninstall or --help.');
  if (process.platform !== 'darwin') throw new Error('This launchd access helper requires macOS.');
  const config = configuration(), domain = `gui/${process.getuid()}`, target = `${domain}/${LABEL}`;
  const previous = await existingPlist(config.plist), loaded = launchctl(['print', target]);
  const isLoaded = !loaded.error && loaded.status === 0;
  if (!previous && isLoaded) throw new Error('A loaded job already uses this label without a managed plist; refusing to change it.');
  if (command === 'status') {
    console.log(JSON.stringify({ installed: previous !== null, launchdLoaded: isLoaded,
      localPortOpen: await openPort(config.port), url: `http://127.0.0.1:${config.port}`,
      plist: config.plist, logs: config.logs, helperRunsApplicationCode: false }));
    return;
  }
  if (command === 'uninstall') {
    if (isLoaded) checkedLaunchctl(['bootout', target]);
    if (previous) await rm(config.plist);
    console.log(JSON.stringify({ removed: previous !== null, label: LABEL, logsRetained: config.logs }));
    return;
  }
  await access(config.kubeconfig, constants.R_OK);
  const program = await executable(config), plist = renderPlist(config, program);
  await mkdir(dirname(config.plist), { recursive: true });
  await mkdir(config.logs, { recursive: true, mode: 0o700 }); await chmod(config.logs, 0o700);
  for (const path of [config.stdout, config.stderr]) { await writeFile(path, '', { flag: 'a', mode: 0o600 }); await chmod(path, 0o600); }
  if (isLoaded) checkedLaunchctl(['bootout', target]);
  try {
    await atomicPlist(config.plist, plist);
    checkedLaunchctl(['bootstrap', domain, config.plist]);
  } catch (error) {
    if (previous !== null) {
      await atomicPlist(config.plist, previous);
      if (isLoaded) launchctl(['bootstrap', domain, config.plist]);
    } else await rm(config.plist, { force: true });
    throw error;
  }
  console.log(JSON.stringify({ installed: true, label: LABEL, url: `http://127.0.0.1:${config.port}`,
    plist: config.plist, logs: config.logs, helperRunsApplicationCode: false }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
