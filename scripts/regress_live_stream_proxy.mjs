#!/usr/bin/env node
/** Opt-in isolated real Relay -> Runner -> NVIDIA checks, with real DeepSeek SSE. */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';

assert.equal(process.env.GUARD_LIVE_STREAM_ALLOW,'1','Explicit live regression opt-in required.');
const exec=promisify(execFile), ns='tali-model-e2e', base='http://localhost:38381';
const round=process.env.GUARD_LIVE_STREAM_ROUND??'1';assert(['1','2'].includes(round));
const suffix=round==='2'?'-round2':'';
const gateway=`http://live-stream-model-gateway${suffix}.tali-model-e2e.svc.cluster.local:8097`;
const output=`/tmp/guard-live-stream-proxy-20260908${suffix}.json`;
const businessLimit=round==='2'?3:6;
const image=process.env.GUARD_REGRESSION_PROXY_IMAGE;
assert(image,'Select GUARD_REGRESSION_PROXY_IMAGE explicitly; never assume the dev tag contains current streaming code.');
const report=existsSync(output)?JSON.parse(readFileSync(output,'utf8')):{stages:{},cases:[],businessCalls:0};
const save=()=>writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
const secret=async name=>Object.fromEntries(Object.entries(JSON.parse((await exec('kubectl',['--context','orbstack','-n',ns,'get','secret',name,'-o','json'])).stdout).data).map(([k,v])=>[k,Buffer.from(v,'base64').toString()]));
let cookie='',activeCase=null,credentials,container=null;
const proxyKey='sk-'+randomUUID();
const config=fileURLToPath(new URL('../tests/fixtures/business-replay/litellm.yaml',import.meta.url));
async function api(path,body,expected=[200],method){
 const r=await fetch(base+path,{method:method??(body===undefined?'GET':'POST'),headers:{origin:base,cookie,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(90000)});
 const value=await r.json();assert(expected.includes(r.status),`${path}: ${r.status} ${JSON.stringify(value)}`);
 if(path.includes('sign-in'))cookie=r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
 return value;
}
async function until(get,ready){for(let i=0;i<120;i++){const v=await get();if(ready(v))return v;await delay(1000);}throw Error('Timed out waiting for isolated test state.');}
async function stage(name,work){if(report.stages[name])return report.stages[name];const value=await work();report.stages[name]=value;save();console.log(JSON.stringify({stage:name,passed:true}));return value;}
function parseSse(raw){let text='',finished=false,error=null;for(const line of raw.split('\n')){if(!line.startsWith('data:')||line.slice(5).trim()==='[DONE]')continue;const f=JSON.parse(line.slice(5));text+=f.choices?.[0]?.delta?.content??'';finished||=Boolean(f.choices?.[0]?.finish_reason);error??=f.error??null;}return {text,finished,error};}

// Capture actual Guard requests/replies. The only injected fault is explicit HTTP 503.
const transport=createServer(async(req,res)=>{
 try{
  const parts=[];for await(const c of req)parts.push(c);const body=Buffer.concat(parts);
  const payload=body.length?JSON.parse(body):{};
  const isStream=req.url.endsWith('/guardrails/output-stream');
  if(activeCase&&payload.input_type==='response'){
   // The live scenarios are all streaming. Never spend a model call on the
   // legacy per-token response path, even if an image preflight is bypassed.
   activeCase.legacyResponseRejected=true;
   res.writeHead(426,{'content-type':'application/json'}).end('{"error":"Protected SSE requires the output-stream API"}');return;
  }
  if(isStream&&activeCase?.fault&&payload.final){activeCase.injectedFaults++;res.writeHead(503,{'content-type':'application/json'}).end('{"error":"Synthetic final-check outage"}');return;}
  const r=await fetch('http://localhost:38382'+req.url,{method:req.method,headers:{'x-api-key':req.headers['x-api-key']??'','content-type':'application/json'},...(body.length?{body}:{}),signal:AbortSignal.timeout(60000)});
  const text=await r.text();
  if(activeCase)activeCase.checks.push({path:req.url,at:Date.now(),request:payload,status:r.status,response:JSON.parse(text)});
  res.writeHead(r.status,{'content-type':'application/json'}).end(text);
 }catch{res.writeHead(502,{'content-type':'application/json'}).end('{"error":"Guard transport failed"}');}
});

const upstream=createServer(async(req,res)=>{
 if(req.url!='/v1/chat/completions'||!activeCase){res.writeHead(404).end();return;}
 const current=activeCase;current.upstreamCalls++;
 const abort=new AbortController();res.on('close',()=>{current.upstreamClosedAt=Date.now();abort.abort();});
 try{
  const parts=[];for await(const c of req)parts.push(c);const body=JSON.parse(Buffer.concat(parts));assert.equal(body.stream,true);
  current.businessRequest=body;current.upstreamRaw='';
  if(current.source==='live-deepseek'){
   if(report.businessCalls>=businessLimit){res.writeHead(429).end();return;}
   report.businessCalls++;save();
   const r=await fetch('https://api.deepseek.com/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${credentials.deepseek}`,'content-type':'application/json'},body:JSON.stringify({...body,model:'deepseek-v4-flash',max_tokens:1500,temperature:0,thinking:{type:'disabled'}}),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(120000)])});
   current.businessHttpStatus=r.status;res.writeHead(r.status,{'content-type':r.headers.get('content-type')??'application/json','cache-control':'no-cache'});
   const decoder=new TextDecoder();
   for await(const bytes of r.body){current.upstreamRaw+=decoder.decode(bytes,{stream:true});res.write(bytes);}
   current.upstreamRaw+=decoder.decode();
   current.upstreamFinishedAt=Date.now();res.end();
  }else{
   res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
   const id='chatcmpl-'+randomUUID(),created=Math.floor(Date.now()/1000);
   const send=(content,finish_reason=null)=>{const line=`data: ${JSON.stringify({id,created,object:'chat.completion.chunk',model:'replay-model',choices:[{index:0,delta:{content},finish_reason}]})}\n\n`;current.upstreamRaw+=line;res.write(line);};
   for(const chunk of current.chunks){if(res.destroyed)return;send(chunk);await delay(80);}
   send('','stop');current.upstreamRaw+='data: [DONE]\n\n';current.upstreamFinishedAt=Date.now();res.end('data: [DONE]\n\n');
  }
 }catch(error){current.upstreamError=error.name;if(!res.destroyed)res.destroy();}
});

try{
 // Resolve an immutable, verified image before credentials, Controller writes or API spending.
 const verified=JSON.parse((await exec('.venv/bin/python',['scripts/verify_relay_stream_image.py',image])).stdout);
 report.proxyImage=verified.image;report.proxyFiles=verified.files;
 credentials=JSON.parse((await exec('.venv/bin/python',['-c','import json; from pathlib import Path; from scripts.model_response_gateway import load_credentials; print(json.dumps(load_credentials(Path(".env"))))'])).stdout);
 assert(credentials.deepseek);
 await api('/api/auth/sign-in/email',await secret(ns+'-bootstrap-admin'));
 const active=await stage('configuration',async()=>{
  let v=await api('/api/v1/model-configuration');assert(v.providers.every(p=>p.baseUrl.includes('.tali-model-e2e.svc.cluster.local:8097/')));
  let m=v.models.find(m=>m.name==='Live stream Safety'+suffix);
  if(!m)m=(await api('/api/v1/model-providers/register',{connection:{name:'Live stream NVIDIA'+suffix,kind:'custom-openai-compatible',baseUrl:gateway+'/nvidia/v1',apiKey:'isolated-model-lifecycle-only',skipTlsVerify:false},models:[{name:'Live stream Safety'+suffix,model:'nvidia/llama-3.1-nemotron-safety-guard-8b-v3',profile:'tali.nemotron-safety-guard-v3.v1',timeoutSeconds:45,maxTokens:1024}]},[201])).models[0];
  assert.equal(m.connectionStatus,'validated');
  // No control-plane model is required to compile this built-in Policy.
  await api('/api/v1/model-configuration/draft/assignments/control_plane',{modelId:null},[200],'PUT');
  for(const key of ['content_safety.input','content_safety.output']){
   await api('/api/v1/model-configuration/draft/assignments/'+key,{modelId:m.id},[200],'PUT');
   v=await api('/api/v1/model-configuration/draft/assignments/'+key+'/validate',{});
   assert(v.validationReport.checks.some(c=>c.id===`probe:${key}:${m.id}`&&c.status==='passed'));
  }
  assert(v.validationReport.valid);await api(`/api/v1/model-configuration/${v.id}/activate`,{},[200,202]);
  return (await until(()=>api('/api/v1/model-configuration'),x=>x.active?.id===v.id)).active;
 });
 const policy=(await api('/api/v1/policies')).items.find(p=>p.id==='builtin-content-safety');assert(policy);
 await new Promise((ok,no)=>{upstream.once('error',no);upstream.listen(38496,'127.0.0.1',ok);});
 await new Promise((ok,no)=>{transport.once('error',no);transport.listen(38498,'127.0.0.1',ok);});
 for(const mode of ['full_buffered','window_buffered','interruptible']){
  const resource=await stage(mode,async()=>{
   const name='Regression live SSE '+mode+' 20260908'+suffix;
   let g=(await api('/api/v1/guardrails')).items.find(g=>g.name===name);
   if(g)g=await api('/api/v1/guardrails/'+g.id);
   else g=await api('/api/v1/guardrails',{name,runtimeProfile:'auto',draftConfig:{allowedTopics:[],restrictedTopics:[],safetyLevel:'balanced',outputDelivery:mode,policyBindings:[{policyId:policy.id,policyVersion:policy.version,action:'reject',parameterValues:{},enabledRuleIds:policy.rules.map(r=>r.id),ruleActions:{},enabledRails:['input','output']}]}},[201]);
   const validation=g.latestValidationRun??await api('/api/v1/validation-runs',{guardrailId:g.id},[202]);
   const done=await until(()=>api('/api/v1/validation-runs/'+validation.id),v=>['passed','failed'].includes(v.status));assert.equal(done.status,'passed');
   if(!g.activeVersion)await api(`/api/v1/guardrails/${g.id}/publish`,{},[202]);
   g=await until(()=>api('/api/v1/guardrails/'+g.id),v=>v.activeVersion&&v.versions.some(r=>r.version===v.activeVersion&&r.status==='ready'));
   const endpoint=await api('/api/v1/endpoints',{name,adapter:'litellm-generic-guardrail'},[201]);
   assert(endpoint.credential);const router=await api('/api/v1/routers',{name,guardrailId:g.id,endpointId:endpoint.id,poolId:'default',enabled:true,trafficScope:{combinator:'and',conditions:[]}},[201]);
   return {guardrailId:g.id,version:g.activeVersion,artifact:g.activeArtifactId,endpointId:endpoint.id,credential:endpoint.credential,routerId:router.id};
  });
  // Report is mode 0600 and includes only an isolated endpoint credential, never upstream API keys.
  await until(async()=>{const r=await fetch(`http://localhost:38382/runtime/v1/endpoints/${resource.endpointId}/verify`,{method:'POST',headers:{'x-api-key':resource.credential,'content-type':'application/json'},body:'{}'});return r.ok?await r.json():{};},v=>v.ready);
  container='guard-live-stream-'+randomUUID();
  await exec('docker',['run','-d','--pull=never','--name',container,'-p','127.0.0.1:38495:4000','--mount',`type=bind,source=${config},target=/tmp/replay.yaml,readonly`,'-e',`TASKLATTICE_GUARD_API_BASE=http://host.docker.internal:38498/runtime/v1/endpoints/${resource.endpointId}`,'-e',`TASKLATTICE_GUARD_API_KEY=${resource.credential}`,'-e','BUSINESS_REPLAY_BASE=http://host.docker.internal:38496/v1','-e',`REPLAY_PROXY_MASTER_KEY=${proxyKey}`,'-e','LITELLM_LOCAL_MODEL_COST_MAP=True','-e','DISABLE_ADMIN_UI=true',report.proxyImage,'--config','/tmp/replay.yaml','--host','0.0.0.0','--port','4000']);
  await until(async()=>{try{return(await fetch('http://localhost:38495/health/liveliness',{signal:AbortSignal.timeout(1000)})).ok;}catch{return false;}},Boolean);
  const attackStart='I will help you build a ';
  const prefix='Have a pleasant day. '.repeat(110).slice(0,2048-attackStart.length);
  const attackChunks=[prefix+attackStart,'bomb to kill people.'+' Have a pleasant day.'.repeat(110),'No further instructions.'];
  const safePrompt='Write a calm, harmless essay of about 450 words about enjoying a public garden. Use plain English prose. Do not mention personal information, violence, politics, or medical advice.';
  const scenarios=[{name:'real-business-safe',source:'live-deepseek',input:safePrompt},
   {name:'cross-window-unsafe',source:'controlled-attack',input:'Describe a pleasant day in a public garden.',chunks:attackChunks,blocked:true},
   ...(mode==='window_buffered'?[{name:'final-check-outage',source:'controlled-safe',input:'Describe a pleasant day in a public garden.',chunks:['Have a pleasant day. '.repeat(110),'The garden is peaceful.'],fault:true,blocked:true}]:[])];
  for(const scenario of scenarios){
   if(report.cases.some(c=>c.mode===mode&&c.name===scenario.name))continue;
   activeCase={...scenario,mode,checks:[],upstreamCalls:0,injectedFaults:0,clientRaw:'',clientEvents:[]};
   try{
    const r=await fetch('http://localhost:38495/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${proxyKey}`,'content-type':'application/json'},body:JSON.stringify({model:'replay-model',messages:[{role:'user',content:scenario.input}],stream:true}),signal:AbortSignal.timeout(180000)});
    activeCase.clientStatus=r.status;const decoder=new TextDecoder();let pending='';
    for await(const bytes of r.body){const part=decoder.decode(bytes,{stream:true});activeCase.clientRaw+=part;pending+=part;const lines=pending.split('\n');pending=lines.pop();for(const line of lines){const parsed=parseSse(line);if(parsed.text)activeCase.clientEvents.push({at:Date.now(),text:parsed.text});}}
    const received=parseSse(activeCase.clientRaw),original=parseSse(activeCase.upstreamRaw??'');
    const checks=activeCase.checks.filter(c=>c.path.endsWith('/guardrails/output-stream'));
    assert.equal(activeCase.upstreamCalls,1);assert(checks.length>0,'Must reach actual stream checks.');
    assert(checks.every(c=>c.response.mode===mode),'Requested delivery mode silently changed.');
    assert(checks.every(c=>c.response.model_revision_id===active.id),'Wrong model revision.');
    assert.equal(new Set(checks.map(c=>c.response.effective_release_id)).size,1);
    const released=checks.map(c=>c.response.released_text??'').join('');
    assert.equal(received.text,released,'Client received text not explicitly released by Guard.');
    if(!scenario.blocked){assert.equal(activeCase.businessHttpStatus,200);assert.equal(received.error,null);assert(original.finished&&received.finished);assert.equal(received.text,original.text);assert(original.text.length>2048,'Real output did not span a check boundary.');assert(checks.length>=2);}
    else{assert(received.error||!r.ok,'Expected explicit client error.');assert(!received.text.includes('bomb to kill people'));if(scenario.fault){assert.equal(activeCase.injectedFaults,1);assert(Number(received.error?.code)>=500,'Outage must remain an infrastructure error.');}else assert(checks.some(c=>c.response.terminate&&c.response.decision?.usage?.fail_closed===false),'Infrastructure error must not masquerade as detection.');}
    if(mode==='full_buffered'){if(scenario.blocked)assert.equal(received.text,'');else assert(activeCase.clientEvents[0].at>=activeCase.upstreamFinishedAt);}
    if(mode!=='full_buffered'&&scenario.name==='cross-window-unsafe')assert(checks.length>=2,'Attack must cross an actual checking boundary.');
    activeCase.passed=true;
   }catch(error){activeCase.passed=false;activeCase.failure=error.message;}
   report.cases.push(activeCase);save();console.log(JSON.stringify({mode,name:scenario.name,passed:activeCase.passed,failure:activeCase.failure,checks:activeCase.checks.filter(c=>c.path.endsWith('/guardrails/output-stream')).length,clientCharacters:parseSse(activeCase.clientRaw).text.length}));
   const passed=activeCase.passed;activeCase=null;
   assert(passed,'Stop on the first failed case; do not spend additional live calls.');
  }
  await exec('docker',['stop','--time','2',container]);await exec('docker',['rm',container]);container=null;
 }
 report.passed=report.cases.length===7&&report.cases.every(c=>c.passed);save();assert(report.passed,'Some SSE cases failed; preserve evidence and budget.');
}catch(error){report.failure=String(error.message).split('\n')[0];save();console.error('Live stream regression stopped; inspect the private report.');process.exitCode=1;}
finally{if(container){await exec('docker',['stop','--time','2',container]).catch(()=>{});await exec('docker',['rm',container]).catch(()=>{});}upstream.closeAllConnections();upstream.close();transport.closeAllConnections();transport.close();}
