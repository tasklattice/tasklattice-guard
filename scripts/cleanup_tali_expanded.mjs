// Soft-delete only resources recorded by this completed regression; retain audit.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
const base='http://localhost:38081';let cookie='';
async function api(path,method='GET',body){
 const r=await fetch(base+path,{method,headers:{origin:base,cookie,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 if(path.includes('sign-in'))cookie=r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
 assert(r.ok,`${path}: ${r.status}`);return r.status===204?null:r.json();
}
const auth=JSON.parse(execFileSync('kubectl',['--context','orbstack','-n','tali','get','secret','tali-guard-bootstrap-admin','-o','json'],{encoding:'utf8'}));
await api('/api/auth/sign-in/email','POST',Object.fromEntries(Object.entries(auth.data).map(([k,v])=>[k,Buffer.from(v,'base64').toString()])));
const result={softDeleted:[]};
const n=JSON.parse(readFileSync('/tmp/guard-tali-expanded-lifecycle-20260908.json'));
const c=JSON.parse(readFileSync('/tmp/guard-tali-expanded-control-20260908.json'));
assert(n.passed&&c.passed);
for(const [type,id,name] of [
 ['deployments',n.deployment.id,n.name],['integrations',n.integration.id,n.name],['guardrails',n.guardrail.id,n.name],['guardrails',c.guardrailId,c.name],
]){
 assert(name.startsWith('Regression ')&&name.includes('expanded 20260908'));
 const path='/api/v1/'+type+'/'+id;
 const entity=await api(path);assert.equal(entity.name,name);
 const impact=await api(path+'/deletion-impact');
 await api(path,'DELETE',{reason:'Completed authorized expanded regression; retain audit history.',confirmRecentTraffic:true,confirmationName:name});
 result.softDeleted.push({type,id,name});
}
result.modelConfiguration=await api('/api/v1/model-configuration');
assert.equal(result.modelConfiguration.active.id,'494e5fe1-132a-4b10-bc46-2295b0a881fa');
delete result.modelConfiguration;
result.completedAt=new Date().toISOString();
writeFileSync('/tmp/guard-tali-expanded-cleanup-20260908.json',JSON.stringify(result,null,2),{mode:0o600});
console.log(JSON.stringify(result));
