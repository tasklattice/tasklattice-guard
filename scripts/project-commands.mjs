import { gitBuildInfo } from "./git-build-info.mjs";
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const [action, ...args] = process.argv.slice(2);
const env = process.env;
if (env.CONTROLLER_REPOSITORY) env.TALI_GUARD_CONTROLLER_IMAGE_REPOSITORY ??= env.CONTROLLER_REPOSITORY;
if (env.RUNNER_REPOSITORY) env.TALI_GUARD_RUNNER_IMAGE_REPOSITORY ??= env.RUNNER_REPOSITORY;
const chart = 'charts/tali-guard';
const devValues = env.HELM_DEV_VALUES ?? `${chart}/values-dev.yaml`;
const debugValues = env.HELM_DEBUG_VALUES ?? `${chart}/values-debug.yaml`;
const release = env.HELM_RELEASE ?? 'tali-guard';
const namespace = env.HELM_NAMESPACE ?? 'tali';
const context = env.HELM_CONTEXT ?? 'orbstack';
// Test-only LiteLLM gateway with the TaskLattice Guard provider. Separate chart
// and release: it is never part of the product chart or helm-deploy.
const litellmChart = 'charts/tali-litellm-dev';
const litellmValues = env.LITELLM_DEV_VALUES ?? `${litellmChart}/values-dev.yaml`;
const litellmRelease = env.LITELLM_HELM_RELEASE ?? 'tali-litellm-dev';
// Published by github.com/tasklattice/tasklattice-litellm-guard. The pinned
// <litellm>-guard.<n> tag lives once, in the test chart's values.yaml.
function litellmPinnedImage() {
  const block = /^image:\n((?:[ \t]+.*\n|\s*\n)+)/m.exec(readFileSync(new URL(`../${litellmChart}/values.yaml`, import.meta.url), 'utf8'))?.[1] ?? '';
  const field = (name) => new RegExp(`^\\s+${name}:\\s*"?([^"\\s#]+)"?`, 'm').exec(block)?.[1];
  if (!field('repository') || !field('tag')) throw new Error(`${litellmChart}/values.yaml must pin image.repository and image.tag`);
  return `${field('repository')}:${field('tag')}`;
}
const litellmImage = () => env.LITELLM_IMAGE ?? litellmPinnedImage();
const required = ['--set', 'database.existingSecret=guard-database', '--set', 'security.bootstrapAdmin.existingSecret=guard-bootstrap-admin', '--set', 'runner.callContextRedisUrl=redis://redis:6379/0'];

function run(command, argv, quiet = false, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { cwd, env, stdio: quiet ? ['inherit', 'ignore', 'inherit'] : 'inherit' });
    const forward = (signal) => child.kill(signal);
    const signals = ['SIGINT', 'SIGTERM'];
    const handlers = signals.map(signal => () => forward(signal));
    signals.forEach((signal, i) => process.on(signal, handlers[i]));
    const cleanup = () => signals.forEach((signal, i) => process.off(signal, handlers[i]));
    child.on('error', error => { cleanup(); reject(new Error(`Cannot start ${command}: ${error.message}`)); });
    child.on('exit', (code, signal) => { cleanup(); code === 0 ? resolve() : reject(new Error(`${command} exited with ${signal ?? code}`)); });
  });
}
const pack = () => run('bash', ['scripts/package-runtime-chart.sh', env.DEV_CHART_VERSION ?? '0.0.0-dev']);
async function images(component) {
  if (component && !['controller', 'runner'].includes(component)) throw new Error(`Unknown image component: ${component}`);
  const buildInfo = JSON.stringify(gitBuildInfo());
  if (!component || component === 'controller') {
    await pack();
    await run('docker', ['build', '--build-arg', `TALI_BUILD_INFO=${buildInfo}`, '-f', 'Dockerfile.controller', '-t', env.CONTROLLER_IMAGE ?? `${env.CONTROLLER_REPOSITORY ?? 'ghcr.io/tasklattice/tali-guard-controller'}:dev`, '.']);
  }
  if (!component || component === 'runner') await run('docker', ['build', '--build-arg', `TALI_BUILD_INFO=${buildInfo}`, '-f', 'Dockerfile.runner', '-t', env.RUNNER_IMAGE ?? `${env.RUNNER_REPOSITORY ?? 'ghcr.io/tasklattice/tali-guard-runner'}:dev`, '.']);
}
async function lint(extra = args) {
  for (const values of [required, ['--values', devValues], ['--values', devValues, '--set', 'observability.serviceMonitor.enabled=true', '--set', 'observability.prometheusRule.enabled=true', '--set', 'observability.grafanaDashboard.enabled=true'], ['--values', devValues, '--values', debugValues]]) {
    await run('helm', ['lint', chart, '--strict', ...values, ...extra]);
  }
  await run('helm', ['lint', litellmChart, '--strict', '--values', litellmValues, ...extra]);
}
async function deployGuard(debug, extra) {
  await images();
  await run('bash', ['scripts/helm-upgrade.sh', release, chart, context, namespace,
    '--values', devValues, ...(debug ? ['--values', debugValues] : []),
    '--set', `controller.image.repository=${env.CONTROLLER_REPOSITORY ?? 'ghcr.io/tasklattice/tali-guard-controller'}`,
    '--set-string', 'controller.image.tag=dev',
    '--set', `runner.image.repository=${env.RUNNER_REPOSITORY ?? 'ghcr.io/tasklattice/tali-guard-runner'}`,
    '--set-string', 'runner.image.tag=dev',
    '--set-string', `rolloutRevision=${env.HELM_ROLLOUT_REVISION ?? Date.now().toString()}`,
    '--wait', '--timeout', env.HELM_TIMEOUT ?? '5m', ...extra]);
}
// Local Guardrail promotion pair on OrbStack: UAT authors, tests, publishes and
// exports; PROD only receives. Two releases in their own namespaces, each with
// its own database and keys; every switch lives in the values overlays. Images
// use their own tag so the development release keeps running what it runs.
const promotion = {
  tag: env.PROMOTION_IMAGE_TAG ?? 'promotion',
  work: env.GUARD_PROMOTION_WORKDIR ?? `${root}.local-secrets/promotion`,
  stacks: {
    uat: { release: 'tali-guard-uat', namespace: 'tali-uat', values: `${chart}/values-dev-uat.yaml`, url: 'http://localhost:38181', runner: 'http://localhost:38182' },
    // A different host keeps the two consoles' sign-in cookies apart in one browser.
    prod: { release: 'tali-guard-prod', namespace: 'tali-prod', values: `${chart}/values-dev-prod.yaml`, url: 'http://127.0.0.1:38281', runner: 'http://127.0.0.1:38282' },
  },
};
const promotionStacks = Object.values(promotion.stacks);
function capture(command, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(`${command} ${argv.join(' ')} exited with ${code}`)));
  });
}
const secretValue = async (stack, name, key) => Buffer.from(await capture('kubectl', ['--context', context, '-n', stack.namespace, 'get', 'secret', name, '-o', `jsonpath={.data.${key.replaceAll('.', '\\.')}}`]), 'base64').toString();
/** Package keys stay on this machine: UAT's signing key, plus the extra sources the regression signs with. */
function promotionKeys() {
  mkdirSync(`${promotion.work}/keys`, { recursive: true });
  const pem = {};
  for (const name of ['uat-package', 'other-package', 'system-package']) {
    const path = `${promotion.work}/keys/${name}.pem`;
    if (!existsSync(path)) {
      const pair = generateKeyPairSync('ed25519');
      writeFileSync(path, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      writeFileSync(`${promotion.work}/keys/${name}.pub.pem`, pair.publicKey.export({ type: 'spki', format: 'pem' }));
    }
    pem[name] = readFileSync(`${promotion.work}/keys/${name}.pub.pem`, 'utf8');
  }
  return pem;
}
async function deployPromotion(extra) {
  const pem = promotionKeys();
  const { uat, prod } = promotion.stacks;
  const signing = `${promotion.work}/uat-package-signing.json`;
  writeFileSync(signing, JSON.stringify({ apiVersion: 'v1', kind: 'List', items: [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: uat.namespace } },
    { apiVersion: 'v1', kind: 'Secret', type: 'Opaque', metadata: { name: 'guard-package-signing', namespace: uat.namespace },
      stringData: { 'private-key.pem': readFileSync(`${promotion.work}/keys/uat-package.pem`, 'utf8') } },
  ] }), { mode: 0o600 });
  // Public keys only; JSON is valid YAML for --values.
  const trust = `${promotion.work}/prod-trust.values.yaml`;
  writeFileSync(trust, JSON.stringify({ controller: { promotion: { trust: { sources: [
    { id: 'bank-uat', name: 'Bank UAT', keys: [{ id: 'uat-2026', publicKeyPem: pem['uat-package'] }] },
    { id: 'bank-uat-b', name: 'Second UAT', keys: [{ id: 'uat-b', publicKeyPem: pem['other-package'] }] },
    { id: 'bank-uat-system', name: 'UAT system baseline', keys: [{ id: 'system', publicKeyPem: pem['system-package'] }], reservedGuardrailIds: ['guardrail-default'] },
  ] } } } }, null, 2));
  const controllerImage = `${env.CONTROLLER_REPOSITORY ?? 'ghcr.io/tasklattice/tali-guard-controller'}:${promotion.tag}`;
  const runnerImage = `${env.RUNNER_REPOSITORY ?? 'ghcr.io/tasklattice/tali-guard-runner'}:${promotion.tag}`;
  if (env.PROMOTION_SKIP_IMAGES !== '1') {
    env.CONTROLLER_IMAGE = controllerImage;
    env.RUNNER_IMAGE = runnerImage;
    await images();
  }
  await run('kubectl', ['--context', context, 'apply', '-f', signing]);
  for (const [stack, values] of [[uat, [uat.values]], [prod, [prod.values, trust]]]) {
    await run('bash', ['scripts/helm-upgrade.sh', stack.release, chart, context, stack.namespace,
      '--values', devValues, ...values.flatMap(file => ['--values', file]),
      '--set', `controller.image.repository=${controllerImage.slice(0, controllerImage.lastIndexOf(':'))}`, '--set-string', `controller.image.tag=${promotion.tag}`,
      '--set', `runner.image.repository=${runnerImage.slice(0, runnerImage.lastIndexOf(':'))}`, '--set-string', `runner.image.tag=${promotion.tag}`,
      '--set-string', `rolloutRevision=${env.HELM_ROLLOUT_REVISION ?? Date.now().toString()}`,
      '--wait', '--timeout', env.HELM_TIMEOUT ?? '8m', ...extra]);
  }
  console.log(`UAT  ${uat.url}  (release ${uat.release}, namespace ${uat.namespace})`);
  console.log(`PROD ${prod.url}  (release ${prod.release}, namespace ${prod.namespace})`);
  console.log('Sign in to either with admin / password.');
}
/** End-to-end promotion regression against the deployed pair, through port-forwards to each database. */
async function testPromotion(extra) {
  const forwards = [];
  try {
    const databases = {};
    for (const [name, stack, port] of [['UAT', promotion.stacks.uat, 55481], ['PROD', promotion.stacks.prod, 55482]]) {
      const fullname = stack.release;
      const password = await secretValue(stack, `${fullname}-postgresql`, 'password');
      const forward = spawn('kubectl', ['--context', context, '-n', stack.namespace, 'port-forward', `svc/${fullname}-postgresql`, `${port}:5432`], { stdio: 'ignore' });
      forwards.push(forward);
      databases[name] = `postgresql://guard:${encodeURIComponent(password)}@127.0.0.1:${port}/guard`;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
    Object.assign(env, {
      GUARD_PROMOTION_WORKDIR: promotion.work,
      GUARD_PROMOTION_UAT_URL: promotion.stacks.uat.url, GUARD_PROMOTION_UAT_RUNNER_URL: promotion.stacks.uat.runner,
      GUARD_PROMOTION_PROD_URL: promotion.stacks.prod.url, GUARD_PROMOTION_PROD_RUNNER_URL: promotion.stacks.prod.runner,
      GUARD_PROMOTION_UAT_DB: databases.UAT, GUARD_PROMOTION_PROD_DB: databases.PROD,
      GUARD_PROMOTION_UAT_EMAIL: 'admin@tasklattice.local', GUARD_PROMOTION_PROD_EMAIL: 'admin@tasklattice.local', GUARD_PROMOTION_PASSWORD: env.GUARD_PROMOTION_PASSWORD ?? 'password',
      GUARD_PROMOTION_RUNNER_TOKEN: await secretValue(promotion.stacks.prod, `${promotion.stacks.prod.release}-control`, 'runner-token'),
    });
    mkdirSync(`${promotion.work}/packages`, { recursive: true });
    await run(process.execPath, ['--import', 'tsx', '../scripts/regress_guardrail_promotion.mjs', ...extra], false, `${root}controller`);
  } finally {
    forwards.forEach(forward => forward.kill());
  }
}
async function deployLitellm(extra) {
  const image = litellmImage();
  // A registry blip must not block a stack whose image is already local;
  // a missing image still fails here, before any Guard resources change.
  try { await run('docker', ['pull', image]); }
  catch (error) {
    await run('docker', ['image', 'inspect', image], true).catch(() => { throw error; });
    console.error(`Pull failed (${error.message}); using the local copy of ${image}.`);
  }
  // The Provider must speak this Runner's output-stream protocol. An image
  // built for another protocol is refused here rather than failing at the
  // first streamed completion.
  if (env.LITELLM_SKIP_IMAGE_VERIFY !== '1') {
    try { await run('.venv/bin/python', ['scripts/verify_relay_stream_image.py', image]); }
    catch (error) {
      throw new Error(`${error.message}\n${image} is not compatible with this Guard. Pin a tasklattice-litellm-guard release built for it in ${litellmChart}/values.yaml, or set LITELLM_IMAGE.`);
    }
  }
  // The wiring script creates the Guard Endpoint/Router and writes the Guard
  // credential Secret itself, so the secret never passes through Helm values.
  await run('node', ['scripts/litellm-dev-wire.mjs']);
  const upstream = ['LITELLM_UPSTREAM_API_BASE', 'LITELLM_UPSTREAM_API_KEY', 'LITELLM_UPSTREAM_MODEL'].map((key) => env[key]);
  if (upstream.some(Boolean) && !upstream.every(Boolean)) throw new Error('Set LITELLM_UPSTREAM_API_BASE, LITELLM_UPSTREAM_API_KEY and LITELLM_UPSTREAM_MODEL together.');
  const [apiBase, apiKey, model] = upstream;
  await run('bash', ['scripts/helm-upgrade.sh', litellmRelease, litellmChart, context, namespace,
    '--values', litellmValues,
    '--set', `image.repository=${image.slice(0, image.lastIndexOf(':'))}`,
    '--set-string', `image.tag=${image.slice(image.lastIndexOf(':') + 1)}`,
    '--set', `model.mock.image.repository=${env.RUNNER_REPOSITORY ?? 'ghcr.io/tasklattice/tali-guard-runner'}`,
    ...(apiBase ? ['--set-string', `model.upstream.apiBase=${apiBase}`, '--set-string', `model.upstream.apiKey=${apiKey}`, '--set-string', `model.upstream.model=${model}`] : []),
    '--wait', '--timeout', env.HELM_TIMEOUT ?? '5m', ...extra]);
  if (env.LITELLM_SKIP_SMOKE !== '1') await run('node', ['scripts/litellm-dev-smoke.mjs']);
}
try {
  switch (action) {
    case 'runner': await run('.venv/bin/uvicorn', ['runner.main:app', '--host', env.RUNNER_HTTP_HOST ?? '0.0.0.0', '--port', env.RUNNER_HTTP_PORT ?? '8091', ...args]); break;
    case 'images': await images(args[0]); break;
    case 'helm-package': await run('bash', ['scripts/package-runtime-chart.sh', args[0] ?? env.DEV_CHART_VERSION ?? '0.0.0-dev']); break;
    case 'helm-lint': await lint(); break;
    case 'helm-template': await run('helm', ['template', release, chart, '--namespace', namespace, '--values', devValues, ...args]); break;
    case 'helm-deploy':
    case 'helm-deploy-debug': await deployGuard(action.endsWith('debug'), args); break;
    case 'litellm-deploy': await deployLitellm(args); break;
    case 'litellm-deploy-full': await deployGuard(false, []); await deployLitellm(args); break;
    case 'litellm-status':
      await run('helm', ['status', litellmRelease, '--kube-context', context, '--namespace', namespace, ...args]);
      await run('kubectl', ['--context', context, '--namespace', namespace, 'get', 'pods,deploy,statefulset,service', '--selector', `app.kubernetes.io/instance=${litellmRelease}`]); break;
    case 'litellm-delete': await run('helm', ['uninstall', litellmRelease, '--kube-context', context, '--namespace', namespace, ...args]); break;
    case 'helm-status':
      await run('helm', ['status', release, '--kube-context', context, '--namespace', namespace, ...args]);
      await run('kubectl', ['--context', context, '--namespace', namespace, 'get', 'pods,deploy,statefulset,service', '--selector', 'app.kubernetes.io/part-of=tasklattice-guard']); break;
    case 'helm-test': await run('helm', ['test', release, '--kube-context', context, '--namespace', namespace, '--logs', ...args]); break;
    case 'helm-delete': await run('helm', ['uninstall', release, '--kube-context', context, '--namespace', namespace, ...args]); break;
    case 'promotion-deploy': await deployPromotion(args); break;
    case 'promotion-test': await testPromotion(args); break;
    case 'promotion-status':
      for (const stack of promotionStacks) {
        await run('helm', ['status', stack.release, '--kube-context', context, '--namespace', stack.namespace, ...args]);
        await run('kubectl', ['--context', context, '--namespace', stack.namespace, 'get', 'pods,service', '--selector', `app.kubernetes.io/instance=${stack.release}`]);
      }
      break;
    case 'promotion-delete':
      for (const stack of promotionStacks) await run('helm', ['uninstall', stack.release, '--kube-context', context, '--namespace', stack.namespace, ...args]);
      break;
    case 'test-contracts':
      await run(process.execPath, ['--test', 'scripts/project-commands.test.mjs']);
      await run('.venv/bin/python', ['scripts/generate_control_protocol.py', '--check']);
      await run('.venv/bin/python', ['-m', 'pytest', '-q', '-m', 'contract', ...args]);
      await lint([]);
      for (const dashboard of ['overview', 'troubleshooting']) await run('jq', ['empty', `${chart}/grafana/dashboards/tasklattice-guard-${dashboard}.json`]);
      for (const extra of [[], ['--set', 'observability.serviceMonitor.enabled=true', '--set', 'observability.prometheusRule.enabled=true', '--set', 'observability.grafanaDashboard.enabled=true'], ['--values', debugValues]]) await run('helm', ['template', release, chart, '--values', devValues, ...extra], true);
      await run('helm', ['template', litellmRelease, litellmChart, '--values', litellmValues], true);
      break;
    default: throw new Error(`Unknown project command: ${action}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
