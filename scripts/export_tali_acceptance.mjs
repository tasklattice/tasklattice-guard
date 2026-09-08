/** Export this bounded run's synthetic-content recordings for offline replay. */
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const report=JSON.parse(readFileSync('/tmp/guard-tali-live-acceptance-20260908.json','utf8'));
assert(report.passed&&report.businessCalls===3&&report.quality.length===16);
const raw=execFileSync('kubectl',['--context','orbstack','-n','tali','exec','deployment/live-tali-acceptance-20260908','--','python','-c',
 'import sqlite3,json; d=sqlite3.connect("/records/live.sqlite"); print(json.dumps([dict(id=i,route=r,request=json.loads(q),status=s,response=json.loads(p)) for i,r,q,s,p in d.execute("select id,route,request,status,response from calls order by id")]))'],{encoding:'utf8',maxBuffer:20_000_000});
const calls=JSON.parse(raw);
assert.equal(calls.length,32);assert(calls.every(c=>c.route==='nvidia/v1/chat/completions'));
const credentials=JSON.parse(execFileSync('.venv/bin/python',['-c','import json; from pathlib import Path; from scripts.model_response_gateway import load_credentials; print(json.dumps(load_credentials(Path(".env"))))'],{encoding:'utf8'}));
for(const value of Object.values(credentials))assert(!raw.includes(value),'Credential unexpectedly present: refuse export');
writeFileSync('tests/fixtures/model_responses/20260908-tali-acceptance.json',JSON.stringify({recorded_on:'2026-09-08',
 scope:'tali same-image frozen-artifact Runner; 16 development quality cases and 3 real DeepSeek SSE cases. Includes first transport failure, one authorized retest and Rail probes; not a production accuracy benchmark.',
 cases:calls},null,2)+'\n');
const c=report.cases.find(c=>c.name==='real-business-safe');
let text='',finish_reason=null;
for(const line of c.upstreamRaw.split('\n')){if(!line.startsWith('data:')||line.slice(5).trim()==='[DONE]')continue;const f=JSON.parse(line.slice(5));text+=f.choices?.[0]?.delta?.content??'';finish_reason=f.choices?.[0]?.finish_reason??finish_reason;}
assert.equal(finish_reason,'stop');
writeFileSync('tests/fixtures/model_responses/20260908-tali-deepseek-sse.json',JSON.stringify({source:'live-deepseek-business-sse',
 model:'deepseek-v4-flash',finish_reason,text,raw_sse:c.upstreamRaw},null,2)+'\n');
console.log(JSON.stringify({nvidiaCalls:calls.length,deepseekCalls:report.businessCalls,normalStreamCharacters:text.length}));
