// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { queryRuntimeMetrics } from './runtime-metrics.js';
import { ControlPlaneService } from './control-plane.js';
import { boundedRead } from '../db/read-budget.js';

// Uses session-local temporary tables only; never inserts/deletes application records.
describe.skipIf(!process.env.TEST_DATABASE_URL)('bounded runtime observability (PostgreSQL)', () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  const db = drizzle(pool);
  const service = Object.assign(Object.create(ControlPlaneService.prototype), { db, runtimeLogEncryptionKey: null }) as ControlPlaneService;
  beforeAll(async () => {
    for (const name of ['runtime_event','guardrail','guardrail_router','endpoint','guardrail_validation_run']) {
      await db.execute(sql.raw(`CREATE TEMP TABLE ${name} (LIKE public.${name} INCLUDING DEFAULTS)`));
    }
    await db.execute(sql`INSERT INTO runtime_event(id,occurred_at,request_id,runner_id,guardrail_id,router_id,direction,decision,duration_ms,metadata)
      SELECT 'event-'||lpad(n::text,6,'0'),now()-interval '1 hour','request-'||n,'runner','guard','router','incoming',
        CASE WHEN n%2=0 THEN 'block' ELSE 'allow' END,n,
        jsonb_build_object('captureLevel','trace','contentBefore',repeat('private content',2500),'contentCiphertext','private ciphertext',
          'trace',jsonb_build_array(jsonb_build_object('kind','action','name','same-action','policyId','same-policy','durationMs',n,'outcome','safe')),
          'findings', CASE WHEN n%2=0 THEN jsonb_build_array(jsonb_build_object('risk','test','verdict','unsafe','confidence',.95,'evidence',repeat('private evidence',100))) ELSE '[]'::jsonb END,
          'usage',jsonb_build_object('model_invocations',1))
      FROM generate_series(1,10001) n`);
  }, 30_000);
  afterAll(async () => { await pool.end(); });

  it('aggregates more than 10000 events exactly without returning raw evidence', async () => {
    const result = await queryRuntimeMetrics(db as any, { window: '24h', routerId: 'router' });
    expect(result.total_decisions).toBe(10001);
    expect(result.runtime_p95_ms).toBe(9501);
    expect(result.model_invocations).toBe(10001);
    expect(result.findings_summary).toMatchObject({ total:5000, high:5000, affected_traces:5000 });
    expect(result.action_metrics[0]).toMatchObject({ invocations:10001, p95_latency_ms:9501 });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('private');
    expect(Buffer.byteLength(serialized)).toBeLessThan(150_000);
  }, 30_000);

  it('bounds list payloads and paginates equal timestamps without gaps or duplication', async () => {
    const ids = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await service.queryRuntimeEvents({ limit:500, cursor, routerId:'router' });
      expect(page.items.length).toBeLessThanOrEqual(500);
      expect(JSON.stringify(page)).not.toContain('private');
      expect(JSON.stringify(page)).not.toContain('same-action');
      for (const row of page.items) { expect(ids.has(row.id)).toBe(false); ids.add(row.id); }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids.size).toBe(10001);
  },30_000);

  it('filters before pagination and rejects malformed cursors', async () => {
    const page = await service.queryRuntimeEvents({limit:100,outcome:'block', findingsOnly:true});
    expect(page.items).toHaveLength(100);
    expect(page.items.every(r=>r.decision==='block')).toBe(true);
    await expect(service.queryRuntimeEvents({cursor:'invalid'})).rejects.toThrow('Invalid event cursor');
    const detail = await service.getRuntimeEvent(page.items[0]!.id);
    expect(detail.metadata.trace).toHaveLength(1);
    expect(detail.metadata).not.toHaveProperty('contentBefore');
    expect(detail.metadata).not.toHaveProperty('contentCiphertext');
  });

  it('finds older critical events before applying the page limit', async () => {
    await db.execute(sql`UPDATE runtime_event SET metadata=jsonb_build_object('findings',jsonb_build_array(jsonb_build_object('verdict','error'))) WHERE id='event-000001'`);
    try {
      const page = await service.queryRuntimeEvents({ limit:1, severity:'critical', routerId:'router' });
      expect(page.items.map(r => r.id)).toEqual(['event-000001']);
      expect(page.nextCursor).toBeNull();
    } finally {
      await db.execute(sql`UPDATE runtime_event SET metadata='{}'::jsonb WHERE id='event-000001'`);
    }
  });

  it('cancels SQL at the shared deadline and releases the only pool connection', async () => {
    const started = performance.now();
    await expect(boundedRead(db as any, async (tx, execute) => {
      await execute(tx.execute(sql`SELECT pg_sleep(.6)`));
      await execute(tx.execute(sql`SELECT pg_sleep(.6)`));
    }, 1000)).rejects.toMatchObject({ cause: { code: '57014' } });
    expect(performance.now() - started).toBeLessThan(2000);
    expect((await db.execute(sql`SELECT 1 AS ok`)).rows[0]).toEqual({ok:1});
  });

  it('preserves old endpoint activity while counting only recent requests', async () => {
    await db.execute(sql`INSERT INTO endpoint(id,name,adapter) VALUES ('activity','Activity','test')`);
    await db.execute(sql`INSERT INTO runtime_event(id,occurred_at,request_id,runner_id,endpoint_id,direction,decision,duration_ms,metadata) VALUES
      ('old-activity',now()-interval '40 days','old','runner','activity','outgoing','error',1,'{"streamFinalCheck":true}'),
      ('recent-activity',now()-interval '1 hour','recent','runner','activity','incoming','allow',1,'{}')`);
    const result = await service.runtimeEndpointActivity();
    expect(result.items[0]).toMatchObject({id:'activity',request_count:1,error_count:0});
    const row=result.items[0]!;
    expect(new Date(String(row.first_seen_at)).getTime()).toBeLessThan(Date.now()-30*86400000);
    expect(row.output_seen_at).toEqual(row.first_seen_at);
    expect(row.last_error_at).toEqual(row.first_seen_at);
    expect(row.stream_final_check_seen_at).toEqual(row.first_seen_at);
  });

  it('counts a policy step once instead of emitting duplicate name and guardrail groups', async () => {
    await db.execute(sql`INSERT INTO runtime_event(id,occurred_at,request_id,runner_id,guardrail_id,router_id,direction,decision,duration_ms,metadata) VALUES
      ('policy-proof',now(),'policy-proof','runner','guard','policy-proof','incoming','allow',5,
       '{"trace":[{"kind":"policy","name":"policy-a@1","policyId":"policy-a","durationMs":5},{"kind":"action","name":"action-a","policyId":"policy-a","durationMs":2}]}')`);
    const result = await queryRuntimeMetrics(db as any, {window:'24h',routerId:'policy-proof'});
    expect(result.policy_distribution).toHaveLength(1);
    expect(result.policy_distribution[0]).toMatchObject({policy_id:'policy-a',invocations:2,hit_share:100});
    expect(result.action_metrics).toHaveLength(1);
    expect(result.rail_metrics).toHaveLength(0);
  });
});
