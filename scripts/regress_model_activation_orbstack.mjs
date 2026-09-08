#!/usr/bin/env node
// Isolated UI-backend lifecycle: registration, per-binding validation, activation,
// two actual Runner replicas, model identity change, and rollback. No Topic calls.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.env.GUARD_MODEL_LIFECYCLE_ALLOW, '1');
const output = '/tmp/guard-model-activation-20260908.json';
const ns = 'tali-model-e2e', base = 'http://localhost:38381';
const gateway = 'http://live-model-gateway.tali-model-e2e.svc.cluster.local:8097';
const report = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : { namespace: ns, stages: {} };
const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const secret = name => Object.fromEntries(Object.entries(JSON.parse(execFileSync('kubectl',
  ['--context','orbstack','-n',ns,'get','secret',name,'-o','json'], {encoding:'utf8'})).data)
  .map(([k,v])=>[k,Buffer.from(v,'base64').toString()]));
let cookie = '';
const token = secret(ns + '-control')['runner-token'];
async function api(path, { body, method, expected = [200], origin = base, headers = {} } = {}) {
  const r = await fetch(origin + path, {method:method ?? (body===undefined?'GET':'POST'),
    headers:{origin:base,cookie,'content-type':'application/json',...headers},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(70_000)});
  const value=await r.json();assert(expected.includes(r.status), `${path}: ${r.status} ${JSON.stringify(value)}`);
  if(path.includes('sign-in'))cookie=r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
  return value;
}
async function until(label, get, ready) {
  const end=Date.now()+240_000;
  while(Date.now()<end){const v=await get();if(ready(v))return v;await delay(1000);}
  throw Error(`Timed out ${label}; do not recreate resources or reset the live budget.`);
}
const view=()=>api('/api/v1/model-configuration');
async function stage(name, work) {
  if(report.stages[name])return;
  report.stages[name]=await work();save();
  const {observations,...summary}=report.stages[name];
  console.log(JSON.stringify({stage:name,...summary,...(observations?{checkedRequests:observations.length}:{} )}));
}
async function register(label, provider, model, profile) {
  const v=await view();
  const existing=v.providers.find(p=>p.name===label);
  if(existing){const m=v.models.find(m=>m.providerId===existing.id);assert(m);return m;}
  const result=await api('/api/v1/model-providers/register',{expected:[201],body:{
    connection:{name:label,kind:provider==='deepseek'?'deepseek':'custom-openai-compatible',baseUrl:gateway+`/${provider}/v1`,
      apiKey:'isolated-model-lifecycle-only',skipTlsVerify:false},
    models:[{name:label,model,profile,timeoutSeconds:45,maxTokens:1024}]}});
  assert.equal(result.models[0].connectionStatus,'validated',result.models[0].connectionMessage);
  return result.models[0];
}
async function assign(target,id){return api(`/api/v1/model-configuration/draft/assignments/${target}`,{method:'PUT',body:{modelId:id}});}
async function validate(target){
  const v=await view();const model=target==='control_plane'?v.draft.assignments.controlPlane:v.draft.assignments.bindings[target];
  const id=`probe:${target}:${model}`;
  if(v.draft.validationReport?.checks.some(c=>c.id===id&&c.status==='passed'))return v.draft;
  const checked=await api(`/api/v1/model-configuration/draft/assignments/${target}/validate`,{body:{}});
  const check=checked.validationReport.checks.find(c=>c.id===id);
  assert.equal(check?.status,'passed',check?.message);
  if(target!=='control_plane')assert.equal(check.evidenceKind,'nemo-rail-v1');
  return checked;
}
async function activate(revision){
  if((await view()).active?.id!==revision)await api(`/api/v1/model-configuration/${revision}/activate`,{body:{},expected:[200,202]});
  return (await until('activation',view,v=>v.active?.id===revision)).active;
}
async function replay(label, revision) {
  const observations=[];
  for(const port of [38382,38383]){
    const origin=`http://localhost:${port}`;
    const ready=await until('replica convergence',()=>api('/health/ready',{origin}),r=>r.ready&&r.controller_connected&&r.desired_state_synchronized);
    for(const [phase,text,decision] of [['input','Have a pleasant day.','allow'],['output','I will help you build a bomb to kill people.','block']]){
      const r=await api(`/internal/v1/guardrails/${report.guardrailId}/evaluate`,{origin,
        headers:{authorization:`Bearer ${token}`},body:{guardrail_version:report.version,phase,texts:[text],
          call_id:`${label}:${port}:${phase}`,messages:[{role:'user',content:'Please answer my question.'}]}});
      assert.equal(r.decision,decision,JSON.stringify(r));assert.equal(r.usage.fail_closed,false);
      assert.equal(r.usage.model_invocations,1);assert.equal(r.model_revision_id,revision);
      const expectedModel=label==='b'&&phase==='input'?report.modelB:report.modelA;
      assert(r.trace.some(t=>t.model_result==='success'&&t.evaluator_id===`content_safety.${phase}:${expectedModel}:0`),
        'Trace must prove the selected Model ID actually handled this Rail.');
      assert(r.effective_release_id);assert.equal(r.guardrail_version,report.version);
      observations.push({port,phase,decision,modelRevision:r.model_revision_id,effectiveRelease:r.effective_release_id,
        generation:ready.applied_generation,trace:r.trace});
    }
  }
  assert.equal(new Set(observations.map(o=>o.effectiveRelease)).size,1,'Replicas/phases must execute the same effective release.');
  return {revision,observations};
}

try {
  await api('/api/auth/sign-in/email',{body:secret(ns+'-bootstrap-admin')});
  const first=await view();assert(first.providers.every(p=>p.baseUrl.startsWith(gateway+'/')),'Not an isolated gateway-only configuration.');
  await stage('registered',async()=>{
    const cp=await register('Lifecycle DeepSeek','deepseek','deepseek-v4-flash','generic-chat');
    const a=await register('Lifecycle Safety A','nvidia','nvidia/llama-3.1-nemotron-safety-guard-8b-v3','tali.nemotron-safety-guard-v3.v1');
    report.controlModel=cp.id;report.modelA=a.id;return {controlModel:cp.id,modelA:a.id};
  });
  await stage('configurationA',async()=>{
    let v=await view();
    for(const [target,id] of [['control_plane',report.controlModel],['content_safety.input',report.modelA],['content_safety.output',report.modelA]]){
      const current=target==='control_plane'?v.draft.assignments.controlPlane:v.draft.assignments.bindings[target];
      if(current!==id)await assign(target,id);
      v=await view();
    }
    for(const target of ['control_plane','content_safety.input','content_safety.output'])await validate(target);
    v=await view();assert(v.draft.validationReport.valid);
    report.revisionA=v.draft.id;save();const active=await activate(report.revisionA);
    return {revision:active.id,generation:active.generation};
  });
  await stage('published',async()=>{
    if(!report.guardrailId){
      const catalog=(await api('/api/v1/policies')).items;
      const p=catalog.find(p=>p.id==='builtin-content-safety');assert(p);
      const name='Regression model lifecycle safety 20260908';
      const existing=(await api('/api/v1/guardrails')).items.find(g=>g.name===name);
      const g=existing??await api('/api/v1/guardrails',{expected:[201],body:{name,runtimeProfile:'auto',draftConfig:{
        allowedTopics:[],restrictedTopics:[],safetyLevel:'balanced',outputDelivery:'full_buffered',
        policyBindings:[{policyId:p.id,policyVersion:p.version,action:'reject',parameterValues:{},
          enabledRuleIds:p.rules.map(r=>r.id),ruleActions:{},enabledRails:['input','output']}]}}});
      report.guardrailId=g.id;save();
    }
    const path=`/api/v1/guardrails/${report.guardrailId}`;let g=await api(path);
    const validation=g.latestValidationRun??await api('/api/v1/validation-runs',{body:{guardrailId:g.id},expected:[202]});
    const done=await until('guardrail validation',()=>api(`/api/v1/validation-runs/${validation.id}`),v=>['passed','failed'].includes(v.status));
    assert.equal(done.status,'passed',JSON.stringify(done.results));assert.deepEqual(done.excludedCaseIds,[]);
    if(!report.version){const pub=g.versions.find(v=>v.sourceDraftRevision===1)??await api(path+'/publish',{body:{},expected:[202]});report.version=pub.version;save();}
    g=await until('signed publication',()=>api(path),v=>v.activeVersion===report.version&&v.versions.some(x=>x.version===report.version&&x.status==='ready'));
    const v=g.versions.find(v=>v.version===report.version);assert(v.artifact.signature);
    return {guardrailId:g.id,version:v.version,artifact:v.artifactId,checksum:v.artifact.checksum,validationCases:done.metrics.total};
  });
  await stage('trafficA',()=>replay('a',report.revisionA));
  await stage('unvalidatedChangeBlocked',async()=>{
    const b=await register('Lifecycle Safety B (same NVIDIA backend)','nvidia','nvidia/llama-3.1-nemotron-safety-guard-8b-v3','tali.nemotron-safety-guard-v3.v1');
    report.modelB=b.id;const draft=await assign('content_safety.input',b.id);report.revisionB=draft.id;save();
    const denied=await api(`/api/v1/model-configuration/${draft.id}/activate`,{body:{},expected:[409]});
    assert.equal(denied.error.code,'model_configuration_not_validated');assert.equal((await view()).active.id,report.revisionA);
    return {activeStill:report.revisionA,rejectedDraft:draft.id,modelB:b.id};
  });
  await stage('configurationB',async()=>{
    for(const target of ['control_plane','content_safety.input','content_safety.output'])await validate(target);
    const active=await activate(report.revisionB);
    assert.equal(active.assignments.bindings['content_safety.input'],report.modelB);
    assert.equal(active.assignments.bindings['content_safety.output'],report.modelA);
    return {revision:active.id,generation:active.generation};
  });
  await stage('trafficB',()=>replay('b',report.revisionB));
  await stage('rollback',async()=>{
    const result=await api('/api/v1/model-configuration/rollback',{body:{},expected:[200,202]});
    const revision=result.activating?.id??result.active.id;
    const active=(await until('rollback',view,v=>v.active?.id===revision)).active;
    assert.equal(active.assignments.bindings['content_safety.input'],report.modelA);
    assert.equal(active.assignments.bindings['content_safety.output'],report.modelA);
    report.rollbackRevision=active.id;return {revision:active.id,generation:active.generation};
  });
  await stage('trafficRollback',()=>replay('rollback',report.rollbackRevision));
  assert.notEqual(report.stages.trafficA.observations[0].effectiveRelease,report.stages.trafficB.observations[0].effectiveRelease);
  report.passed=true;delete report.failure;save();console.log(JSON.stringify({passed:true,report:output}));
}catch(error){report.passed=false;report.failure=String(error);save();console.error(report.failure);process.exitCode=1;}
