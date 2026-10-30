// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "./postgres-test-database.js";
import { createPooledDatabase } from "./client.js";
import { migrateReportStorage } from "./report-storage-migration.js";
import { ReportResults } from "../services/report-results.js";

const url=process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("One-time report storage cutover",()=>{
 let database:Awaited<ReturnType<typeof createTestDatabase>>;
 afterEach(async()=>database?.drop());
 it("resumes committed checkpoints, preserves historical evidence, shares Policy bodies, and removes old columns",async()=>{
  const evidence={caseId:"case-0",name:"Historical",passed:true,actualDecision:"allow",outputContent:"private evidence ".repeat(4000),trace:[{name:"trace",detail:"preserved"}]};
  database=await createTestDatabase(url!,"report_cutover",async(tag,pool)=>{
   if(tag==="0056_unified_report_storage"){
    await pool.query("INSERT INTO guardrail(id,name,draft_config) VALUES('guard','Migration fixture','{}')");
    for(const id of ["a","b"]){
     await pool.query("INSERT INTO guardrail_validation_run(id,guardrail_id,guardrail_version,source_draft_revision,status,results,test_suite,candidate_artifact) VALUES($1,'guard','1',1,'passed',$2,$3,$4)",[id,JSON.stringify([evidence]),JSON.stringify([{id:"case-0"}]),JSON.stringify({immutable:true})]);
    }
    await pool.query("INSERT INTO auth_user(id,name,email,role) VALUES('actor','Actor','actor@example.test','admin')");
    await pool.query("INSERT INTO policy_record(id,name,owner,draft) VALUES('programmable','Legacy Policy','actor','{}')");
    await pool.query("INSERT INTO policy_validation_run(id,policy_id,draft_revision,status,created_by,results) VALUES('legacy-policy','programmable',1,'passed','actor',$1)",[JSON.stringify([{name:"Legacy case",passed:true,actual_decision:"block",expected_decision:"block",rail_type:"output",matched_rule_ids:["rule"],trace:[{name:"kept"}]}])]);
    await pool.query("INSERT INTO controller_outbox(id,kind,aggregate_id,payload) VALUES('legacy-policy','policy.validation_requested','programmable',$1)",[JSON.stringify({testCases:[{id:"frozen-legacy-case"}]})]);
    await pool.query("INSERT INTO policy_resource(id,definition,maintainer) VALUES('policy','{}','fixture')");
    await pool.query("INSERT INTO policy_resource_validation(id,policy_id,revision,status,tests,results) VALUES('parent','policy',1,'passed',$1,$2)",[JSON.stringify([{id:"case-0"}]),JSON.stringify([evidence])]);
    await pool.query("INSERT INTO policy_resource_validation(id,parent_id,policy_id,revision,status,tests,results) VALUES('child','parent','policy',1,'passed',$1,$2)",[JSON.stringify([{id:"case-0"}]),JSON.stringify([evidence])]);
   }
   if(tag==="0057_report_storage_cutover"){
    const db=createPooledDatabase(pool),transaction=db.transaction.bind(db);let calls=0;
    const interrupted={execute:db.execute.bind(db),transaction:((work:Parameters<typeof transaction>[0])=>{
     if(++calls===2)throw new Error("synthetic migration interruption");return transaction(work);
    }) as typeof transaction};
    await expect(migrateReportStorage(interrupted)).rejects.toThrow("synthetic migration interruption");
    expect((await pool.query("SELECT count(*)::int n FROM validation_report WHERE migration_complete")).rows[0].n).toBe(1);
    await migrateReportStorage(db);
    expect((await pool.query("SELECT count(*)::int n FROM validation_report WHERE NOT migration_complete")).rows[0].n).toBe(0);
   }
  });
  const reports=new ReportResults(database.db);
  for(const id of ["a","b","parent","child"]){
   expect((await reports.page(id,{})).count).toBe(1);
   expect(await reports.detail(id,0)).toMatchObject(evidence);
  }
  expect((await database.pool.query("SELECT count(*)::int n FROM validation_report_detail")).rows[0].n).toBe(4);
  expect(await reports.detail("legacy-policy",0)).toMatchObject({caseId:"frozen-legacy-case",actualDecision:"block",actual_decision:"block",phase:"output",matchedRuleIds:["rule"],trace:[{name:"kept"}]});
  expect((await database.pool.query("SELECT count(*)::int n FROM guardrail_validation_snapshot")).rows[0].n).toBe(1);
  const removed=await database.pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND ((table_name IN ('guardrail_validation_run','policy_validation_run','policy_resource_validation') AND column_name='results') OR (table_name='guardrail_validation_run' AND column_name IN ('results_storage','test_suite','candidate_artifact','candidate_policies','candidate_inspection')) OR (table_name='validation_report' AND column_name='migration_complete'))");
  expect(removed.rows).toEqual([]);
  await database.pool.query("DELETE FROM guardrail_validation_run WHERE id='a'");
  expect((await database.pool.query("SELECT count(*)::int n FROM validation_report_detail WHERE owner_id='a'")).rows[0].n).toBe(0);
 });
});
