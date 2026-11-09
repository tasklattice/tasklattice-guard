import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('a source-only checkout generates and ships OpenAPI without a tracked snapshot', { timeout: 120_000 }, t => {
  const root = mkdtempSync(join(tmpdir(), 'guard-openapi-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = fileURLToPath(new URL('../', import.meta.url));
  for (const path of ['package.json', 'tsconfig.server.json', 'server', 'shared', 'scripts/generate-openapi.mjs']) {
    cpSync(join(source, path), join(root, path), { recursive: true });
  }
  symlinkSync(join(source, 'node_modules'), join(root, 'node_modules'), 'dir');
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const output = join(root, 'openapi/controller.openapi.json');
  assert.equal(existsSync(output), false);
  run('npm', ['run', 'build:server']);
  const generated = readFileSync(output, 'utf8');
  assert.equal(JSON.parse(generated).openapi, '3.1.0');
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'dist-server/openapi/controller.openapi.json'), 'utf8')), JSON.parse(generated));

  // Production serves the build output even with the source artifact removed.
  rmSync(output);
  const served = run(process.execPath, ['--input-type=module', '-e',
    'import { openApiDocument } from "./dist-server/server/http/openapi.js"; console.log(JSON.stringify(openApiDocument()));']);
  assert.deepEqual(JSON.parse(served), JSON.parse(generated));

  // Existing stale output is replaced; unchanged output does not trigger watchers.
  writeFileSync(output, '{"stale":true}\n');
  run(process.execPath, ['--import', 'tsx', 'scripts/generate-openapi.mjs']);
  assert.equal(readFileSync(output, 'utf8'), generated);
  const modified = statSync(output).mtimeMs;
  run(process.execPath, ['--import', 'tsx', 'scripts/generate-openapi.mjs']);
  assert.equal(statSync(output).mtimeMs, modified);
});
