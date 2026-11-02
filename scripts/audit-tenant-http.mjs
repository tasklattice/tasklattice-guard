#!/usr/bin/env node
/** Read-only local demo authorization audit; identities and fixture keys remain private.
 * Run from repository root with the documented local private fixtures and localhost Controller.
 * This creates login sessions and audit records but does not mutate tenant resources.
 */
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const dir='.local-secrets/tenant-runtime-20261026/';
const ids=JSON.parse(await readFile(dir+'identities.json','utf8'));
const f=JSON.parse(await readFile(dir+'load-lab-fixtures.json','utf8')).fixtures;
const base='http://127.0.0.1:38081';
const names=['tenantA','tenantB','tenantC'];
const sessions={};
for (const who of names){
 const r=await fetch(base+'/api/auth/sign-in/email',{method:'POST',headers:{'content-type':'application/json',origin:'http://localhost:38081'},body:JSON.stringify(ids[who]),signal:AbortSignal.timeout(10000)});
 assert.equal(r.status,200,`${who} login`);sessions[who]=r.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');assert(sessions[who]);
}
async function get(who,path,extra={}){return fetch(base+path,{headers:{cookie:sessions[who],...extra},signal:AbortSignal.timeout(10000)});}
async function expectStatus(label,promise,status){const r=await promise;assert.equal(r.status,status,`${label}: expected ${status}, got ${r.status}`);console.log(`${label}: ${r.status}`);return r;}
for(const who of names){
 const me=await expectStatus(`${who} identity`,get(who,'/api/v1/account/identity'),200);
 assert.equal((await me.json()).tenantId,who);
 for(const owner of names){
  const e=encodeURIComponent(f[owner].endpoint.id),router=encodeURIComponent(f[owner].router.id);
  await expectStatus(`${who} reads ${owner} Endpoint`,get(who,`/api/v1/endpoints/${e}`),owner===who?200:404);
  await expectStatus(`${who} reads ${owner} Router`,get(who,`/api/v1/routers/${router}`),owner===who?200:404);
 }
 const list=await expectStatus(`${who} spoofed Endpoint list`,get(who,'/api/v1/endpoints?tenantId=tenantC',{'x-tenant-id':'tenantC','x-role':'admin'}),200);
 const items=(await list.json()).items;assert(items.some(x=>x.id===f[who].endpoint.id));
 for(const owner of names.filter(x=>x!==who))assert(!items.some(x=>x.id===f[owner].endpoint.id),`${who} saw ${owner} endpoint`);
 const pools=await expectStatus(`${who} Runner pool list`,get(who,'/api/v1/runner-pools'),200);
 const poolids=(await pools.json()).items.map(x=>x.id);
 assert.deepEqual(poolids,who==='tenantC'?['group-demo']:['default']);
 await expectStatus(`${who} platform groups denied`,get(who,'/api/v1/tenant-groups'),403);
 const mutation=await fetch(base+'/api/v1/runner-pools/default',{method:'PATCH',headers:{cookie:sessions[who],'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});
 assert.equal(mutation.status,403,`${who} pool mutation denied`);console.log(`${who} pool mutation denied: 403`);
}
console.log('Live ownership, same/cross-group visibility, header spoof resistance and admin RBAC checks passed.');
