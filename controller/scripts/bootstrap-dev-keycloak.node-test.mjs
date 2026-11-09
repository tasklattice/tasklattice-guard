import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { provisionProjects } from './runtime/bootstrap-dev-keycloak.mjs';

const identities = JSON.parse(readFileSync(new URL('../../charts/tali-guard/files/keycloak-dev-identities.json', import.meta.url)));
function fixture() {
  const projects = new Map();
  const groups = new Map([['default', { id: 'default' }]]);
  const writes = [];
  const api = async (path, options = {}) => {
    const { body, method } = options;
    if (body) writes.push({ path, body, method });
    if (path.startsWith('/api/v1/projects?')) return { items: [...projects.values()], nextCursor: null };
    if (path === '/api/v1/projects') { projects.set(body.name, { id: body.name, ...body }); return projects.get(body.name); }
    if (path === '/api/v1/project-groups') { groups.set(body.id, body); return body; }
    if (path.startsWith('/api/v1/project-groups/')) return groups.get(path.split('/').at(-1)) ?? null;
    throw new Error(`Unexpected API call ${path}`);
  };
  return { api, projects, groups, writes };
}

test('provisions development Projects without Runner operations; rerun makes no writes or local SSO memberships', async () => {
  const f = fixture();
  await provisionProjects(f.api, identities);
  assert.deepEqual([...f.projects.keys()], ['test1', 'test2']);
  assert.equal(f.projects.get('test1').groupId, 'default');
  assert.equal(f.projects.get('test2').externalDepartmentId, 'dep1');
  assert.equal(f.writes.some(call => /members|users/.test(call.path)), false);
  f.writes.length = 0;
  await provisionProjects(f.api, identities);
  assert.deepEqual(f.writes, []);
});

test('does not silently reassign an existing Project to a different SSO department', async () => {
  const f = fixture();
  f.projects.set('test1', { id: 'test1', groupId: 'default', externalDepartmentId: 'other' });
  await assert.rejects(provisionProjects(f.api, identities), /refusing to reassign/);
  assert.deepEqual(f.writes, []);
});
