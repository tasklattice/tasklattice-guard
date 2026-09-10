// @vitest-environment node
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
    pool = new Pool({ connectionString: url, max: 2, application_name: namespace, options: `-c search_path=${namespace}` });
    for (const table of ['model_configuration_revision', 'model_provider', 'model_definition', 'policy_version', 'audit_event', 'controller_state', 'controller_outbox']) {
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
    await pool.query('DELETE FROM controller_outbox');
    await pool.query('DELETE FROM audit_event');
    await pool.query("INSERT INTO controller_state (id,desired_generation) VALUES ('singleton',0) ON CONFLICT (id) DO UPDATE SET desired_generation=0");
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

  it('keeps saved Chat available across draft creation, Runner activation and rollback', async () => {
    await seed();
    await pool.query("UPDATE model_definition SET profile='generic-chat' WHERE id=$1", [modelId]);
    const chat = new ModelConfigurationService(drizzle(pool, { schema }), 'synthetic-root',
      resolve('../runner/toolkit/policy_library/assets'), vi.fn(async () =>
        Response.json({ choices: [{ message: { content: "Hello" } }] })));
    try {
      await chat.previewAssignment('control_plane', modelId, 'synthetic-admin');
      expect(await chat.controlPlaneModel('playground_chat')).toBeNull();
      const saved = await chat.updateAssignment('control_plane', modelId, 'synthetic-admin');
      expect(await chat.controlPlaneModel('playground_chat')).toMatchObject({ model: 'synthetic' });
      expect((await pool.query('SELECT id FROM controller_outbox')).rows).toHaveLength(0);
      await chat.beginActivation(saved.id, 'synthetic-admin');
      await chat.view(); // Creating the next draft must retain Control Plane evidence.
      expect(await chat.controlPlaneModel('playground_chat')).toMatchObject({ model: 'synthetic' });
      await pool.query("INSERT INTO model_configuration_revision (id,revision,assignments,state) VALUES ($1,0,$2,'superseded')",
        [randomUUID(), emptyModelAssignments()]);
      await chat.rollback('synthetic-admin');
      expect(await chat.controlPlaneModel('playground_chat')).toMatchObject({ model: 'synthetic' });
      await chat.updateAssignment('control_plane', null, 'synthetic-admin');
      expect(await chat.controlPlaneModel('playground_chat')).toBeNull();
    } finally {
      await pool.query("UPDATE model_definition SET profile='tali.qwen3guard.v1' WHERE id=$1", [modelId]);
    }
  });

  it('saves a genuinely new draft without an initial bulk-save workaround', async () => {
    await service.previewAssignment('content_safety.input', modelId, 'synthetic-admin');
    const result = await service.updateAssignment('content_safety.input', modelId, 'synthetic-admin');
    expect(result.assignments.bindings['content_safety.input']).toBe(modelId);
    expect(result).not.toHaveProperty('rowVersion');
  });

  it('proves the old timestamp predicate loses microseconds, then saves the same row', async () => {
    const id = await seed();
    const { rows: [row] } = await pool.query('SELECT updated_at FROM model_configuration_revision WHERE id=$1', [id]);
    const { rowCount } = await pool.query('SELECT id FROM model_configuration_revision WHERE id=$1 AND updated_at=$2', [id, row.updated_at]);
    expect(rowCount).toBe(0);
    await service.previewAssignment('content_safety.input', modelId, 'synthetic-admin');
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

  it('starts activation only after Rail validation and publishes exactly one desired-state event', async () => {
    const id = await seed(true);
    await service.validateAssignment('content_safety.input', 'synthetic-admin');
    const result = await service.beginActivation(id, 'synthetic-admin');
    expect(result.state).toBe('activating');
    expect(result.generation).toBe(1);
    const { rows: events } = await pool.query('SELECT kind,aggregate_id,payload FROM controller_outbox');
    expect(events).toEqual([{ kind: 'runner.desired_state_changed', aggregate_id: id,
      payload: { resourceType: 'model_configuration', revisionId: id, generation: 1 } }]);
    await expect(service.beginActivation(id, 'synthetic-admin')).rejects.toMatchObject({ code: 'model_configuration_not_validated' });
    const { rows: [state] } = await pool.query("SELECT desired_generation FROM controller_state WHERE id='singleton'");
    expect(Number(state.desired_generation)).toBe(1);
  });

  it('publishes only once when two activation requests pass preflight together', async () => {
    const id = await seed(true);
    await service.validateAssignment('content_safety.input', 'synthetic-admin');
    const reportFromChecks = service['reportFromChecks'].bind(service);
    let arrivals = 0;
    let release!: () => void;
    const bothChecked = new Promise<void>(resolve => { release = resolve; });
    // Force both requests past the real preflight before either starts its
    // transaction. No timers or external model calls determine the race.
    const preflight = vi.spyOn(service as unknown as { reportFromChecks: typeof reportFromChecks }, 'reportFromChecks')
      .mockImplementation(async (...args) => {
        const result = await reportFromChecks(...args);
        if (++arrivals === 2) release();
        await bothChecked;
        return result;
      });
    let results: PromiseSettledResult<Awaited<ReturnType<typeof service.beginActivation>>>[];
    try {
      results = await Promise.allSettled([
        service.beginActivation(id, 'synthetic-admin-a'),
        service.beginActivation(id, 'synthetic-admin-b'),
      ]);
    } finally {
      preflight.mockRestore();
    }
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'model_configuration_not_validated' }) }),
    ]);
    const { rows: revisions } = await pool.query('SELECT state,generation,failure_reason FROM model_configuration_revision WHERE id=$1', [id]);
    expect(revisions).toEqual([{ state: 'activating', generation: '1', failure_reason: null }]);
    expect((await pool.query('SELECT payload FROM controller_outbox')).rows).toEqual([
      { payload: { resourceType: 'model_configuration', revisionId: id, generation: 1 } },
    ]);
    const { rows: [state] } = await pool.query("SELECT desired_generation FROM controller_state WHERE id='singleton'");
    expect(Number(state.desired_generation)).toBe(1);
    expect((await pool.query("SELECT id FROM audit_event WHERE kind='model_configuration.activation_started'")).rows).toHaveLength(1);
  });

  it('still lets a different validated revision replace an unfinished activation', async () => {
    const first = await seed(true);
    await service.validateAssignment('content_safety.input', 'synthetic-admin');
    const second = await service.updateAssignment('content_safety.input', modelId, 'synthetic-admin');
    expect(second.id).not.toBe(first);
    await service.beginActivation(first, 'synthetic-admin');
    const replacement = await service.beginActivation(second.id, 'synthetic-admin');
    expect(replacement.state).toBe('activating');
    expect(replacement.generation).toBe(2);
    expect((await pool.query('SELECT state,failure_reason FROM model_configuration_revision WHERE id=$1', [first])).rows)
      .toEqual([{ state: 'failed', failure_reason: 'A newer model configuration activation replaced this attempt.' }]);
    expect((await pool.query('SELECT id FROM controller_outbox')).rows).toHaveLength(2);
    const { rows: [state] } = await pool.query("SELECT desired_generation FROM controller_state WHERE id='singleton'");
    expect(Number(state.desired_generation)).toBe(2);
  });

  it('cannot resurrect a replaced activation when its ACK was delayed by a database lock', async () => {
    const original = randomUUID();
    await pool.query("INSERT INTO model_configuration_revision (id,revision,assignments,state) VALUES ($1,0,$2,'active')", [original, emptyModelAssignments()]);
    const first = await seed(true);
    await service.validateAssignment('content_safety.input', 'synthetic-admin');
    const next = await service.updateAssignment('content_safety.input', modelId, 'synthetic-admin');
    await service.beginActivation(first, 'synthetic-admin');

    async function waitUntil(condition: () => Promise<boolean>) {
      const deadline = Date.now() + 3000;
      while (!(await condition())) {
        if (Date.now() >= deadline) throw new Error('Expected database lock interleaving was not observed');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    async function lockWaiters() {
      const { rows: [row] } = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [namespace]);
      return Number(row.count);
    }
    await admin.query('BEGIN');
    await admin.query(`SELECT id FROM "${namespace}".model_configuration_revision WHERE id=$1 FOR UPDATE`, [original]);
    let finalization: Promise<void> | undefined;
    let replacement: ReturnType<typeof service.beginActivation> | undefined;
    let replacementCompletedBeforeAck = false;
    try {
      finalization = service.finalizeActivation(first);
      await waitUntil(async () => await lockWaiters() === 1);
      let replacementSettled = false;
      replacement = service.beginActivation(next.id, 'synthetic-admin');
      void replacement.then(() => { replacementSettled = true; }, () => { replacementSettled = true; });
      await waitUntil(async () => replacementSettled || await lockWaiters() === 2);
      replacementCompletedBeforeAck = replacementSettled;
    } finally {
      await admin.query('ROLLBACK');
      await Promise.all([finalization, replacement]);
    }
    const { rows } = await pool.query('SELECT id,state FROM model_configuration_revision');
    const states = new Map(rows.map(row => [row.id, row.state]));
    expect(states.get(next.id)).toBe('activating');
    // If replacement committed first, the stale ACK must be ignored. If ACK
    // holds the activation lock, it completes first and remains last-known-good
    // while the replacement waits for its own ACK. Both serial orders are valid.
    expect(states.get(first)).toBe(replacementCompletedBeforeAck ? 'failed' : 'active');
    expect(states.get(original)).toBe(replacementCompletedBeforeAck ? 'active' : 'superseded');
    expect(rows.filter(row => row.state === 'active')).toHaveLength(1);
    expect((await pool.query('SELECT id FROM controller_outbox')).rows).toHaveLength(2);
  });

  it('ignores a late ACK after a NACK and keeps the prior active configuration', async () => {
    const prior = randomUUID();
    await pool.query("INSERT INTO model_configuration_revision (id,revision,assignments,state) VALUES ($1,0,$2,'active')", [prior, emptyModelAssignments()]);
    const id = await seed(true);
    await service.validateAssignment('content_safety.input', 'synthetic-admin');
    await service.beginActivation(id, 'synthetic-admin');
    await service.failActivation(id, 'Synthetic Runner NACK');
    await service.finalizeActivation(id);
    expect((await pool.query('SELECT state,failure_reason FROM model_configuration_revision WHERE id=$1', [id])).rows)
      .toEqual([{ state: 'failed', failure_reason: 'Synthetic Runner NACK' }]);
    expect((await pool.query("SELECT id FROM model_configuration_revision WHERE state='active'")).rows).toEqual([{ id: prior }]);
  });

  it('does not activate a partially passing configuration or invalidate its unrelated failure', async () => {
    const id = await seed(true);
    await service.previewAssignment('content_safety.output', modelId, 'synthetic-admin');
    await service.updateAssignment('content_safety.output', modelId, 'synthetic-admin');
    service.setRailValidator(async ({ bindingId }) => ({
      passed: bindingId === 'content_safety.input', message: `Synthetic ${bindingId} result`, latencyMs: 1,
    }));
    await service.validateAssignment('content_safety.output', 'synthetic-admin');
    const result = await service.validateAssignment('content_safety.input', 'synthetic-admin');
    expect(result.state).toBe('draft');
    expect(result.validationReport?.valid).toBe(false);
    expect(result.validationReport?.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: expect.stringContaining('content_safety.output'), status: 'failed' }),
      expect.objectContaining({ id: expect.stringContaining('content_safety.input'), status: 'passed' }),
    ]));
    await expect(service.beginActivation(id, 'synthetic-admin')).rejects.toMatchObject({ code: 'model_configuration_not_validated' });
    expect((await pool.query('SELECT id FROM controller_outbox')).rows).toEqual([]);
    const { rows: [state] } = await pool.query("SELECT desired_generation FROM controller_state WHERE id='singleton'");
    expect(Number(state.desired_generation)).toBe(0);
  });

  it('preserves validated Rail evidence when saving an unchanged assignment', async () => {
    const id = await seed(true);
    await service.validateAssignment('content_safety.input', 'synthetic-admin');
    // Saving unchanged settings preserves the successful validation.
    const edited = await service.updateAssignment('content_safety.input', modelId, 'synthetic-admin');
    // Validated revisions are immutable snapshots; editing forks a new draft.
    expect(edited.id).not.toBe(id);
    expect(edited.state).toBe('validated');
    expect(edited.validationReport?.valid).toBe(true);
    expect((await pool.query('SELECT id FROM controller_outbox')).rows).toEqual([]);
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
