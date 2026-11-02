// Runs only in the disposable *-report-bench namespace. See docs/report-memory.md.
// Output contains counters, timings and sizes, never credentials or report bodies.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(`${process.cwd()}/package.json`);
const { Pool } = require('pg'), grpc = require('@grpc/grpc-js'), { loadSync } = require('@grpc/proto-loader');
const { loadConfig } = await import(`${process.cwd()}/dist-server/server/config.js`);
const config = loadConfig(), host = process.env.GUARD_BENCH_HOST;
if (!host?.includes('report-bench') || !new URL(config.databaseUrl).hostname.includes('report-bench')) throw new Error('An isolated report-bench deployment is required.');
const reports = Number(process.env.GUARD_BENCH_REPORTS ?? 2000), cases = Number(process.env.GUARD_BENCH_CASES ?? 800);
const seconds = Number(process.env.GUARD_BENCH_SECONDS ?? 90), chunkDelay = Number(process.env.GUARD_BENCH_UPLOAD_DELAY_MS ?? 0);
const evidence = (writer, ordinal) => Array.from({length:48},(_,n)=>hash(`${writer}:${ordinal}:${n}`)).join('').repeat(13);
if (![reports, cases, seconds].every(n => Number.isInteger(n) && n > 0) || reports > 2000 || cases > 1000) throw new Error('Invalid benchmark dimensions');
const pool = new Pool({ connectionString: config.databaseUrl, max: 2, application_name: 'report-memory-benchmark' });
const json = value => JSON.stringify(value), hash = value => createHash('sha256').update(value).digest('hex');
const out = value => console.log(json(value));
const versions = Math.ceil(reports / 4), base = `http://${host}:8080`;
let cookie;
async function request(path, init = {}) {
  return fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', origin: config.publicUrl, ...(cookie ? {cookie} : {}), ...init.headers }, signal: AbortSignal.timeout(60000) });
}
async function seed() {
  await pool.query("DELETE FROM guardrail_validation_run WHERE id LIKE 'memory-bench-%' AND (status='running' OR id LIKE 'memory-bench-upload-%')");
  const existing = await pool.query("SELECT id,(metrics->>'total')::int cases FROM guardrail_validation_run WHERE id LIKE 'memory-bench-%'");
  if (existing.rows.some(row => row.cases !== cases)) throw new Error('Benchmark fixtures use a different case count');
  const completed = new Set(existing.rows.map(row => row.id));
  let done = completed.size;
  if (done) out({phase:'seed_resumed',reports:done});
  for (let guard = 0; guard < 2; guard++) {
    await pool.query("INSERT INTO guardrail(id,name,draft_config) VALUES($1,$2,'{}') ON CONFLICT DO NOTHING", [`memory-bench-guard-${guard}`, `Synthetic memory fixture ${guard}`]);
    await pool.query("INSERT INTO guardrail_version(guardrail_id,version,generation,status,runtime_profile,plan,released_at) SELECT $1,'bench-'||v,$3::int+v,'pending','auto','{}'::jsonb,NULL FROM generate_series(0,$2::int-1) v ON CONFLICT DO NOTHING", [`memory-bench-guard-${guard}`, versions, 100000 + guard * versions]);
  }
  // ~40 KiB expanded evidence per case, with ~3 KiB unique hex material repeated
  // thirteen times. Each report receives distinct evidence, not an all-zero fixture.
  await Promise.all([0,1].map(async worker => {
  for (let n = worker; n < reports; n += 2) {
    const id = `memory-bench-${n}`;
    if (completed.has(id)) continue;
    await pool.query("INSERT INTO guardrail_validation_run(id,guardrail_id,guardrail_version,source_draft_revision,status,subject,metrics) VALUES($1,$2,$3,1,'running','version',$4)",
      [id, `memory-bench-guard-${n % 2}`, `bench-${Math.floor(n / 4)}`, json({ total: cases, passed: cases, complianceRate: 1 })]);
    await pool.query(`WITH source AS (
      SELECT n,jsonb_build_object('caseId','case-'||n,'name','Synthetic case '||n,'passed',true,
        'outputContent',repeat((SELECT string_agg(md5($1||':'||n||':'||k),'') FROM generate_series(1,96) k),13),'trace',jsonb_build_array(jsonb_build_object('name','synthetic','detail','evidence retained'))) detail
      FROM generate_series(0,$2::int-1) n),
      bodies AS (INSERT INTO validation_report_detail(id,owner_id,body,bytes) SELECT $1||'/'||n,$1,detail,octet_length(detail::text) FROM source)
      INSERT INTO validation_report_case(run_id,ordinal,case_id,status,priority,summary,detail_id,detail_bytes)
      SELECT $1,n,'case-'||n,'passed',2,jsonb_build_object('caseId','case-'||n,'name','Synthetic case '||n,'passed',true,'traceCount',1),$1||'/'||n,octet_length(detail::text) FROM source`,[id,cases]);
    await pool.query("UPDATE guardrail_validation_run SET status='passed',completed_at=now() WHERE id=$1", [id]);
    if (++done % 100 === 0) out({phase:'seed', reports:done});
  }
  }));
  const actual = await pool.query("SELECT count(*)::int n FROM guardrail_validation_run WHERE id LIKE 'memory-bench-%'");
  if (actual.rows[0].n !== reports) throw new Error('Incomplete saved seed reports');
  await pool.query('ANALYZE validation_report_case; ANALYZE validation_report_detail; ANALYZE guardrail_validation_run');
  const {rows:[size]} = await pool.query("SELECT pg_database_size(current_database())::float8 database_bytes, (pg_total_relation_size('validation_report_case')+pg_total_relation_size('validation_report_detail'))::float8 case_table_bytes");
  const {rows:[sample]} = await pool.query("SELECT sum(bytes)::float8 expanded_report_bytes, sum(pg_column_size(body))::float8 stored_report_bytes FROM validation_report_detail WHERE owner_id='memory-bench-0'");
  return {...size,...sample};
}
const definition = loadSync(config.protoPath, {longs:String,enums:String,defaults:true,oneofs:true});
const descriptor = grpc.loadPackageDefinition(definition).tasklattice.guard.control.v1;
const codec = definition['tasklattice.guard.control.v1.ValidationResult'];
async function writer(index, saved) {
  const bootId = randomUUID();
  const id = index===1 ? `policy-job-memory-bench-upload-${index}` : `memory-bench-upload-${index}`, runnerId = `memory-bench-writer-${index}-0`;
  if(index===1){
    const parent='policy-report-memory-bench-upload',policy='policy-memory-bench';
    await pool.query("DELETE FROM policy_resource_validation WHERE policy_id=$1",[policy]);
    await pool.query("INSERT INTO policy_resource(id,definition,maintainer) VALUES($1,'{}','benchmark') ON CONFLICT DO NOTHING",[policy]);
    const tests=Array.from({length:cases},(_,n)=>({id:`case-${n}`,name:`Synthetic case ${n}`,phase:'input',kind:'scenario',required:true,expected_decision:'block',covered_rule_ids:[]}));
    await pool.query("INSERT INTO policy_resource_validation(id,policy_id,revision,status,tests) VALUES($1,$2,1,'running',$3)",[parent,policy,json(tests)]);
    await pool.query("INSERT INTO policy_resource_validation(id,parent_id,policy_id,revision,status,tests) VALUES($1,$2,$3,1,'running',$4)",[id,parent,policy,json(tests)]);
  } else await pool.query("INSERT INTO guardrail_validation_run(id,guardrail_id,guardrail_version,source_draft_revision,status,subject,metrics) VALUES($1,$2,'bench-0',1,'running','version',$3)",
    [id,`memory-bench-guard-${index}`,json({total:cases,passed:0})]);
  const credentials = grpc.credentials.createSsl(readFileSync('/var/run/tasklattice/bench-tls/ca.crt'), readFileSync('/var/run/tasklattice/bench-tls/runner.key'), readFileSync('/var/run/tasklattice/bench-tls/runner.crt'));
  const client = new descriptor.RunnerControl(`${host}:9090`, credentials, {'grpc.max_receive_message_length':16*1024*1024});
  const metadata = new grpc.Metadata(); metadata.set('authorization',`Bearer ${config.runnerToken}`);
  const stream = client.Connect(metadata), waiters = new Map();
  let streamError;
  stream.on('error', error => {if(error.code !== grpc.status.CANCELLED) out({phase:'transport_error',code:error.code,reason:String(error.details).replace(/Bearer [^ ]+/g,'Bearer [redacted]').slice(0,300)});streamError = error; for (const w of waiters.values()) w.reject(Object.assign(new Error(`gRPC status ${error.code}`),{code:error.code}));});
  stream.on('data', message => {
    if (message.registrationAccepted) waiters.get('registration')?.resolve();
    if (message.validationReportChunkAck) {
      const ack = message.validationReportChunkAck, waiter = waiters.get(ack.sequence);
      if (ack.rejectionCode) waiter?.reject(new Error('Permanent report rejection')); else waiter?.resolve();
    }
  });
  async function send(key, message) {
    if (streamError) throw new Error('Report stream disconnected');
    const d = Promise.withResolvers(); waiters.set(key,d);
    const timer = setTimeout(() => d.reject(new Error('Report ACK timeout')),60000);
    try {stream.write(message); await d.promise;} finally {clearTimeout(timer); waiters.delete(key);}
  }
  let heartbeat, heartbeatSequence = 0;
  try {
    await send('registration',{registration:{runnerId,bootId,poolId:'default',compilerCapable:true,runnerVersion:'memory-benchmark',maxConcurrency:1}});
    heartbeat=setInterval(()=>stream.write({heartbeat:{runnerId,bootId,sequence:++heartbeatSequence,load:{maxConcurrency:1}}}),5000);
    const chunks=[], uploadId=randomUUID();
    for(let offset=0;offset<cases;offset+=20){
      const results=Array.from({length:Math.min(20,cases-offset)},(_,j)=>({caseId:`case-${offset+j}`,name:`Synthetic case ${offset+j}`,passed:false,
        expectedDecision:'VALIDATION_DECISION_BLOCK',actualDecision:'VALIDATION_DECISION_ALLOW',action:'ENFORCEMENT_ACTION_ALLOW',
        reason:'Expected synthetic mismatch',outputContent:evidence(index,offset+j)}));
      const bytes=codec.serialize({runnerId,runId:id,accepted:true,results});chunks.push({bytes,digest:hash(bytes),offset});
    }
    const bytes=codec.serialize({runnerId,runId:id,accepted:true,status:'VALIDATION_STATUS_FAILED',metrics:{total:cases,passed:0},reason:'Synthetic expected failure'});
    chunks.push({bytes,digest:hash(bytes),offset:cases});
    const manifest=hash(chunks.map(c=>c.digest).join('\n')), started=performance.now();
    for(let sequence=0;sequence<chunks.length;sequence++){
      const c=chunks[sequence];
      await send(sequence,{validationReportChunk:{runnerId,runId:id,uploadId,manifestDigest:manifest,sequence,chunks:chunks.length,cases,
        caseOffset:c.offset,rawSizeBytes:c.bytes.length,sha256:c.digest,gzipResult:gzipSync(c.bytes,{level:1}),final:sequence===chunks.length-1}});
      if(sequence===0) await send(sequence,{validationReportChunk:{runnerId,runId:id,uploadId,manifestDigest:manifest,sequence,chunks:chunks.length,cases,
        caseOffset:c.offset,rawSizeBytes:c.bytes.length,sha256:c.digest,gzipResult:gzipSync(c.bytes,{level:1}),final:false}});
      if(chunkDelay) await delay(chunkDelay); // Optional sustained-overlap scenario; zero is a burst.
    }
    const {rows:[verified]}=await pool.query('SELECT r.status,count(c.*)::int cases FROM validation_report_state r JOIN validation_report_case c ON c.run_id=r.id WHERE r.id=$1 GROUP BY r.status',[id]);
    if(verified?.status!=='failed'||verified.cases!==cases)throw new Error('Incomplete saved report');
    const response=await request(`/api/v1/test-runs/${id}/cases/0`), detail=await response.json();
    if(!response.ok || detail.outputContent!==evidence(index,0))throw new Error('Saved evidence mismatch');
    saved.push({kind:index===1?'policy':'guardrail',cases:verified.cases,duration_ms:Math.round(performance.now()-started)});
  } finally {clearInterval(heartbeat);stream.cancel();client.close();}
}
try {
  const size=await seed();
  const login=await request('/api/auth/sign-in/username',{method:'POST',body:json(config.bootstrapUser)});
  if(!login.ok)throw new Error(`Login status ${login.status}`);
  cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; '); await login.arrayBuffer();
  await delay(10000); // Let seed WAL/maintenance settle before measuring workload.
  out({phase:'load_start',reports,cases,...size});
  const start=performance.now(), deadline=start+seconds*1000, latencies=[], statuses={}, saved=[], bytes=[];
  const readers=Array.from({length:20},async(_,reader)=>{
    let page=0;
    while(performance.now()<deadline){
      const id=`memory-bench-${(reader*97+page)%reports}`, began=performance.now();
      const suffix=page%4===0?'/cases/0':'/cases?limit=50';
      const response=await request(`/api/v1/test-runs/${id}${suffix}`), body=await response.arrayBuffer();
      statuses[response.status]=(statuses[response.status]??0)+1;
      if(response.status!==200 && response.status!==429)throw new Error(`Read status ${response.status}`);
      if(response.ok){const value=JSON.parse(Buffer.from(body).toString());if(suffix.startsWith('/cases?') && (value.items.length!==50||value.counts.all!==cases))throw new Error('Page count mismatch');latencies.push(performance.now()-began);bytes.push(body.byteLength);}
      else await delay(2000);
      page++; await delay(20);
    }
  });
  const poolPressure=[];
  const metrics=async()=>{while(performance.now()<deadline){
    const response=await request('/metrics',{headers:config.metricsToken?{authorization:`Bearer ${config.metricsToken}`}:{}});
    if(response.ok){const text=await response.text();poolPressure.push({waiting:Number(/^guard_controller_database_pool_waiting (\d+)/m.exec(text)?.[1]??0),busy:Number(/guard_controller_database_pool_connections\{state="busy"\} (\d+)/.exec(text)?.[1]??0)});}else await response.arrayBuffer();
    await delay(1000);
  }};
  await Promise.all([...readers,writer(0,saved),writer(1,saved),metrics()]);
  latencies.sort((a,b)=>a-b);bytes.sort((a,b)=>a-b);
  const {rows:[counts]}=await pool.query(`SELECT
    (SELECT count(*) FROM guardrail_validation_run WHERE id LIKE 'memory-bench-%')::int guardrail_reports,
    (SELECT count(*) FROM policy_resource_validation WHERE id LIKE 'policy-report-memory-bench-%')::int policy_reports,
    (SELECT count(*) FROM validation_report_detail)::int physical_case_bodies,
    (SELECT count(*) FROM validation_report_case)::int case_index_rows`);
  const result={phase:'complete',reports,cases,readers:20,writers:2,upload_delay_ms:chunkDelay,elapsed_ms:Math.round(performance.now()-start),...size,statuses,
    read_p50_ms:Math.round(latencies[Math.floor(latencies.length*.5)]),read_p95_ms:Math.round(latencies[Math.floor(latencies.length*.95)]),response_max_bytes:bytes.at(-1),saved,retained:counts,pool_waiting_peak:Math.max(0,...poolPressure.map(x=>x.waiting)),pool_busy_peak:Math.max(0,...poolPressure.map(x=>x.busy))};
  writeFileSync('/tmp/report-memory-result.json',json(result));out(result);
} catch(error){out({phase:'failed',code:error.code??null,constraint:error.constraint??null,error_type:error.name,location:error.stack?.split('\n').find(line=>line.includes('report-memory-benchmark.mjs'))?.replace(/.*report-memory-benchmark.mjs:/,'benchmark:'),message:/^(gRPC status|Read status|Login status|Page count|Report ACK|Incomplete saved|Saved evidence|Permanent report|Report stream|Benchmark fixtures)/.test(error.message)?error.message:'Benchmark failed; inspect sanitized diagnostics'});process.exitCode=1;}
finally {await pool.end();}
