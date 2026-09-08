#!/usr/bin/env node
/** Compile a named exact copy of the reviewed Default without editing Default. */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
const required=k=>{assert(process.env[k],`Set ${k}`);return process.env[k];};
assert.equal(required('GUARD_REGRESSION_ALLOW_WRITES'),'1');
const base=new URL(required('GUARD_REGRESSION_CONTROLLER_URL'));
assert(['127.0.0.1','localhost'].includes(base.hostname));
const origin=required('GUARD_REGRESSION_ORIGIN');
let cookie='';
async function call(path,body,status=200){
  const r=await fetch(new URL(path,base),{method:body===undefined?'GET':'POST',
    headers:{'content-type':'application/json',origin,cookie},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30_000)});
  assert.equal(r.status,status,`${path}: HTTP ${r.status}`);
  return {value:await r.json(),response:r};
}
async function until(read,ready){
  const end=Date.now()+180_000;
  while(Date.now()<end){const value=await read();if(ready(value))return value;await delay(1000);}
  throw Error('Timed out; retain and inspect the existing copy before resuming.');
}
const a=await call('/api/auth/sign-in/email',{email:required('GUARD_REGRESSION_EMAIL'),password:required('GUARD_REGRESSION_PASSWORD')});
cookie=a.response.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
const original=(await call('/api/v1/guardrails/guardrail-default')).value;
assert(original.activeArtifactId && original.versions.some(v=>v.version===original.activeVersion && v.sourceDraftRevision===original.draftRevision));
assert.deepEqual(original.excludedTestCaseIds,[]);
const name=`Regression Default copy ${required('GUARD_REGRESSION_RUN_ID')}`;
const found=(await call('/api/v1/guardrails')).value.items.filter(x=>x.name===name);
assert(found.length<=1);
const copy=found[0]??(await call('/api/v1/guardrails',{
  name,runtimeProfile:original.runtimeProfile,draftConfig:original.draftConfig},201)).value;
const path=`/api/v1/guardrails/${copy.id}`;
let detail=(await call(path)).value;
assert.deepEqual(detail.draftConfig,original.draftConfig,'Copy must preserve every binding, ordering, action and expectation override');
assert.deepEqual(detail.excludedTestCaseIds,[]);
const job=detail.latestValidationRun??(await call('/api/v1/validation-runs',{guardrailId:copy.id},202)).value;
const validation=await until(async()=>(await call(`/api/v1/validation-runs/${job.id}`)).value,v=>['passed','failed'].includes(v.status));
assert.equal(validation.status,'passed');
assert(validation.results.every(x=>x.modelInvocations===0&&!x.actualFailure));
console.log(JSON.stringify({stage:'copy-validated',id:copy.id,cases:validation.metrics.total,validationId:validation.id}));
const publication=detail.versions.find(v=>v.sourceDraftRevision===detail.draftRevision&&v.status!=='failed')
  ??(await call(`${path}/publish`,{},202)).value;
detail=await until(async()=>(await call(path)).value,g=>g.versions.some(v=>v.version===publication.version&&v.status==='ready')&&g.activeVersion===publication.version);
const version=detail.versions.find(v=>v.version===detail.activeVersion);
assert.equal(version.artifact.compilerVersion,'tasklattice-nemo-config-v18-selected-policy-dependencies');
const after=(await call('/api/v1/guardrails/guardrail-default')).value;
assert.deepEqual(after.draftConfig,original.draftConfig);
assert.equal(after.draftRevision,original.draftRevision);assert.equal(after.activeArtifactId,original.activeArtifactId);
console.log(JSON.stringify({stage:'copy-published',id:copy.id,version:version.version,artifactId:version.artifactId,
  checksum:version.artifact.checksum,compiler:version.artifact.compilerVersion,
  originalDefaultUnchanged:true,next:'Run regress_default_runtime.mjs with GUARD_REGRESSION_DEFAULT_COPY_ID set to this id after Runner convergence.'}));
