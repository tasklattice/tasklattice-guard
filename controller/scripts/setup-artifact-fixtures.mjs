import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Controller codec tests also consume signed Runner fixtures on fresh checkouts.
export default function setup() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  execFileSync(resolve(root, '.venv/bin/python'), ['scripts/generate_test_artifacts.py'], {
    cwd: root,
    stdio: 'inherit',
    timeout: 600_000,
  });
}
