import { spawn } from 'node:child_process';
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
  if (!component || component === 'controller') {
    await pack();
    await run('docker', ['build', '-f', 'Dockerfile.controller', '-t', env.CONTROLLER_IMAGE ?? `${env.CONTROLLER_REPOSITORY ?? 'ghcr.io/tasklattice/tali-guard-controller'}:dev`, '.']);
  }
  if (!component || component === 'runner') await run('docker', ['build', '-f', 'Dockerfile.runner', '-t', env.RUNNER_IMAGE ?? `${env.RUNNER_REPOSITORY ?? 'ghcr.io/tasklattice/tali-guard-runner'}:dev`, '.']);
}
async function lint(extra = args) {
  for (const values of [required, ['--values', devValues], ['--values', devValues, '--set', 'observability.serviceMonitor.enabled=true', '--set', 'observability.prometheusRule.enabled=true', '--set', 'observability.grafanaDashboard.enabled=true'], ['--values', devValues, '--values', debugValues]]) {
    await run('helm', ['lint', chart, '--strict', ...values, ...extra]);
  }
}
try {
  switch (action) {
    case 'runner': await run('.venv/bin/uvicorn', ['runner.main:app', '--host', env.RUNNER_HTTP_HOST ?? '0.0.0.0', '--port', env.RUNNER_HTTP_PORT ?? '8091', ...args]); break;
    case 'images': await images(args[0]); break;
    case 'helm-package': await run('bash', ['scripts/package-runtime-chart.sh', args[0] ?? env.DEV_CHART_VERSION ?? '0.0.0-dev']); break;
    case 'helm-lint': await lint(); break;
    case 'helm-template': await run('helm', ['template', release, chart, '--namespace', namespace, '--values', devValues, ...args]); break;
    case 'helm-deploy':
    case 'helm-deploy-debug': {
      await images();
      await run('bash', ['scripts/helm-upgrade.sh', release, chart, context, namespace,
        '--values', devValues, ...(action.endsWith('debug') ? ['--values', debugValues] : []),
        '--set', `controller.image.repository=${env.CONTROLLER_REPOSITORY ?? 'ghcr.io/tasklattice/tali-guard-controller'}`,
        '--set-string', 'controller.image.tag=dev',
        '--set', `runner.image.repository=${env.RUNNER_REPOSITORY ?? 'ghcr.io/tasklattice/tali-guard-runner'}`,
        '--set-string', 'runner.image.tag=dev',
        '--set-string', `rolloutRevision=${env.HELM_ROLLOUT_REVISION ?? Date.now().toString()}`,
        '--wait', '--timeout', env.HELM_TIMEOUT ?? '5m', ...args]);
      break;
    }
    case 'helm-status':
      await run('helm', ['status', release, '--kube-context', context, '--namespace', namespace, ...args]);
      await run('kubectl', ['--context', context, '--namespace', namespace, 'get', 'pods,deploy,statefulset,service', '--selector', 'app.kubernetes.io/part-of=tasklattice-guard']); break;
    case 'helm-test': await run('helm', ['test', release, '--kube-context', context, '--namespace', namespace, '--logs', ...args]); break;
    case 'helm-delete': await run('helm', ['uninstall', release, '--kube-context', context, '--namespace', namespace, ...args]); break;
    case 'test-contracts':
      await run('.venv/bin/python', ['scripts/generate_control_protocol.py', '--check']);
      await run('.venv/bin/python', ['-m', 'pytest', '-q', '-m', 'contract', ...args]);
      await lint([]);
      for (const dashboard of ['overview', 'troubleshooting']) await run('jq', ['empty', `${chart}/grafana/dashboards/tasklattice-guard-${dashboard}.json`]);
      for (const extra of [[], ['--set', 'observability.serviceMonitor.enabled=true', '--set', 'observability.prometheusRule.enabled=true', '--set', 'observability.grafanaDashboard.enabled=true'], ['--values', debugValues]]) await run('helm', ['template', release, chart, '--values', devValues, ...extra], true);
      break;
    default: throw new Error(`Unknown project command: ${action}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
