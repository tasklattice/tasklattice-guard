import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'guard-command-test-'));
  for (const dir of ['scripts', 'bin']) mkdirSync(join(root, dir));
  copyFileSync(new URL('./project-commands.mjs', import.meta.url), join(root, 'scripts/project-commands.mjs'));
  const log = join(root, 'commands.jsonl');
  for (const command of ['docker', 'helm', 'bash', 'kubectl']) {
    writeFileSync(join(root, 'bin', command), `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(process.env.COMMAND_LOG,JSON.stringify({command:${JSON.stringify(command)},args:process.argv.slice(2),controllerRepository:process.env.TALI_GUARD_CONTROLLER_IMAGE_REPOSITORY,runnerRepository:process.env.TALI_GUARD_RUNNER_IMAGE_REPOSITORY})+'\\n');process.exit(process.env.FAIL_COMMAND===${JSON.stringify(command)}?1:0);\n`, { mode: 0o755 });
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
    assert.equal(calls[3].args.includes('charts/tali-guard/values-debug.yaml'), action.endsWith('debug'));
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
  assert.deepEqual(calls.map(call => [call.command, call.args]), [
    ['bash', ['scripts/package-runtime-chart.sh', '0.0.0-test']],
    ['docker', ['build', '-f', 'Dockerfile.controller', '-t', 'registry.test/controller:dev', '.']],
    ['docker', ['build', '-f', 'Dockerfile.runner', '-t', 'registry.test/runner:dev', '.']],
  ]);
  assert.equal(calls[0].controllerRepository, 'registry.test/controller');
  assert.equal(calls[0].runnerRepository, 'registry.test/runner');
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
