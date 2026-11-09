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
const devValues = env.HELM_DEV_VALUES ?? `${chart}/values-dev-uat.yaml`;
// Debug uses the same development values; only the telemetry switches differ.
const debugArgs = () => [
  '--set', 'observability.performanceDebug.enabled=true',
  '--set-string', `observability.tracing.otlpEndpoint=${env.HELM_OTLP_ENDPOINT ?? 'http://tempo.monitoring.svc.cluster.local:4318'}`,
  '--set-string', `observability.profiling.serverAddress=${env.HELM_PYROSCOPE_ADDRESS ?? 'http://pyroscope.monitoring.svc.cluster.local:4040'}`,
  '--set-string', `observability.serviceMonitor.labels.release=${env.HELM_MONITORING_RELEASE ?? 'monitoring'}`,
  '--set-string', `observability.prometheusRule.labels.release=${env.HELM_MONITORING_RELEASE ?? 'monitoring'}`,
];
const release = env.HELM_RELEASE ?? 'tali-guard';
const namespace = env.HELM_NAMESPACE ?? 'tali';
const context = env.HELM_CONTEXT ?? 'orbstack';
// Optional LiteLLM provider uses the same chart and release as Guard.
// Published by github.com/tasklattice/tasklattice-litellm-guard; pinned once
// under litellm-provider.image in the main values.yaml.
function litellmPinnedImage() {
  const values = readFileSync(new URL(`../${chart}/values.yaml`, import.meta.url), 'utf8');
  const provider = /^litellm-provider:\n((?:[ \t]+.*\n|\s*\n)+)/m.exec(values)?.[1] ?? '';
  const block = /^  image:\n((?:[ \t]{4,}.*\n|\s*\n)+)/m.exec(provider)?.[1] ?? '';
  const field = (name) => new RegExp(`^\\s+${name}:\\s*"?([^"\\s#]+)"?`, 'm').exec(block)?.[1];
  if (!field('repository') || !field('tag')) throw new Error(`${chart}/values.yaml must pin litellm-provider.image.repository and image.tag`);
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
    await run('.venv/bin/python', ['scripts/generate_control_protocol.py']);
    await run('.venv/bin/python', ['scripts/generate_enforcement_action_contract.py']);
    await run('.venv/bin/python', ['scripts/policy_sources.py', 'build']);
    await run('.venv/bin/python', ['scripts/generate_default_baseline.py']);
    await pack();
    await run('docker', ['build', '--build-arg', `TALI_BUILD_INFO=${buildInfo}`, '-f', 'Dockerfile.controller', '-t', env.CONTROLLER_IMAGE ?? `${env.CONTROLLER_REPOSITORY ?? 'ghcr.io/tasklattice/tali-guard-controller'}:dev`, '.']);
  }
  if (!component || component === 'runner') await run('docker', ['build', '--build-arg', `TALI_BUILD_INFO=${buildInfo}`, '-f', 'Dockerfile.runner', '-t', env.RUNNER_IMAGE ?? `${env.RUNNER_REPOSITORY ?? 'ghcr.io/tasklattice/tali-guard-runner'}:dev`, '.']);
}
async function lint(extra = args) {
  for (const values of [required, ['--values', devValues], ['--values', devValues, '--set', 'observability.serviceMonitor.enabled=true', '--set', 'observability.prometheusRule.enabled=true', '--set', 'observability.grafanaDashboard.enabled=true'], ['--values', devValues, ...debugArgs()], ['--values', devValues, '--values', `${chart}/values-dev-keycloak.yaml`]]) {
    await run('helm', ['lint', chart, '--strict', ...values, ...extra]);
  }
  await run('helm', ['lint', chart, '--strict', '--values', devValues, '--set', 'litellm-provider.enabled=true', ...extra]);
}
async function deployGuard(debug, extra) {
  await images();
  await run('bash', ['scripts/helm-upgrade.sh', release, chart, context, namespace,
    '--values', devValues, ...(debug ? debugArgs() : []),
    '--set', `controller.image.repository=${env.CONTROLLER_REPOSITORY ?? 'ghcr.io/tasklattice/tali-guard-controller'}`,
    '--set-string', 'controller.image.tag=dev',
    '--set', `runner.image.repository=${env.RUNNER_REPOSITORY ?? 'ghcr.io/tasklattice/tali-guard-runner'}`,
    '--set-string', 'runner.image.tag=dev',
    '--set-string', `rolloutRevision=${env.HELM_ROLLOUT_REVISION ?? Date.now().toString()}`,
    '--wait', '--timeout', env.HELM_TIMEOUT ?? '5m', ...extra]);
}
// Upgrade an existing Guard release while preserving its configured values.
// Reset first so newly added chart defaults are present on older releases.
const upgradeExisting = (extra) => run('helm', ['upgrade', release, chart,
  '--kube-context', context, '--namespace', namespace,
  '--reset-then-reuse-values', '--server-side=false',
  '--wait', '--timeout', env.HELM_TIMEOUT ?? '5m', ...extra]);
async function deployLitellm(extra) {
  const image = litellmImage();
  // Development uses preloaded images; deploying never pulls from a registry.
  await run('docker', ['image', 'inspect', image], true).catch(() => {
    throw new Error(`Load the LiteLLM image ${image} into local Docker before deploying.`);
  });
  // The Provider must speak this Runner's output-stream protocol. An image
  // built for another protocol is refused here rather than failing at the
  // first streamed completion.
  if (env.LITELLM_SKIP_IMAGE_VERIFY !== '1') {
    try { await run('.venv/bin/python', ['scripts/verify_relay_stream_image.py', image]); }
    catch (error) {
      throw new Error(`${error.message}\n${image} is not compatible with this Guard. Pin a tasklattice-litellm-guard release built for it in ${chart}/values.yaml (litellm-provider.image), or set LITELLM_IMAGE.`);
    }
  }
  const upstream = ['LITELLM_UPSTREAM_API_BASE', 'LITELLM_UPSTREAM_SECRET', 'LITELLM_UPSTREAM_MODEL'].map((key) => env[key]);
  if (upstream.some(Boolean) && !upstream.every(Boolean)) throw new Error('Set LITELLM_UPSTREAM_API_BASE, LITELLM_UPSTREAM_SECRET and LITELLM_UPSTREAM_MODEL together.');
  const [apiBase, upstreamSecret, model] = upstream;
  // The wiring script requires a running Guard and writes the Endpoint
  // credential Secret itself; credentials never pass through Helm values.
  await run('node', ['scripts/litellm-dev-wire.mjs']);
  await upgradeExisting([
    '--set', 'litellm-provider.enabled=true',
    '--set', `litellm-provider.image.repository=${image.slice(0, image.lastIndexOf(':'))}`,
    '--set-string', `litellm-provider.image.tag=${image.slice(image.lastIndexOf(':') + 1)}`,
    ...(env.LITELLM_GUARD_SECRET ? ['--set-string', `litellm-provider.guard.existingSecret=${env.LITELLM_GUARD_SECRET}`] : []),
    ...(apiBase ? ['--set-string', `litellm-provider.model.upstream.apiBase=${apiBase}`, '--set-string', `litellm-provider.model.upstream.existingSecret=${upstreamSecret}`, '--set-string', `litellm-provider.model.upstream.model=${model}`] : []),
    ...extra]);
  if (env.LITELLM_SKIP_SMOKE !== '1') await run('node', ['scripts/litellm-dev-smoke.mjs']);
}
try {
  switch (action) {
    case 'runner': await run('.venv/bin/uvicorn', ['runner.main:app', '--host', env.RUNNER_HTTP_HOST ?? '0.0.0.0', '--port', env.RUNNER_HTTP_PORT ?? '8091', ...args]); break;
    case 'images': await images(args[0]); break;
    case 'helm-package': await run('bash', ['scripts/package-runtime-chart.sh', args[0] ?? env.DEV_CHART_VERSION ?? '0.0.0-dev']); break;
    case 'helm-lint': await lint(); break;
    case 'helm-template': await run('helm', ['template', release, chart, '--namespace', namespace, '--values', devValues, ...args]); break;
    case 'helm-deploy-keycloak': await deployGuard(false, ['--values', `${chart}/values-dev-keycloak.yaml`, '--wait-for-jobs', ...args]); break;
    case 'helm-deploy':
    case 'helm-deploy-debug': await deployGuard(action.endsWith('debug'), args); break;
    case 'litellm-deploy': await deployLitellm(args); break;
    case 'litellm-deploy-full': await deployGuard(false, [...args, '--set', 'litellm-provider.enabled=false']); await deployLitellm(args); break;
    case 'litellm-status':
      await run('helm', ['status', release, '--kube-context', context, '--namespace', namespace, ...args]);
      await run('kubectl', ['--context', context, '--namespace', namespace, 'get', 'pods,deploy,statefulset,service', '--selector', `app.kubernetes.io/instance=${release},app.kubernetes.io/group=litellm-provider`]); break;
    case 'litellm-delete': await upgradeExisting(['--set', 'litellm-provider.enabled=false', ...args]); break;
    case 'helm-status':
      await run('helm', ['status', release, '--kube-context', context, '--namespace', namespace, ...args]);
      await run('kubectl', ['--context', context, '--namespace', namespace, 'get', 'pods,deploy,statefulset,service', '--selector', 'app.kubernetes.io/part-of=tasklattice-guard']); break;
    case 'helm-test': await run('helm', ['test', release, '--kube-context', context, '--namespace', namespace, '--logs', ...args]); break;
    case 'helm-delete': await run('helm', ['uninstall', release, '--kube-context', context, '--namespace', namespace, ...args]); break;
    case 'test-contracts':
      await run('.venv/bin/python', ['-m', 'pytest', '-q', '-m', 'contract', ...args]);
      await lint([]);
      for (const dashboard of ['overview', 'troubleshooting']) await run('jq', ['empty', `${chart}/grafana/dashboards/tasklattice-guard-${dashboard}.json`]);
      for (const extra of [[], ['--set', 'observability.serviceMonitor.enabled=true', '--set', 'observability.prometheusRule.enabled=true', '--set', 'observability.grafanaDashboard.enabled=true'], debugArgs(), ['--values', `${chart}/values-dev-keycloak.yaml`]]) await run('helm', ['template', release, chart, '--values', devValues, ...extra], true);
      await run('helm', ['template', release, chart, '--values', devValues, '--set', 'litellm-provider.enabled=true'], true);
      break;
    default: throw new Error(`Unknown project command: ${action}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
