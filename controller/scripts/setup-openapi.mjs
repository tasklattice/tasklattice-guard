import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Run once before test collection, including direct `npx vitest` invocations.
// A separate process gives the generator native TypeScript/tsx module loading.
export default function setup() {
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/generate-openapi.mjs'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    stdio: 'inherit',
  });
}
