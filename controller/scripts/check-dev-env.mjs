import { existsSync } from 'node:fs';
const required = ['CONTROLLER_DATABASE_URL', 'CONTROLLER_RUNNER_TOKEN', 'CONTROLLER_ARTIFACT_SIGNING_KEY_PATH', 'BETTER_AUTH_SECRET'];
const missing = required.filter(name => !process.env[name] || process.env[name].startsWith('replace-'));
if (missing.length) {
  console.error(`Missing local configuration: ${missing.join(', ')}.\nRun npm run dev:setup from the repository root, then configure PostgreSQL in .env.`);
  process.exitCode = 1;
} else if (!existsSync(process.env.CONTROLLER_ARTIFACT_SIGNING_KEY_PATH)) {
  console.error('The signing key configured in .env does not exist. Restore it or run npm run dev:setup with a new local key path.');
  process.exitCode = 1;
}
