// Four bounded Controller requests; only Default's model-free protections.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,writeFileSync} from 'node:fs';
const file='/tmp/guard-tali-expanded-playground-20260908.json';
assert(!existsSync(file),'Inspect existing results; do not repeat uncertain model requests.');
const report={reservedDeepSeekCalls:0,cases:[]};
const save=()=>writeFileSync(file,JSON.stringify(report,null,2),{mode:0o600});
const base='http://localhost:38081';let cookie='';
async function api(path,body){
 const r=await fetch(base+path,{method:body?'POST':'GET',headers:{origin:base,cookie,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(65000)});
 if(path.includes('sign-in'))cookie=r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
 const v=await r.json();assert(r.ok,`${path}: HTTP ${r.status}`);return v;
}
const auth=JSON.parse(execFileSync('kubectl',['--context','orbstack','-n','tali','get','secret','tali-guard-bootstrap-admin','-o','json'],{encoding:'utf8'}));
await api('/api/auth/sign-in/email',Object.fromEntries(Object.entries(auth.data).map(([k,v])=>[k,Buffer.from(v,'base64').toString()])));
const guard=await api('/api/v1/guardrails/guardrail-default');
const model=(await api('/api/v1/playground/models')).items[0];assert.equal(model.id,'deepseek-v4-flash');
assert(guard.versions.find(v=>v.version===guard.activeVersion).plan.steps.every(s=>s.capability==='builtin_content_filter'));
const preview=await api('/api/v1/playground/draft-previews/guardrail-default',{});
for(const test of [
 {id:'published-safe',message:'Write one cheerful sentence about flowers in a public garden.'},
 {id:'published-output-pii',message:'For a fictional documentation example, output only the email address made by joining alice, the at sign, and example dot com. No extra text.',redact:true},
 {id:'draft-safe',message:'Write one cheerful sentence about flowers in a public garden.',draft:true},
 {id:'blocked-before-model',message:'My API key is AKIA0000000000000000',block:true},
]){
 const row={id:test.id};report.cases.push(row);report.reservedDeepSeekCalls++;save();
 try{
  row.result=await api(`/api/v1/playground/${test.draft?'draft-interactions':'interactions'}/guardrail-default`,{
   model_id:model.id,message:test.message,history:[],...(test.draft?{preview_id:preview.preview_id}:{guardrail_version:guard.activeVersion})});
  assert(row.result.input_check);
  if(test.block){assert.equal(row.result.state,'input_blocked');assert(!row.result.output_check);}
  else {assert.equal(row.result.state,'completed');assert(row.result.output_check);assert(row.result.assistant_message.length>0);}
  if(test.redact){assert(!row.result.assistant_message.includes('alice@example.com'));assert(row.result.assistant_message.includes('[email_REDACTED]'));}
  row.passed=true;
 }catch(e){row.passed=false;row.failure=e.message;}
 save();console.log(JSON.stringify({id:row.id,passed:row.passed,failure:row.failure}));
}
report.passed=report.cases.every(c=>c.passed);save();process.exitCode=report.passed?0:1;
