import { gitBuildInfo } from "./git-build-info.mjs";
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

function run(command, argv, quiet = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { cwd: root, env, stdio: quiet ? ['inherit', 'ignore', 'inherit'] : 'inherit' });
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
