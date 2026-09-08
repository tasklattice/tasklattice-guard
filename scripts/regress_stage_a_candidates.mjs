#!/usr/bin/env node
/** Approved A-stage local cases against explicitly pinned existing releases.
 * No publish/configuration changes, compiler or model calls. Runtime telemetry
 * is created. Print identities and failures, never cookies or original content.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

const required = key => { assert(process.env[key], `Set ${key}`); return process.env[key]; };
assert.equal(required('GUARD_STAGE_A_APPROVED'), '1');
const controller = new URL(required('GUARD_REGRESSION_CONTROLLER_URL'));
const runner = new URL(required('GUARD_REGRESSION_RUNNER_URL'));
for (const u of [controller, runner]) assert(['localhost','127.0.0.1','[::1]'].includes(u.hostname));
const origin = required('GUARD_REGRESSION_ORIGIN');
const ids = JSON.parse(required('GUARD_STAGE_A_GUARDRAIL_IDS'));
const raw = await readFile(new URL('../tests/fixtures/acceptance/protection-review-v1.json', import.meta.url));
const corpus = JSON.parse(raw);
assert.equal(corpus.external_api_request_budget, 0);
let cookie = '';
async function call(base, path, body) {
  const r = await fetch(new URL(path, base), {method:body === undefined ? 'GET':'POST',
    headers:{'content-type':'application/json',origin,
      ...(base === controller ? {cookie}:{authorization:`Bearer ${required('GUARD_REGRESSION_RUNNER_TOKEN')}`})},
    ...(body === undefined ? {}:{body:JSON.stringify(body)}), signal:AbortSignal.timeout(30_000)});
  assert(r.ok, `${path}: HTTP ${r.status}`);
  return {value:await r.json(), response:r};
}
const login = await call(controller, '/api/auth/sign-in/email', {
  email:required('GUARD_REGRESSION_EMAIL'), password:required('GUARD_REGRESSION_PASSWORD')});
cookie = login.response.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
assert(cookie);
const ready = (await call(runner, '/health/ready')).value;
assert(ready.ready && ready.controller_connected && ready.desired_state_synchronized);
const releases = {};
for (const preset of [...new Set(Object.values(corpus.preset_groups).flat())]) {
  assert(ids[preset], `Pin ${preset}`);
  const g = (await call(controller, `/api/v1/guardrails/${ids[preset]}`)).value;
  const v = g.versions.find(x=>x.version===g.activeVersion);
  assert(v?.status==='ready' && v.artifact?.signature && v.artifactId===g.activeArtifactId);
  assert.equal(v.sourceDraftRevision,g.draftRevision);
  assert.equal(g.draftConfig.outputDelivery,'full_buffered');
  assert.deepEqual(g.excludedTestCaseIds,[]);
  assert.deepEqual(v.plan.policy_bindings.map(x=>[x.policy_id,x.policy_version]),
    g.draftConfig.policyBindings.map(x=>[x.policyId,x.policyVersion]));
  // Refuse any model-backed execution plan before issuing even the first case.
  // Artifacts with arbitrary Colang/custom actions need a separate audit.
  assert.equal(v.artifact.runtimeProfile,'llmrails_colang1_standard');
  assert(v.artifact.dependencyManifest.every(x=>x[0]==='action' && x[1]==='GuardContentFilterAction'),
    'Only the reviewed local content-filter action is allowed in this no-model replay');
  releases[preset]={id:g.id,version:v.version,draftRevision:g.draftRevision,
    artifactId:v.artifactId,checksum:v.artifact.checksum,compiler:v.artifact.compilerVersion,
    policyBindings:v.plan.policy_bindings.map(x=>[x.policy_id,x.policy_version]),
    steps:v.plan.steps,modelRevision:null,runtimeChecksums:new Set(),effectiveReleases:new Set()};
}
// Exact outputs are frozen from the selected policy contracts, before calls.
// Default's legacy passport implementation redacts the number only; focused
// local-passports removes the label and number. Neither expected string is
// learned from the runtime response.
const exactOutputs = {
  'C02-risk':Object.fromEntries(Object.keys(releases).map(p=>[p,p==='default'
    ? '测试客户资料，护照号码：[passport_china_REDACTED]。':'测试客户资料，[REDACTED]。'])),
  'C03-risk':Object.fromEntries(Object.keys(releases).map(p=>[p,'My test email is [email_REDACTED].'])),
};
for (const r of Object.values(releases)) {
  for (const step of r.steps) {
    assert.equal(step.capability,'builtin_content_filter', 'Only local filter steps are allowed');
  }
}
console.log(JSON.stringify({stage:'frozen',corpusSha256:createHash('sha256').update(raw).digest('hex'),
  exactOutputs, releases:Object.fromEntries(Object.entries(releases).map(([p,r])=>[p,{...r,steps:undefined,
    runtimeChecksums:undefined,effectiveReleases:undefined}]))}));
const runId=`stage-a-${randomUUID()}`, rows=[];
for (const c of corpus.cases) for (const preset of corpus.preset_groups[c.group]) for (const phase of corpus.default_phases) {
  const r=releases[preset], errors=[];
  let result;
  try {
    result=(await call(runner,`/internal/v1/guardrails/${r.id}/evaluate`,{
      guardrail_version:r.version,phase,texts:[c.content],call_id:`${runId}:${c.id}:${preset}:${phase}`})).value;
    if(result.guardrail_version!==r.version) errors.push('version_drift');
    if(result.usage?.model_invocations!==0) throw Error('Unexpected model invocation; stopping the run');
    if(result.usage?.fail_closed!==false) errors.push('execution_failure');
    if(result.decision!==c.expected) errors.push('decision_mismatch');
    const text=(result.texts??[]).join('');
    if(c.expected==='allow' && text && text!==c.content) errors.push('allow_text_changed');
    if(c.expected==='transform') {
      if(text!==exactOutputs[c.id]?.[preset]) errors.push('exact_output_mismatch');
      if(c.sensitive_literals.some(x=>text.includes(x))) errors.push('sensitive_value_leaked');
    }
    // Internal evaluate returns diagnostic texts even for block. Final-client
    // no-body semantics are asserted separately through the real proxy.
    if(c.expected!=='allow' && !(result.findings??[]).some(x=>x.verdict==='unsafe')) errors.push('missing_detection_evidence');
    r.runtimeChecksums.add(result.usage?.config_checksum);
    r.effectiveReleases.add(result.effective_release_id);
    rows.push({id:c.id,preset,phase,expected:c.expected,actual:result.decision,passed:errors.length===0,errors,
      matches:(result.findings??[]).filter(x=>x.verdict==='unsafe').map(x=>({policy:x.policy_id,rule:x.rule_id}))});
  } catch(error) { console.log(JSON.stringify({stage:'stopped',caseId:c.id,preset,phase,reason:error.message}));throw error; }
}
const identityFailures=[];
for(const [preset,r] of Object.entries(releases)) {
  const g=(await call(controller,`/api/v1/guardrails/${r.id}`)).value;
  assert.equal(g.activeArtifactId,r.artifactId,'Release changed during acceptance');
  assert.equal(g.draftRevision,r.draftRevision,'Draft changed during acceptance');
  if(r.runtimeChecksums.size!==1 || r.effectiveReleases.size!==1) identityFailures.push(preset);
  assert.match([...r.runtimeChecksums][0],/^[a-f0-9]{64}$/);
}
console.log(JSON.stringify({stage:'completed',runId,total:rows.length,passed:rows.filter(x=>x.passed).length,
  failed:rows.filter(x=>!x.passed),identityFailures,modelInvocations:0,scope:'pinned existing HTTP releases; not newly compiled release convergence or streaming',
  identities:Object.fromEntries(Object.entries(releases).map(([p,r])=>[p,{artifactId:r.artifactId,
    runtimeConfigChecksum:[...r.runtimeChecksums][0],effectiveReleaseId:[...r.effectiveReleases][0]}]))}));
process.exitCode=rows.every(x=>x.passed)&&identityFailures.length===0?0:1;
