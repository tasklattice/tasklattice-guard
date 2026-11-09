/** Guard adaptation of Relay's scripts/configure-dev-keycloak-sso.sh.
 * Keycloak imports the realm; this step provisions Guard through its admin API.
 * No local SSO membership writes and no database access.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export async function provisionProjects(api, identities) {
  for (const project of identities.projects) {
    const { name, groupId } = project;
    if (groupId !== 'default' && !(await api(`/api/v1/project-groups/${groupId}`, { optional: true }))) {
      await api('/api/v1/project-groups', { body: { id: groupId, name }, status: 201 });
    }
    // Search only this name, page summaries; never hydrate every user's access.
    let existing;
    let cursor;
    do {
      const query = new URLSearchParams({ q: name, limit: '25', ...(cursor ? { cursor } : {}) });
      const page = await api(`/api/v1/projects?${query}`);
      existing = page.items.find(item => item.id === name);
      cursor = page.nextCursor;
    } while (!existing && cursor);
    if (existing) {
      if (existing.groupId !== groupId || existing.externalDepartmentId !== identities.department) {
        throw new Error(`Project ${name} already exists with different group/SSO settings; refusing to reassign it.`);
      }
    } else {
      await api('/api/v1/projects', { body: { name, groupId, externalDepartmentId: identities.department }, status: 201 });
    }
  }
}

export async function bootstrap(environment = process.env) {
  const base = environment.GUARD_CONTROLLER_URL;
  const origin = environment.GUARD_PUBLIC_URL;
  const identities = JSON.parse(readFileSync(environment.GUARD_DEV_IDENTITIES, 'utf8'));
  const username = readFileSync(`${environment.GUARD_ADMIN_DIRECTORY}/${environment.GUARD_ADMIN_USERNAME_KEY || 'username'}`, 'utf8').trim();
  const password = readFileSync(`${environment.GUARD_ADMIN_DIRECTORY}/${environment.GUARD_ADMIN_PASSWORD_KEY || 'password'}`, 'utf8');
  let cookie = '';
  async function api(path, { body, method = body === undefined ? 'GET' : 'POST', status = 200, optional = false } = {}) {
    const response = await fetch(new URL(path, base), {
      method, headers: { 'content-type': 'application/json', origin, cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    if (optional && response.status === 404) return null;
    // Never print response bodies, passwords, cookies or tokens.
    if (response.status !== status) throw new Error(`${method} ${path}: HTTP ${response.status}`);
    if (path === '/api/auth/sign-in/username') cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    return response.status === 204 ? null : response.json();
  }
  // Wait for the Controller before provisioning development Projects.
  // Runner allocation and capacity are managed manually in the admin UI.
  const deadline = Date.now() + 240_000;
  while (true) {
    try {
      await api('/health/ready');
      if (!(await api('/api/sign-in/options')).sso) throw new Error('Waiting for the SSO-enabled Controller.');
      break;
    }
    catch (error) { if (Date.now() >= deadline) throw error; await delay(2_000); }
  }
  await api('/api/auth/sign-in/username', { body: { username, password } });
  try {
    await provisionProjects(api, identities);
    console.log('Keycloak development Projects ready: ' + identities.projects.map(p => `${p.username} → ${p.name}`).join('; '));
  } finally {
    await api('/api/auth/sign-out', { body: {} });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  bootstrap().catch(error => { console.error(error.message); process.exitCode = 1; });
}
