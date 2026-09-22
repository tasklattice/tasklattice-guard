// @vitest-environment node
// Opt-in real PostgreSQL semantics; never calls a Provider or changes public rows.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema.js";
import { emptyModelAssignments } from "./domain.js";
import { ModelConfigurationService } from "./service.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Current model configuration PostgreSQL semantics", () => {
  const namespace = `guard_model_apply_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let pool: Pool;
  let service: ModelConfigurationService;
  const modelId = randomUUID();
  const providerId = randomUUID();
  const directory = resolve('../runner/toolkit/policy_library/assets');

  beforeAll(async () => {
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(new URL(url!).hostname);
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA "${namespace}"`);
    pool = new Pool({ connectionString: url, max: 2, application_name: namespace, options: `-c search_path=${namespace}` });
    for (const table of ['model_assignment_validation', 'model_configuration_revision', 'model_provider', 'model_definition', 'policy_version', 'audit_event', 'controller_state', 'controller_outbox']) {
      await pool.query(`CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING ALL)`);
    }
    await pool.query("INSERT INTO model_provider (id,name,kind,base_url,credential_ciphertext) VALUES ($1,'Synthetic','custom-openai-compatible','http://provider.invalid/v1','')", [providerId]);
    await pool.query("INSERT INTO model_definition (id,provider_id,name,model,profile) VALUES ($1,$2,'Synthetic','synthetic','tali.qwen3guard.v1')", [modelId, providerId]);
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await admin?.end();
  });
  beforeEach(async () => {
    for (const table of ['model_configuration_revision', 'model_assignment_validation', 'controller_outbox', 'audit_event']) await pool.query(`DELETE FROM ${table}`);
    await pool.query("INSERT INTO controller_state (id,desired_generation) VALUES ('singleton',0) ON CONFLICT (id) DO UPDATE SET desired_generation=0");
    await pool.query("UPDATE model_definition SET name='Synthetic',profile='tali.qwen3guard.v1' WHERE id=$1", [modelId]);
    service = new ModelConfigurationService(drizzle(pool, { schema }), 'synthetic-root', directory,
      vi.fn(() => { throw new Error('No external calls allowed'); }));
    service.setRailValidator(async () => ({ passed: true, message: 'Synthetic Rail result', latencyMs: 1 }));
  });
  async function seed(assigned = false) {
    const assignments = emptyModelAssignments();
    if (assigned) assignments.bindings['content_safety.input'] = modelId;
    const id = randomUUID();
    await pool.query("INSERT INTO model_configuration_revision (id,revision,assignments,updated_at) VALUES ($1,1,$2,'2026-09-07T00:00:00.123456Z')", [id, assignments]);
    return id;
  }
  async function review() {
    const view = await service.view();
    return { bindingIds: ['content_safety.input' as const], expectedDraftToken: view.draft!.reviewToken, expectedActiveId: view.active?.id ?? null };
  }
  async function seedPartial() {
    const draftId = await seed(true);
    const assignments = emptyModelAssignments();
    assignments.bindings['content_safety.output'] = modelId;
    const activeId = randomUUID();
    const report = { valid: true, checkedAt: new Date().toISOString(), checks: [{ id: `probe:content_safety.output:${modelId}`, status: 'passed', scope: 'capability', evidenceKind: 'nemo-rail-v1', message: 'Passed' }], contractCoverage: [], policies: [] };
    const proposed = emptyModelAssignments();
    proposed.bindings['content_safety.input'] = modelId;
    proposed.bindings['content_safety.output'] = randomUUID();
    const draftReport = { ...report, valid: false, checks: [{ ...report.checks[0]!, id: `probe:content_safety.input:${modelId}` }, { ...report.checks[0]!, id: `probe:content_safety.output:${proposed.bindings['content_safety.output']}`, status: 'failed' }] };
    await pool.query("UPDATE model_configuration_revision SET revision=2,assignments=$2,validation_report=$3 WHERE id=$1", [draftId, proposed, draftReport]);
    await pool.query("INSERT INTO model_configuration_revision (id,revision,state,assignments,validation_report) VALUES ($1,1,'active',$2,$3)", [activeId, assignments, report]);
    return { draftId, activeId, proposed, selection: await review() };
  }
  it('overwrites current configuration without history and retains deferred edits', async () => {
    const { draftId, activeId, proposed, selection } = await seedPartial();
    const result = await service.applyConfiguration('synthetic-admin', selection);
    expect(result.assignments.bindings['content_safety.input']).toBe(modelId);
    expect(result.assignments.bindings['content_safety.output']).toBe(modelId);
    expect(result).not.toHaveProperty('revision');
    expect((await service.view()).active?.id).toBe(activeId);
    await service.finalizeActivation(result.id);
    const view = await service.view();
    expect(view.active?.id).toBe(result.id);
    expect(view).not.toHaveProperty('rollbackTarget');
    expect(view.draft?.id).toBe(draftId);
    expect(view.draft?.assignments).toEqual(proposed);
    expect((await pool.query('SELECT id FROM model_configuration_revision WHERE id=$1', [activeId])).rows).toHaveLength(0);
    expect((await pool.query('SELECT id FROM model_configuration_revision')).rows).toHaveLength(2);
    expect((await pool.query('SELECT id FROM audit_event')).rows.length).toBeGreaterThan(0);
  });
  it.each(['unready', 'stale-draft', 'stale-active'])('rejects %s Apply without advancing generation', async kind => {
    const { draftId, selection } = await seedPartial();
    if (kind === 'stale-draft') await pool.query("UPDATE model_configuration_revision SET validation_report=validation_report || '{\"valid\":true}'::jsonb WHERE id=$1", [draftId]);
    await expect(service.applyConfiguration('synthetic-admin', {
      ...selection,
      ...(kind === 'unready' ? { bindingIds: ['content_safety.output' as const] } : {}),
      ...(kind === 'stale-active' ? { expectedActiveId: null } : {}),
    })).rejects.toMatchObject({ code: kind === 'unready' ? 'model_configuration_not_validated' : 'model_configuration_changed' });
    expect(Number((await pool.query('SELECT desired_generation FROM controller_state')).rows[0].desired_generation)).toBe(0);
    expect((await pool.query('SELECT id FROM controller_outbox')).rows).toHaveLength(0);
  });
  it('keeps unready bindings unassigned on first Apply', async () => {
    const { activeId, selection } = await seedPartial();
    await pool.query('DELETE FROM model_configuration_revision WHERE id=$1', [activeId]);
    const result = await service.applyConfiguration('synthetic-admin', { ...selection, expectedActiveId: null });
    expect(result.assignments.bindings['content_safety.input']).toBe(modelId);
    expect(result.assignments.bindings['content_safety.output']).toBeNull();
  });
  it('allows explicit removal without applying an unselected addition', async () => {
    const { draftId } = await seedPartial();
    const proposed = emptyModelAssignments();
    proposed.bindings['content_safety.input'] = modelId;
    const prior = await service.view();
    const report = { ...prior.draft!.validationReport!, checks: prior.draft!.validationReport!.checks.filter(check => check.id.startsWith('probe:content_safety.input:')) };
    await pool.query('UPDATE model_configuration_revision SET assignments=$2,validation_report=$3 WHERE id=$1', [draftId, proposed, report]);
    const result = await service.applyConfiguration('synthetic-admin', { ...await review(), bindingIds: ['content_safety.output'] });
    expect(result.assignments.bindings['content_safety.output']).toBeNull();
    expect(result.assignments.bindings['content_safety.input']).toBeNull();
    expect((await service.view()).draft?.assignments.bindings['content_safety.input']).toBe(modelId);
  });
  it('retains current configuration on rejection and ignores a late ACK', async () => {
    const { activeId, proposed, selection } = await seedPartial();
    const result = await service.applyConfiguration('synthetic-admin', selection);
    await service.failActivation(result.id, 'Synthetic NACK');
    await service.finalizeActivation(result.id);
    const view = await service.view();
    expect(view.active?.id).toBe(activeId);
    expect(view.failed?.id).toBe(result.id);
    expect(view.draft?.assignments).toEqual(proposed);
    const retry = await service.applyConfiguration('synthetic-admin', selection);
    expect((await pool.query('SELECT id FROM model_configuration_revision WHERE id=$1', [result.id])).rows).toHaveLength(0);
    await service.finalizeActivation(result.id);
    expect((await service.view()).activating?.id).toBe(retry.id);
  });
  it('serializes concurrent Apply requests and rejects a replay after completion', async () => {
    const { selection } = await seedPartial();
    const results = await Promise.allSettled([service.applyConfiguration('admin-a', selection), service.applyConfiguration('admin-b', selection)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results.find(result => result.status === 'fulfilled')!;
    if (winner.status !== 'fulfilled') throw new Error('Missing winner');
    expect((await pool.query('SELECT id FROM controller_outbox')).rows).toHaveLength(1);
    await service.finalizeActivation(winner.value.id);
    await expect(service.applyConfiguration('synthetic-admin', selection)).rejects.toMatchObject({ code: 'model_configuration_changed' });
    expect(Number((await pool.query('SELECT desired_generation FROM controller_state')).rows[0].desired_generation)).toBe(1);
  });
  it('does not resurrect an overwritten configuration after a delayed ACK', async () => {
    const { activeId, selection } = await seedPartial();
    const first = await service.applyConfiguration('synthetic-admin', selection);
    await service.finalizeActivation(first.id);
    await service.updateAssignment('content_safety.input', null, 'synthetic-admin');
    const second = await service.applyConfiguration('synthetic-admin', await review());
    await service.finalizeActivation(second.id);
    await service.finalizeActivation(first.id);
    await service.finalizeActivation(activeId);
    expect((await service.view()).active?.id).toBe(second.id);
    expect((await pool.query('SELECT id FROM model_configuration_revision')).rows).toHaveLength(2);
  });
  it('never mutates state during a read', async () => {
    expect((await service.view()).draft).toBeNull();
    expect((await pool.query('SELECT id FROM model_configuration_revision')).rows).toHaveLength(0);
  });
  it('shares receipts and enforces ownership, expiry and unchanged model settings', async () => {
    await seed();
    const receipt = await service.previewAssignment('content_safety.input', modelId, 'synthetic-admin');
    const peer = new ModelConfigurationService(drizzle(pool, { schema }), 'synthetic-root', directory);
    await expect(peer.getAssignmentValidation('content_safety.input', receipt.validationId, 'other')).rejects.toMatchObject({ code: 'not_found' });
    await expect(peer.updateAssignment('content_safety.input', modelId, 'other', receipt.validationId)).rejects.toMatchObject({ code: 'model_assignment_not_validated' });
    await pool.query('UPDATE model_assignment_validation SET expires_at=now()-interval \'1 minute\' WHERE id=$1', [receipt.validationId]);
    await expect(peer.updateAssignment('content_safety.input', modelId, 'synthetic-admin', receipt.validationId)).rejects.toMatchObject({ code: 'model_assignment_not_validated' });
    await pool.query("UPDATE model_assignment_validation SET expires_at=now()+interval '10 minutes' WHERE id=$1", [receipt.validationId]);
    await pool.query("UPDATE model_definition SET name='Changed' WHERE id=$1", [modelId]);
    await expect(peer.updateAssignment('content_safety.input', modelId, 'synthetic-admin', receipt.validationId)).rejects.toMatchObject({ code: 'model_assignment_not_validated' });
    const fresh = await service.previewAssignment('content_safety.input', modelId, 'synthetic-admin');
    expect((await peer.updateAssignment('content_safety.input', modelId, 'synthetic-admin', fresh.validationId)).assignments.bindings['content_safety.input']).toBe(modelId);
  });
  it('updates the same editable config across validation and saves instead of forking versions', async () => {
    const first = await seed();
    for (const target of ['pii_semantic.input', 'pii_semantic.output'] as const) {
      const receipt = await service.previewAssignment(target, modelId, 'synthetic-admin');
      const saved = await service.updateAssignment(target, modelId, 'synthetic-admin', receipt.validationId);
      expect(saved.id).toBe(first);
      expect(saved.assignments.bindings[target]).toBe(modelId);
    }
    expect((await pool.query('SELECT id FROM model_configuration_revision')).rows).toHaveLength(1);
  });
  it('keeps independently saved Chat available during and after Runner Apply', async () => {
    const { selection } = await seedPartial();
    const chatId = randomUUID();
    await pool.query("INSERT INTO model_definition (id,provider_id,name,model,profile) VALUES ($1,$2,'Chat','chat','generic-chat')", [chatId, providerId]);
    const chat = new ModelConfigurationService(drizzle(pool, { schema }), 'synthetic-root', directory,
      vi.fn(async () => Response.json({ choices: [{ message: { content: 'Hello' } }] })));
    const receipt = await chat.previewAssignment('control_plane', chatId, 'synthetic-admin');
    await chat.updateAssignment('control_plane', chatId, 'synthetic-admin', receipt.validationId);
    const pending = await service.applyConfiguration('synthetic-admin', { ...selection, expectedDraftToken: (await service.view()).draft!.reviewToken });
    expect(await chat.controlPlaneModel('playground_chat')).toMatchObject({ model: 'chat' });
    await service.finalizeActivation(pending.id);
    expect(await chat.controlPlaneModel('playground_chat')).toMatchObject({ model: 'chat' });
    await chat.updateAssignment('control_plane', null, 'synthetic-admin');
    expect(await chat.controlPlaneModel('playground_chat')).toBeNull();
    await pool.query('DELETE FROM model_definition WHERE id=$1', [chatId]);
  });
  it('creates initial editable configuration and preserves evidence when saving unchanged settings', async () => {
    const receipt = await service.previewAssignment('content_safety.input', modelId, 'synthetic-admin');
    const saved = await service.updateAssignment('content_safety.input', modelId, 'synthetic-admin', receipt.validationId);
    const unchanged = await service.updateAssignment('content_safety.input', modelId, 'synthetic-admin');
    expect(unchanged.id).toBe(saved.id);
    expect(unchanged.validationReport?.valid).toBe(true);
    expect(unchanged).not.toHaveProperty('rowVersion');
    expect((await pool.query('SELECT id FROM model_configuration_revision')).rows).toHaveLength(1);
  });
  it('saves despite PostgreSQL timestamp microseconds', async () => {
    const id = await seed();
    const { rows: [row] } = await pool.query('SELECT updated_at FROM model_configuration_revision WHERE id=$1', [id]);
    expect((await pool.query('SELECT id FROM model_configuration_revision WHERE id=$1 AND updated_at=$2', [id, row.updated_at])).rowCount).toBe(0);
    const receipt = await service.previewAssignment('content_safety.input', modelId, 'synthetic-admin');
    expect((await service.updateAssignment('content_safety.input', modelId, 'synthetic-admin', receipt.validationId)).id).toBe(id);
  });
  it.each(['single', 'whole'] as const)('validates microsecond timestamps (%s)', async kind => {
    await seed(true);
    const result = kind === 'single' ? await service.validateAssignment('content_safety.input', 'synthetic-admin') : await service.validateDraft('synthetic-admin');
    expect(result.validationReport?.valid).toBe(true);
  });
  it.each(['single', 'whole'] as const)('rejects stale %s validation even if a concurrent write retains the timestamp', async kind => {
    const id = await seed(true);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    service.setRailValidator(async () => { entered(); await gate; return { passed: true, message: 'Stale', latencyMs: 1 }; });
    const pending = kind === 'single' ? service.validateAssignment('content_safety.input', 'synthetic-admin') : service.validateDraft('synthetic-admin');
    const rejected = expect(pending).rejects.toMatchObject({ code: 'model_configuration_changed' });
    await started;
    try { await pool.query('UPDATE model_configuration_revision SET assignments=$1,updated_at=updated_at WHERE id=$2', [emptyModelAssignments(), id]); }
    finally { release(); }
    await rejected;
    expect((await service.view()).draft?.assignments.bindings['content_safety.input']).toBeNull();
  });
  it('migrates away historical configurations while retaining latest editable/current state', async () => {
    const { draftId, activeId } = await seedPartial();
    await pool.query("INSERT INTO model_configuration_revision (id,revision,state,assignments) VALUES ($1,0,'superseded',$2),($3,3,'validated',$2)", [randomUUID(), emptyModelAssignments(), 'latest-draft']);
    await pool.query(readFileSync(resolve('server/db/migrations/0014_current_model_configuration.sql'), 'utf8'));
    const ids = (await pool.query('SELECT id FROM model_configuration_revision')).rows.map(row => row.id);
    expect(ids.sort()).toEqual([activeId, 'latest-draft'].sort());
    expect(ids).not.toContain(draftId);
  });
});
