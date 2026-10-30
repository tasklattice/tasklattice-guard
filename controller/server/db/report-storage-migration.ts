import { sql } from "drizzle-orm";
import type { ControllerDatabase } from "./client.js";

type MigrationDatabase = Pick<ControllerDatabase, "execute" | "transaction">;
/** One-time upgrade, before serving traffic. Checkpoints and transactions are
 * per report; report bodies stay in PostgreSQL, never in application memory. */
export async function migrateReportStorage(db: MigrationDatabase) {
  for (;;) {
    const { rows: [next] } = await db.execute<{ id: string; source: string }>(sql`
      SELECT r.id, CASE WHEN guardrail_run_id IS NOT NULL THEN 'guardrail_validation_run'
        WHEN policy_run_id IS NOT NULL THEN 'policy_validation_run' ELSE 'policy_resource_validation' END AS source
      FROM validation_report r LEFT JOIN policy_resource_validation p ON p.id=r.policy_job_id
      WHERE NOT migration_complete ORDER BY (p.parent_id IS NULL),r.id LIMIT 1`);
    if (!next) break;
    await db.transaction(async tx => {
      const source = sql.identifier(next.source);
      await tx.execute(sql`SELECT id FROM validation_report WHERE id=${next.id} FOR UPDATE`);
      // Existing chunked reports already have rows. Legacy arrays are expanded
      // inside PostgreSQL, one report per transaction, preserving every field.
      const requestedIds = next.source === "policy_validation_run" ? sql`SELECT ARRAY(
        SELECT item->>'id' FROM controller_outbox o CROSS JOIN LATERAL jsonb_array_elements(o.payload->'testCases') item WHERE o.id=${next.id}
      ) AS ids` : sql`SELECT ARRAY[]::text[] AS ids`;
      await tx.execute(sql`WITH requested AS MATERIALIZED (${requestedIds}) INSERT INTO validation_report_case(run_id,ordinal,case_id,status,priority,summary,detail,detail_bytes)
        SELECT ${next.id},(n-1)::int,coalesce(item->>'caseId','migrated-case-'||n),
          CASE WHEN (item->>'skipped')::boolean THEN 'skipped' WHEN (item->>'passed')::boolean THEN 'passed' ELSE 'failed' END,
          CASE WHEN (item->>'skipped')::boolean THEN 3 WHEN coalesce(item->>'actualFailure','')<>'' OR lower(item->>'actualDecision')='error' THEN 0 WHEN (item->>'passed')::boolean THEN 2 ELSE 1 END,
          jsonb_build_object('caseId',coalesce(item->>'caseId','migrated-case-'||n),'name',left(item->>'name',128),'passed',item->'passed','skipped',coalesce(item->'skipped','false'::jsonb),
            'reason',left(item->>'reason',128),'phase',coalesce(item->'phase',item->'rail_type'),'caseType',coalesce(item->'caseType',item->'case_type'),
            'actualDecision',coalesce(item->'actualDecision',item->'actual_decision'),'expectedDecision',coalesce(item->'expectedDecision',item->'expected_decision'),
            'required',item->'required','modelInvocations',coalesce(item->'modelInvocations','0'::jsonb),'traceCount',jsonb_array_length(coalesce(item->'trace','[]'::jsonb))),
          item,octet_length(item::text)
        FROM ${source} r CROSS JOIN LATERAL jsonb_array_elements(r.results) WITH ORDINALITY a(raw,n) CROSS JOIN requested
        CROSS JOIN LATERAL (SELECT raw || jsonb_strip_nulls(jsonb_build_object(
          'caseId',coalesce(raw->>'caseId',(requested.ids)[n::int],'migrated-case-'||n),
          'phase',coalesce(raw->'phase',raw->'rail_type'),'caseType',coalesce(raw->'caseType',raw->'case_type'),
          'actualDecision',coalesce(raw->'actualDecision',raw->'actual_decision'),'expectedDecision',coalesce(raw->'expectedDecision',raw->'expected_decision'),
          'actualFailure',coalesce(raw->'actualFailure',raw->'actual_failure'),'expectedFailure',coalesce(raw->'expectedFailure',raw->'expected_failure'),
          'latencyMs',coalesce(raw->'latencyMs',raw->'latency_ms'),'concurrencyGroup',coalesce(raw->'concurrencyGroup',raw->'concurrency_group'),
          'coveredRuleIds',coalesce(raw->'coveredRuleIds',raw->'covered_rule_ids'),'matchedRuleIds',coalesce(raw->'matchedRuleIds',raw->'matched_rule_ids')
        )) item) normalized
        WHERE r.id=${next.id} ON CONFLICT(run_id,ordinal) DO NOTHING`);
      // A completed Policy parent used to duplicate all child bodies. Reuse an
      // identical child's detail; genuinely different historical data is kept.
      if (next.source === 'policy_resource_validation') {
        await tx.execute(sql`UPDATE validation_report_case parent_case SET detail_id=child_case.detail_id
          FROM policy_resource_validation child JOIN validation_report_case child_case ON child_case.run_id=child.id
          JOIN validation_report_detail body ON body.id=child_case.detail_id
          WHERE parent_case.run_id=${next.id} AND child.parent_id=${next.id}
            AND child_case.case_id=parent_case.case_id AND body.body=parent_case.detail`);
      }
      await tx.execute(sql`INSERT INTO validation_report_detail(id,owner_id,body,bytes)
        SELECT run_id||'/'||ordinal,run_id,detail,detail_bytes FROM validation_report_case
        WHERE run_id=${next.id} AND detail_id IS NULL ON CONFLICT DO NOTHING`);
      await tx.execute(sql`UPDATE validation_report_case SET detail_id=run_id||'/'||ordinal WHERE run_id=${next.id} AND detail_id IS NULL`);
      if (next.source === 'guardrail_validation_run') {
        await tx.execute(sql`WITH source AS (
          SELECT id,jsonb_build_object('candidateArtifact',candidate_artifact,'candidatePolicies',candidate_policies,'candidateInspection',candidate_inspection,'testSuite',test_suite) payload
          FROM guardrail_validation_run WHERE id=${next.id} AND snapshot_digest IS NULL
        ), hashed AS (SELECT id,payload,encode(sha256(convert_to(payload::text,'UTF8')),'hex') digest FROM source),
        stored AS (INSERT INTO guardrail_validation_snapshot(digest,payload) SELECT digest,payload FROM hashed ON CONFLICT DO NOTHING)
        UPDATE guardrail_validation_run r SET snapshot_digest=h.digest FROM hashed h WHERE r.id=h.id`);
      }
      // Clear copied large values now, so retrying this migration does not need
      // twice the storage until the final schema contraction.
      await tx.execute(sql`UPDATE ${source} SET results='[]'::jsonb WHERE id=${next.id}`);
      await tx.execute(sql`UPDATE validation_report_case SET detail=NULL WHERE run_id=${next.id}`);
      await tx.execute(sql`UPDATE validation_report SET migration_complete=true WHERE id=${next.id}`);
    });
  }
}
