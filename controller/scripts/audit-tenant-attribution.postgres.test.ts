// @vitest-environment node
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '../server/db/postgres-test-database.js';
import { loadConfig } from '../server/config.js';
import { ControlPlaneService } from '../server/services/control-plane.js';
import { runWithTenantContext } from '../server/services/tenant-context.js';

// Regression for the previously observed shared-Guardrail attribution defect.
// This exercises ingestion in an isolated schema, not a live Playground session.
const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)('regression: shared Playground tenant attribution', () => {
it('attributes shared Playground evidence to the caller and quarantines unknown provenance', async () => {
  const database = await createTestDatabase(url!, 'guard_attribution_audit');
  try {
    const config = loadConfig({ NODE_ENV: 'test', CONTROLLER_DATABASE_URL: url!, CONTROLLER_RUNNER_TOKEN: 'runner-token-that-is-at-least-32-characters', CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: '/tmp/test-key.pem', CONTROLLER_POLICY_CATALOG_DIR: fileURLToPath(new URL('../../runner/toolkit/policy_library/assets', import.meta.url)), BETTER_AUTH_SECRET: 'better-auth-secret-that-is-at-least-32-characters' });
    const service = new ControlPlaneService(database.db, config);
    await database.pool.query(`INSERT INTO guardrail (id,tenant_id,name,draft_config) VALUES ('shared-c','tenantC','Synthetic shared C','{}');
      INSERT INTO resource_share (id,owner_tenant_id,recipient_tenant_id,resource_type,resource_id) VALUES ('grant-c-a','tenantC','tenantA','guardrail','shared-c');
      INSERT INTO endpoint (id,tenant_id,name,adapter) VALUES ('endpoint-a','tenantA','Synthetic A','litellm-generic-guardrail');`);
    const asTenant = <T>(tenantId: string, callback: () => T) => runWithTenantContext({ tenantId, role: 'user' }, callback);
    expect((await asTenant('tenantA', () => service.getGuardrail('shared-c'))).tenantId).toBe('tenantC');
    await service.registerPlaygroundInvocation({ callId: 'playground:synthetic-call', tenantId: 'tenantA', guardrailId: 'shared-c', guardrailVersion: 'v1', poolId: 'pool-a', groupId: 'group-a' });
    const common = { occurredAt: new Date(), requestId: 'playground:synthetic-call', runnerId: 'synthetic-runner', guardrailId: 'shared-c', guardrailVersion: 'v1', direction: 'incoming' as const, decision: 'allow', durationMs: 1,
      metadata: { protocol: 'playground', usage: { model_calls: [{ call_id:'synthetic', provider:'synthetic', model:'synthetic', usage_known:true, input_tokens:1, output_tokens:1 }] } } };
    await service.recordRuntimeEvents([{...common, id:'internal-playground'}, {...common, id:'endpoint-control', requestId:'external-call', endpointId:'endpoint-a', metadata: { ...common.metadata, protocol:'litellm' }}, {...common, id:'unknown-guardrail', requestId:'unattributed', guardrailId:'unknown-id'}]);
    const rows = (await database.pool.query("SELECT id,tenant_id FROM runtime_event ORDER BY id")).rows;
    const costs = (await database.pool.query("SELECT event_id,tenant_id FROM model_usage_cost ORDER BY event_id")).rows;
    expect(rows).toEqual([{id:'endpoint-control',tenant_id:'tenantA'}, {id:'internal-playground',tenant_id:'tenantA'}, {id:'unknown-guardrail',tenant_id:null}]);
    expect(costs).toEqual([{event_id:'endpoint-control',tenant_id:'tenantA'}, {event_id:'internal-playground',tenant_id:'tenantA'}, {event_id:'unknown-guardrail',tenant_id:null}]);
  } finally { await database.drop(); }
}, 60000);
});
