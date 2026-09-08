// Actual tali Controller -> validated signed artifact -> routed main Runner.
// Gateway round is closed at 67; this stage reserves at most 6 further NVIDIA
// calls. No model reconfiguration, no Topic/Jailbreak, no retries.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
const file='/tmp/guard-tali-expanded-lifecycle-20260908.json';
const resume=process.env.GUARD_RESUME_ROUTING_PREFLIGHT==='1';
assert(resume||!existsSync(file),'Do not repeat uncertain lifecycle calls.');
const report=resume?JSON.parse(readFileSync(file,'utf8')):{name:'Regression NVIDIA full lifecycle expanded 20260908',reservedNvidiaCalls:0,checks:[]};
if(resume){
 assert.equal(report.failure,'Main Runner routing did not converge.');
 assert.equal(report.reservedNvidiaCalls,2);assert.equal(report.checks.length,0);
 report.correctedHarnessFailure=report.failure;delete report.failure;delete report.passed;
}
const save=()=>writeFileSync(file,JSON.stringify(report,null,2),{mode:0o600});
const base='http://localhost:38081';let cookie='';
async function api(path,body,method){
 const r=await fetch(base+path,{method:method??(body?'POST':'GET'),headers:{origin:base,cookie,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(65000)});
 if(path.includes('sign-in'))cookie=r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
 if(r.status===204)return null;
 const v=await r.json();assert(r.ok,`${path}: HTTP ${r.status}`);return v;
}
async function until(path,ready){for(let i=0;i<120;i++){const v=await api(path);if(ready(v))return v;await delay(1000);}throw Error('Timed out; inspect state rather than repeat writes.');}
try{
 const auth=JSON.parse(execFileSync('kubectl',['--context','orbstack','-n','tali','get','secret','tali-guard-bootstrap-admin','-o','json'],{encoding:'utf8'}));
 await api('/api/auth/sign-in/email',Object.fromEntries(Object.entries(auth.data).map(([k,v])=>[k,Buffer.from(v,'base64').toString()])));
 const before=await api('/api/v1/model-configuration');report.activeModelRevision=before.active.id;
 const policy=(await api('/api/v1/policies')).items.find(p=>p.id==='builtin-content-safety');
 assert.equal(policy.test_cases.length,2);assert(policy.test_cases.every(c=>['input','output'].includes(c.phase)));
 if(!resume){
 report.guardrail=await api('/api/v1/guardrails',{name:report.name,runtimeProfile:'auto',draftConfig:{allowedTopics:[],restrictedTopics:[],safetyLevel:'balanced',outputDelivery:'full_buffered',policyBindings:[{policyId:policy.id,policyVersion:policy.version,action:'reject',parameterValues:{},enabledRuleIds:policy.rules.map(r=>r.id),ruleActions:{},ruleOrder:[],enabledRails:['input','output']}]}});save();
 const path='/api/v1/guardrails/'+report.guardrail.id;
 report.reservedNvidiaCalls+=2;save();
 const validation=await api('/api/v1/validation-runs',{guardrailId:report.guardrail.id});report.validationId=validation.id;save();
 report.validation=await until('/api/v1/validation-runs/'+validation.id,v=>['passed','failed'].includes(v.status));save();
 assert.equal(report.validation.status,'passed');assert.equal(report.validation.results.length,2);
 assert(report.validation.results.every(c=>c.modelInvocations===1&&!c.actualFailure));
 report.publication=await api(path+'/publish',{});save();
 const guard=await until(path,g=>g.activeVersion===report.publication.version&&g.versions.some(v=>v.version===g.activeVersion&&v.status==='ready'));
 const version=guard.versions.find(v=>v.version===guard.activeVersion);assert(version.artifact.signature);
 assert(version.plan.steps.every(s=>s.capability==='content_safety'));report.artifact={id:version.artifactId,checksum:version.artifact.checksum};save();
 report.integration=await api('/api/v1/integrations',{name:report.name,adapter:'generic-http-guard'});save();
 report.deployment=await api('/api/v1/deployments',{name:report.name,guardrailId:guard.id,integrationId:report.integration.id,poolId:'default',enabled:true,trafficScope:{combinator:'and',conditions:[]}});save();
 }
 // /verify is a LiteLLM adapter endpoint, not a generic-http-guard check.
 // Require synchronized Runner state; actual evaluate calls below prove routing.
 const guard=await api('/api/v1/guardrails/'+report.guardrail.id);
 const runtime='http://localhost:38082/runtime/v1/integrations/'+report.integration.id;
 const ready=await(await fetch('http://localhost:38082/health/ready')).json();
 assert(ready.ready&&ready.desired_state_synchronized);
 const cases=policy.test_cases.map(c=>({id:c.id,phase:c.phase,content:c.content,expected:c.expected_decision}));
 cases.push(...['input','output'].map(phase=>({id:'safe-'+phase,phase,content:'Enjoy the flowers in a quiet public garden.',expected:'allow'})));
 for(const c of cases){
  assert(report.reservedNvidiaCalls<6);report.reservedNvidiaCalls++;save();
  const r=await fetch(runtime+'/guardrails/evaluate',{method:'POST',headers:{'x-api-key':report.integration.credential,'content-type':'application/json'},body:JSON.stringify({phase:c.phase,texts:[c.content],call_id:randomUUID()}),signal:AbortSignal.timeout(60000)});
  const result=await r.json();report.checks.push({id:c.id,expected:c.expected,http:r.status,result});save();
  assert(r.ok);assert.equal(result.decision,c.expected);assert.equal(result.guardrail_id,guard.id);assert.equal(result.guardrail_version,guard.activeVersion);assert.equal(result.model_revision_id,before.active.id);
  assert.equal(result.usage.model_invocations,1);assert.equal(result.usage.fail_closed,false);
  assert(result.trace.some(t=>t.capability==='content_safety'&&t.rail_type===c.phase&&t.model_result==='success'));
 }
 const after=await api('/api/v1/model-configuration');assert.deepEqual(after.active,before.active);assert.deepEqual(after.draft,before.draft);
 report.passed=true;save();console.log(JSON.stringify({passed:true,nvidiaCalls:report.reservedNvidiaCalls,guardrailId:guard.id,artifact:report.artifact,mainRoutedCases:report.checks.length}));
}catch(e){report.passed=false;report.failure=e.message;save();console.error(report.failure);process.exitCode=1;}
