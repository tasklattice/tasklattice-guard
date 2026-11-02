import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'guard-command-test-'));
  for (const dir of ['scripts', 'bin', '.venv/bin', 'charts/tali-litellm-dev']) mkdirSync(join(root, dir), { recursive: true });
  copyFileSync(new URL('../charts/tali-litellm-dev/values.yaml', import.meta.url), join(root, 'charts/tali-litellm-dev/values.yaml'));
  copyFileSync(new URL('./project-commands.mjs', import.meta.url), join(root, 'scripts/project-commands.mjs'));
  copyFileSync(new URL('./git-build-info.mjs', import.meta.url), join(root, 'scripts/git-build-info.mjs'));
  for (const args of [['init'], ['config', 'user.email', 'test@example.com'], ['config', 'user.name', 'Test'], ['add', '.'], ['commit', '-m', 'initial']]) {
    const result = spawnSync('git', ['-C', root, ...args]);
    assert.equal(result.status, 0, result.stderr?.toString());
  }
  const log = join(root, 'commands.jsonl');
  for (const command of ['docker', 'helm', 'bash', 'kubectl', 'node', '.venv/bin/python']) {
    const name = command.split('/').pop();
    const fake = `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(process.env.COMMAND_LOG,JSON.stringify({command:${JSON.stringify(name)},args:process.argv.slice(2),controllerRepository:process.env.TALI_GUARD_CONTROLLER_IMAGE_REPOSITORY,runnerRepository:process.env.TALI_GUARD_RUNNER_IMAGE_REPOSITORY})+'\\n');process.exit(process.env.FAIL_COMMAND===${JSON.stringify(name)}?1:0);\n`;
    writeFileSync(join(root, command.includes('/') ? command : join('bin', command)), fake, { mode: 0o755 });
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    run(action, args = [], extra = {}) {
      return spawnSync(process.execPath, [join(root, 'scripts/project-commands.mjs'), action, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, COMMAND_LOG: log, HELM_CONTEXT: 'test-context', HELM_NAMESPACE: 'test-namespace', ...extra } });
    },
    calls: () => readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse),
  };
}
for (const action of ['helm-deploy', 'helm-deploy-debug']) {
  test(`${action} builds images before Helm and preserves argument boundaries`, t => {
    const f = fixture(t);
    const result = f.run(action, ['--values', '/tmp/values with spaces.yaml'], { HELM_ROLLOUT_REVISION: 'regression', HELM_TIMEOUT: '5m' });
    assert.equal(result.status, 0, result.stderr);
    const calls = f.calls();
    assert.deepEqual(calls.map(c => c.command), ['bash', 'docker', 'docker', 'bash']);
    assert.equal(calls[0].args[0], 'scripts/package-runtime-chart.sh');
    assert.deepEqual(calls[3].args.slice(0, 5), ['scripts/helm-upgrade.sh', 'tali-guard', 'charts/tali-guard', 'test-context', 'test-namespace']);
    assert.deepEqual(calls[3].args.slice(-2), ['--values', '/tmp/values with spaces.yaml']);
    assert.ok(calls[3].args.includes('--wait'));
    assert.equal(calls[3].args[calls[3].args.indexOf('--timeout') + 1], '5m');
    assert.ok(calls[3].args.includes('rolloutRevision=regression'));
    assert.deepEqual(calls[3].args.filter((arg, index, args) => args[index - 1] === '--values'), ['charts/tali-guard/values-dev-uat.yaml', '/tmp/values with spaces.yaml']);
    assert.equal(calls[3].args.includes('observability.performanceDebug.enabled=true'), action.endsWith('debug'));
    if (action.endsWith('debug')) {
      assert.ok(calls[3].args.includes('observability.tracing.otlpEndpoint=http://tempo.monitoring.svc.cluster.local:4318'));
      assert.ok(calls[3].args.includes('observability.profiling.serverAddress=http://pyroscope.monitoring.svc.cluster.local:4040'));
      assert.ok(calls[3].args.includes('observability.serviceMonitor.labels.release=monitoring'));
    }
    assert.equal(calls.some(call => call.args.includes('create') && call.args.includes('secret')), false);
  });
}
test('image builds package the release version and pass repository overrides', t => {
  const f = fixture(t);
  const result = f.run('images', [], {
    CONTROLLER_REPOSITORY: 'registry.test/controller', RUNNER_REPOSITORY: 'registry.test/runner',
    DEV_CHART_VERSION: '0.0.0-test',
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  assert.deepEqual(calls.map(call => [call.command, call.args.filter((arg, index, args) => arg !== '--build-arg' && args[index - 1] !== '--build-arg')]), [
    ['bash', ['scripts/package-runtime-chart.sh', '0.0.0-test']],
    ['docker', ['build', '-f', 'Dockerfile.controller', '-t', 'registry.test/controller:dev', '.']],
    ['docker', ['build', '-f', 'Dockerfile.runner', '-t', 'registry.test/runner:dev', '.']],
  ]);
  const buildInfo = JSON.parse(calls[1].args.find(arg => arg.startsWith('TALI_BUILD_INFO=')).slice('TALI_BUILD_INFO='.length));
  assert.equal(buildInfo.source, 'build');
  assert.match(buildInfo.commit, /^[0-9a-f]{40}$/);
  assert.equal(calls[0].controllerRepository, 'registry.test/controller');
  assert.equal(calls[0].runnerRepository, 'registry.test/runner');
});
const pinnedLitellm = /^image:\n(?:\s+.*\n)*?\s+tag:\s*"([^"]+)"/m.exec(readFileSync(new URL('../charts/tali-litellm-dev/values.yaml', import.meta.url), 'utf8'))[1];
test('litellm-deploy uses the preloaded chart-pinned image, verifies its protocol, wires Guard, then installs the test chart', t => {
  const f = fixture(t);
  const result = f.run('litellm-deploy', ['--set', 'replicaCount=1'], { HELM_TIMEOUT: '7m' });
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  const image = `ghcr.io/tasklattice/tali-litellm:${pinnedLitellm}`;
  assert.match(pinnedLitellm, /^\d+\.\d+\.\d+-guard\.\d+$/);
  assert.deepEqual(calls.map(c => c.command), ['docker', 'python', 'node', 'bash', 'node']);
  assert.deepEqual(calls[0].args, ['image', 'inspect', image]);
  assert.deepEqual(calls[1].args, ['scripts/verify_relay_stream_image.py', image]);
  assert.deepEqual(calls[2].args, ['scripts/litellm-dev-wire.mjs']);
  assert.deepEqual(calls[3].args.slice(0, 5), ['scripts/helm-upgrade.sh', 'tali-litellm-dev', 'charts/tali-litellm-dev', 'test-context', 'test-namespace']);
  assert.ok(calls[3].args.includes('charts/tali-litellm-dev/values-dev.yaml'));
  assert.ok(calls[3].args.includes('image.repository=ghcr.io/tasklattice/tali-litellm'));
  assert.ok(calls[3].args.includes(`image.tag=${pinnedLitellm}`));
  assert.equal(calls[3].args.some(arg => arg.startsWith('model.upstream.')), false);
  assert.equal(calls[3].args[calls[3].args.indexOf('--timeout') + 1], '7m');
  assert.deepEqual(calls[3].args.slice(-2), ['--set', 'replicaCount=1']);
  assert.deepEqual(calls[4].args, ['scripts/litellm-dev-smoke.mjs']);
});
test('LITELLM_IMAGE overrides the chart pin for local inspection, verification and install', t => {
  const f = fixture(t);
  const result = f.run('litellm-deploy', [], { LITELLM_IMAGE: 'registry.test/litellm:1.88.0-guard.2', LITELLM_SKIP_SMOKE: '1' });
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  assert.deepEqual(calls[0].args, ['image', 'inspect', 'registry.test/litellm:1.88.0-guard.2']);
  assert.ok(calls[3].args.includes('image.repository=registry.test/litellm') && calls[3].args.includes('image.tag=1.88.0-guard.2'));
});
test('litellm-deploy stops before touching Guard when the image is not preloaded locally', t => {
  const f = fixture(t);
  const result = f.run('litellm-deploy', [], { FAIL_COMMAND: 'docker' });
  assert.equal(result.status, 1);
  assert.deepEqual(f.calls().map(c => c.args[0]), ['image']);
});
test('litellm-deploy refuses an image whose Provider speaks another stream protocol', t => {
  const f = fixture(t);
  const result = f.run('litellm-deploy', [], { FAIL_COMMAND: 'python' });
  assert.equal(result.status, 1);
  assert.deepEqual(f.calls().map(c => c.command), ['docker', 'python']);
  assert.match(result.stderr, /not compatible with this Guard/);
});
test('litellm-deploy passes a complete upstream provider and skips the smoke test on request', t => {
  const f = fixture(t);
  const result = f.run('litellm-deploy', [], { LITELLM_UPSTREAM_API_BASE: 'https://api.example/v1', LITELLM_UPSTREAM_SECRET: 'upstream', LITELLM_UPSTREAM_MODEL: 'gpt-test', LITELLM_SKIP_SMOKE: '1' });
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  assert.deepEqual(calls.map(c => c.command), ['docker', 'python', 'node', 'bash']);
  assert.ok(calls[3].args.includes('model.upstream.apiBase=https://api.example/v1'));
  assert.ok(calls[3].args.includes('model.upstream.model=gpt-test'));
  assert.ok(calls[3].args.includes('model.upstream.existingSecret=upstream'));
  assert.ok(!calls[3].args.some(arg => arg.includes('sk-test')));
  const partial = f.run('litellm-deploy', [], { LITELLM_UPSTREAM_API_BASE: 'https://api.example/v1', LITELLM_SKIP_SMOKE: '1' });
  assert.equal(partial.status, 1);
  assert.match(partial.stderr, /together/);
});
test('litellm-deploy-full deploys Guard exactly like helm-deploy before LiteLLM', t => {
  const f = fixture(t);
  const result = f.run('litellm-deploy-full', [], { HELM_ROLLOUT_REVISION: 'regression', LITELLM_SKIP_SMOKE: '1' });
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  assert.deepEqual(calls.map(c => c.command), ['bash', 'docker', 'docker', 'bash', 'docker', 'python', 'node', 'bash']);
  assert.deepEqual(calls[3].args.slice(0, 3), ['scripts/helm-upgrade.sh', 'tali-guard', 'charts/tali-guard']);
  assert.ok(calls[3].args.includes('rolloutRevision=regression'));
  assert.deepEqual(calls[4].args, ['image', 'inspect', `ghcr.io/tasklattice/tali-litellm:${pinnedLitellm}`]);
  assert.deepEqual(calls[7].args.slice(0, 3), ['scripts/helm-upgrade.sh', 'tali-litellm-dev', 'charts/tali-litellm-dev']);
});
test('helm-deploy never touches the LiteLLM test chart or image', t => {
  const f = fixture(t);
  assert.equal(f.run('helm-deploy').status, 0);
  assert.equal(f.calls().some(call => call.args.some(arg => String(arg).includes('litellm'))), false);
});
test('build failure prevents deployment', t => {
  const f = fixture(t);
  const result = f.run('helm-deploy', [], { FAIL_COMMAND: 'docker' });
  assert.equal(result.status, 1);
  assert.deepEqual(f.calls().map(c => c.command), ['bash', 'docker']);
});
test('render does not build images or call the cluster', t => {
  const f = fixture(t);
  assert.equal(f.run('helm-template').status, 0);
  assert.equal(f.calls().length, 1);
  assert.deepEqual(f.calls()[0].args.slice(0, 3), ['template', 'tali-guard', 'charts/tali-guard']);
  assert.ok(f.calls()[0].args.includes('charts/tali-guard/values-dev-uat.yaml'));
});
test('development values and debug backend overrides reach Helm before explicit user flags', t => {
  const f = fixture(t);
  const result = f.run('helm-deploy-debug', ['--set-string', 'observability.tracing.otlpEndpoint=http://explicit:4318'], {
    HELM_DEV_VALUES: '/tmp/custom uat.yaml',
    HELM_OTLP_ENDPOINT: 'http://collector:4318',
    HELM_PYROSCOPE_ADDRESS: 'http://profiler:4040',
    HELM_MONITORING_RELEASE: 'uat-monitoring',
  });
  assert.equal(result.status, 0, result.stderr);
  const args = f.calls()[3].args;
  assert.deepEqual(args.filter((arg, index) => args[index - 1] === '--values'), ['/tmp/custom uat.yaml']);
  assert.ok(args.includes('observability.tracing.otlpEndpoint=http://collector:4318'));
  assert.ok(args.includes('observability.profiling.serverAddress=http://profiler:4040'));
  assert.ok(args.includes('observability.serviceMonitor.labels.release=uat-monitoring'));
  assert.ok(args.includes('observability.prometheusRule.labels.release=uat-monitoring'));
  assert.deepEqual(args.slice(-2), ['--set-string', 'observability.tracing.otlpEndpoint=http://explicit:4318']);
});
test('lint covers default, UAT and debug settings without an additional Guard values file', t => {
  const f = fixture(t);
  const result = f.run('helm-lint');
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  assert.ok(calls.every(call => call.command === 'helm' && call.args[0] === 'lint'));
  const guardCalls = calls.filter(call => call.args[1] === 'charts/tali-guard');
  assert.equal(guardCalls.length, 4);
  assert.ok(guardCalls[3].args.includes('observability.performanceDebug.enabled=true'));
  assert.deepEqual(guardCalls.flatMap(call => call.args.filter((arg, i) => call.args[i - 1] === '--values')), Array(3).fill('charts/tali-guard/values-dev-uat.yaml'));
});
test('developer env loading preserves explicit shell overrides', () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-env-load-'));
  try {
    const envPath = join(root, '.env');
    writeFileSync(envPath, 'CONTROLLER_HTTP_PORT=8080\nCONTROLLER_RUNNER_TOKEN=test-token\n');
    const result = spawnSync(process.execPath, [`--env-file=${envPath}`, '-e', 'process.stdout.write(JSON.stringify([process.env.CONTROLLER_HTTP_PORT,process.env.CONTROLLER_RUNNER_TOKEN]))'], { encoding:'utf8', env: { PATH:process.env.PATH, CONTROLLER_HTTP_PORT:'18080' } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['18080', 'test-token']);
  } finally { rmSync(root, { recursive:true, force:true }); }
});
