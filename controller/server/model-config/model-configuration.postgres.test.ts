// Opt-in real PostgreSQL semantics; never calls a Provider or changes public rows.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema.js";
import { emptyModelAssignments } from "./domain.js";
import { ModelConfigurationService } from "./service.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Model draft PostgreSQL optimistic locking", () => {
  const namespace = `guard_model_lock_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let pool: Pool;
  let service: ModelConfigurationService;
  const modelId = randomUUID();
  const providerId = randomUUID();

  beforeAll(async () => {
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(new URL(url!).hostname);
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA "${namespace}"`);
    pool = new Pool({ connectionString: url, max: 2, options: `-c search_path=${namespace}` });
    for (const table of ['model_configuration_revision', 'model_provider', 'model_definition', 'policy_version', 'audit_event']) {
      // LIKE copies structure/indexes, not data or foreign keys to public rows.
      await pool.query(`CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING ALL)`);
    }
    await pool.query("INSERT INTO model_provider (id,name,kind,base_url,credential_ciphertext) VALUES ($1,'Synthetic','custom-openai-compatible','http://provider.invalid/v1','')", [providerId]);
    await pool.query("INSERT INTO model_definition (id,provider_id,name,model,profile) VALUES ($1,$2,'Synthetic','synthetic','tali.qwen3guard.v1')", [modelId, providerId]);
  });
  afterAll(async () => {
    await pool?.end();
    // This identifier is created randomly above, never supplied by environment.
    await admin?.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await admin?.end();
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM model_configuration_revision');
    service = new ModelConfigurationService(drizzle(pool, { schema }), 'synthetic-root',
      resolve('../runner/toolkit/policy_library/assets'), vi.fn(() => { throw new Error('No external calls allowed'); }));
    service.setRailValidator(async () => ({ passed: true, message: 'Synthetic Rail result', latencyMs: 1 }));
  });

  async function seed(assigned = false) {
    const assignments = emptyModelAssignments();
    if (assigned) assignments.bindings['content_safety.input'] = modelId;
    const id = randomUUID();
    await pool.query("INSERT INTO model_configuration_revision (id,revision,assignments,updated_at) VALUES ($1,1,$2,'2026-09-07T00:00:00.123456Z')", [id, assignments]);
    return id;
  }

  it('saves a genuinely new draft without an initial bulk-save workaround', async () => {
    const result = await service.updateAssignment('content_safety.input', modelId, 'synthetic-admin');
    expect(result.assignments.bindings['content_safety.input']).toBe(modelId);
    expect(result).not.toHaveProperty('rowVersion');
  });

  it('proves the old timestamp predicate loses microseconds, then saves the same row', async () => {
    const id = await seed();
    const { rows: [row] } = await pool.query('SELECT updated_at FROM model_configuration_revision WHERE id=$1', [id]);
    const { rowCount } = await pool.query('SELECT id FROM model_configuration_revision WHERE id=$1 AND updated_at=$2', [id, row.updated_at]);
    expect(rowCount).toBe(0);
    const result = await service.updateAssignment('content_safety.input', modelId, 'synthetic-admin');
    expect(result.id).toBe(id);
    expect(result.assignments.bindings['content_safety.input']).toBe(modelId);
  });

  it.each(['single', 'whole'] as const)('validates a microsecond timestamp draft (%s)', async kind => {
    await seed(true);
    const result = kind === 'single'
      ? await service.validateAssignment('content_safety.input', 'synthetic-admin')
      : await service.validateDraft('synthetic-admin');
    expect(result.state).toBe('validated');
    expect(result.validationReport?.valid).toBe(true);
  });

  it.each(['single', 'whole'] as const)('rejects stale %s validation even when a concurrent write keeps the timestamp', async kind => {
    const id = await seed(true);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    service.setRailValidator(async () => { entered(); await gate; return { passed: true, message: 'Stale result', latencyMs: 1 }; });
    const pending = kind === 'single'
      ? service.validateAssignment('content_safety.input', 'synthetic-admin')
      : service.validateDraft('synthetic-admin');
    const rejected = expect(pending).rejects.toMatchObject({ code: 'model_configuration_changed' });
    await started;
    try {
      await pool.query('UPDATE model_configuration_revision SET assignments=$1, updated_at=updated_at WHERE id=$2', [emptyModelAssignments(), id]);
    } finally { release(); }
    await rejected;
    const { rows: [row] } = await pool.query('SELECT assignments,validation_report FROM model_configuration_revision WHERE id=$1', [id]);
    expect(row.assignments.bindings['content_safety.input']).toBeNull();
    expect(row.validation_report).toBeNull();
  });
});
