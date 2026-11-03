// @vitest-environment node
// Opt-in real PostgreSQL semantics; never calls a Provider or changes public rows.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { emptyModelAssignments } from "./domain.js";
import { ModelConfigurationService } from "./service.js";
import { runWithTenantContext } from "../services/tenant-context.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Current model configuration PostgreSQL semantics", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: Pool;
  let service: ModelConfigurationService;
  const modelId = randomUUID();
  const providerId = randomUUID();
  const directory = resolve('../runner/toolkit/policy_library/assets');

  beforeAll(async () => {
    database = await createTestDatabase(url!, "guard_model_apply", { maxConnections: 2 });
    pool = database.pool;
    await pool.query("INSERT INTO auth_user (id,name,email,role,tenant_id) SELECT id,id,id||'@example.test','admin','tenantA' FROM unnest(ARRAY['admin','synthetic-admin','admin-a','admin-b','other']) AS id");
    await pool.query("INSERT INTO auth_user (id,name,email,role,tenant_id) VALUES ('group_b','B','group_b@example.test','user','tenantB'),('group_c','C','group_c@example.test','user','tenantC')");
    await pool.query("INSERT INTO model_provider (id,name,kind,base_url,credential_ciphertext) VALUES ($1,'Synthetic','custom-openai-compatible','http://provider.invalid/v1','')", [providerId]);
    await pool.query("INSERT INTO model_definition (id,provider_id,name,model,profile) VALUES ($1,$2,'Synthetic','synthetic','tali.qwen3guard.v1')", [modelId, providerId]);
  });
  afterAll(async () => {
    await database?.drop();
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM resource_share');
    await pool.query('DELETE FROM model_definition WHERE id <> $1', [modelId]);
    await pool.query('DELETE FROM model_provider WHERE id <> $1', [providerId]);
    await pool.query('DELETE FROM model_configuration_revision');
    await pool.query('DELETE FROM model_assignment_validation');
    await pool.query('DELETE FROM controller_outbox');
    await pool.query('DELETE FROM audit_event');
    await pool.query("INSERT INTO controller_state (id,desired_generation) VALUES ('singleton',0) ON CONFLICT (id) DO UPDATE SET desired_generation=0");
    await pool.query("UPDATE model_definition SET tenant_id=NULL,name='Synthetic',profile='tali.qwen3guard.v1',max_concurrency=2 WHERE id=$1", [modelId]);
    service = new ModelConfigurationService(database.db, 'synthetic-root', directory,
      vi.fn(() => { throw new Error('No external calls allowed'); }));
    service.setRailValidator(async () => ({ passed: true, message: 'Synthetic Rail result', latencyMs: 1 }));
  });
  it("does not require models until protection actually depends on them", async () => {
    expect(await service.modelHealth([])).toEqual({ status: "healthy", reason: "not_required", bindings: [] });
    expect(await service.modelHealth(["jailbreak.input"])).toMatchObject({ status: "unhealthy",
      reason: "configuration_required", bindings: [{ id: "jailbreak.input", status: "missing" }] });
    await seedPartial();
    expect(await service.modelHealth([])).toEqual({ status: "healthy", reason: "not_required", bindings: [] });
  });

  it('isolates tenant Models, exposes global Provider metadata, and makes shared Models read-only', async () => {
    const tenantBModelId = randomUUID();
    await pool.query("UPDATE model_definition SET tenant_id='tenantA' WHERE id=$1", [modelId]);
    await pool.query("UPDATE model_provider SET credential_hint='private-key-hint',validation_message='internal connection details' WHERE id=$1", [providerId]);
    await pool.query("INSERT INTO model_definition (id,tenant_id,provider_id,name,model,profile) VALUES ($1,'tenantB',$2,'B Model','b-model','generic-chat')", [tenantBModelId, providerId]);

    const tenantAView = await runWithTenantContext({ tenantId: 'tenantA', role: 'user' }, () => service.view());
    const tenantBView = await runWithTenantContext({ tenantId: 'tenantB', role: 'user' }, () => service.view());
    expect(tenantAView.providers.map((item) => item.id)).toEqual([providerId]);
    expect(tenantAView.models.map((item) => item.id)).toEqual([modelId]);
    expect(tenantBView.providers.map((item) => item.id)).toEqual([providerId]);
    expect(tenantBView.models.map((item) => item.id)).toEqual([tenantBModelId]);
    expect(tenantBView.providers[0]).toMatchObject({ name: 'Synthetic', kind: 'custom-openai-compatible' });
    for (const field of ['credentialCiphertext', 'credentialHint', 'credentialConfigured', 'validationMessage', 'createdBy']) {
      expect(tenantBView.providers[0]).not.toHaveProperty(field);
    }
    expect(tenantBView).toMatchObject({ draft: null, active: null, activating: null, failed: null });
    for (const tenantId of ['tenantA', 'tenantB']) {
      await expect(runWithTenantContext({ tenantId, role: 'user' }, () =>
        service.updateProvider(providerId, { name: 'Changed' }, 'group_b'))).rejects.toMatchObject({ code: 'forbidden' });
      await expect(runWithTenantContext({ tenantId, role: 'user' }, () =>
        service.validateDraft('group_b'))).rejects.toMatchObject({ code: 'forbidden' });
    }
    await expect(runWithTenantContext({ tenantId: 'tenantB', role: 'user' }, () =>
      service.revalidateModel(modelId, 'group_b'))).rejects.toMatchObject({ code: 'not_found' });

    await pool.query("INSERT INTO resource_share (id,owner_tenant_id,recipient_tenant_id,resource_type,resource_id) VALUES ($1,'tenantA','tenantB','model',$2)",
      [randomUUID(), modelId]);
    const sharedView = await runWithTenantContext({ tenantId: 'tenantB', role: 'user' }, () => service.view());
    expect(new Set(sharedView.models.map((item) => item.id))).toEqual(new Set([modelId, tenantBModelId]));
    for (const mutate of [() => service.revalidateModel(modelId, 'group_b'),
      () => service.testModelConnection(modelId, 'group_b'),
      () => service.configureModel(modelId, { profile: 'generic-chat', timeoutSeconds: 20, maxTokens: 128 }, 'group_b'),
      () => service.configureConcurrency(modelId, { maxConcurrency: 4 }, 'group_b'),
      () => service.deleteModel(modelId, 'group_b')]) {
      await expect(runWithTenantContext({ tenantId: 'tenantB', role: 'user' }, mutate)).rejects.toMatchObject({ code: 'not_found' });
    }
    const owned = await runWithTenantContext({ tenantId: 'tenantB', role: 'user' }, () =>
      service.configureModel(tenantBModelId, { profile: 'generic-chat', timeoutSeconds: 45, maxTokens: 256 }, 'group_b'));
    expect(owned).toMatchObject({ tenantId: 'tenantB', timeoutSeconds: 45, maxTokens: 256 });
    expect(await runWithTenantContext({ tenantId: 'tenantB', role: 'user' }, () =>
      service.configureConcurrency(tenantBModelId, { maxConcurrency: 4 }, 'group_b')))
      .toMatchObject({ tenantId: 'tenantB', maxConcurrency: 4 });
    expect((await pool.query('SELECT max_concurrency FROM model_definition WHERE id=$1', [modelId])).rows[0].max_concurrency).toBe(2);
    await runWithTenantContext({ tenantId: 'tenantB', role: 'user' }, () => service.deleteModel(tenantBModelId, 'group_b'));
    expect((await pool.query('SELECT id FROM model_definition WHERE id=$1', [tenantBModelId])).rows).toHaveLength(0);

    await pool.query("DELETE FROM resource_share WHERE recipient_tenant_id='tenantB'");
    const revokedView = await runWithTenantContext({ tenantId: 'tenantB', role: 'user' }, () => service.view());
    expect(revokedView.providers.map((item) => item.id)).toEqual([providerId]);
    expect(revokedView.models).toEqual([]);
  });

  it('preserves global detector readiness without exposing private Model identifiers or names', async () => {
    const revisionId = await seed(true);
    const checkedAt = new Date().toISOString();
    await pool.query("UPDATE model_configuration_revision SET state='active',validation_report=$2 WHERE id=$1", [revisionId,
      { valid: true, checkedAt, checks: [{ id: `probe:content_safety.input:${modelId}`, status: 'passed', scope: 'capability', evidenceKind: 'nemo-rail-v1', message: 'Passed' }], contractCoverage: [], policies: [] }]);
    const privateReadiness = await runWithTenantContext({ tenantId: 'tenantB', role: 'user' }, () => service.readinessView());
    const privateJson = JSON.stringify(privateReadiness);
    expect(privateJson).not.toContain(modelId);
    expect(privateJson).not.toContain('Synthetic');
    const hiddenId = privateReadiness.active!.assignments.bindings['content_safety.input'];
    expect(privateReadiness.models).toContainEqual({ id: hiddenId, name: 'Configured detector' });
    expect(privateReadiness.active!.validationReport!.checks).toContainEqual({ id: `probe:content_safety.input:${hiddenId}`, status: 'passed', evidenceKind: 'nemo-rail-v1' });
    expect((await runWithTenantContext({ tenantId: 'tenantB', role: 'user' }, () => service.activeConfiguration()))!.revisionId).toBe(revisionId);

    await pool.query("INSERT INTO resource_share (id,owner_tenant_id,recipient_tenant_id,resource_type,resource_id) VALUES ($1,'tenantA','tenantB','model',$2)", [randomUUID(), modelId]);
    const sharedReadiness = await runWithTenantContext({ tenantId: 'tenantB', role: 'user' }, () => service.readinessView());
    // A stale tenant-owned grant cannot make a platform-owned Model readable.
    expect(sharedReadiness.active!.assignments.bindings['content_safety.input']).not.toBe(modelId);
    expect(JSON.stringify(sharedReadiness)).not.toContain('Synthetic');
  });

  it('lets tenants independently register and configure the same platform Model', async () => {
    const fetcher = vi.fn(async () => Response.json({ choices: [{ message: { content: 'Safe' } }] }));
    const registration = new ModelConfigurationService(database.db, 'synthetic-root', directory, fetcher);
    const input = { providerId, name: 'My detector', model: 'synthetic', profile: 'tali.qwen3guard.v1', timeoutSeconds: 20, maxTokens: 128 };
    const ownedB = await runWithTenantContext({ tenantId: 'tenantB', role: 'user' }, () => registration.createModel(input, 'group_b'));
    const ownedC = await runWithTenantContext({ tenantId: 'tenantC', role: 'user' }, () => registration.createModel(input, 'group_c'));
    expect(ownedB).toMatchObject({ tenantId: 'tenantB', model: 'synthetic', providerId, connectionStatus: 'validated' });
    expect(ownedC).toMatchObject({ tenantId: 'tenantC', model: 'synthetic', providerId, connectionStatus: 'validated' });
    expect(new Set([modelId, ownedB.id, ownedC.id]).size).toBe(3);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await pool.query('SELECT id FROM model_provider')).rows).toHaveLength(1);

    await runWithTenantContext({ tenantId: 'tenantB', role: 'user' }, () => registration.configureModel(ownedB.id,
      { profile: 'generic-chat', timeoutSeconds: 45, maxTokens: 256 }, 'group_b'));
    const other = await runWithTenantContext({ tenantId: 'tenantC', role: 'user' }, () => registration.view());
    expect(other.models).toHaveLength(1);
    expect(other.models[0]).toMatchObject({ id: ownedC.id, tenantId: 'tenantC', profile: input.profile, timeoutSeconds: 20 });
    expect((await pool.query('SELECT DISTINCT tenant_id FROM audit_event WHERE resource_id=$1', [ownedB.id])).rows)
      .toEqual([{ tenant_id: 'tenantB' }]);
    await expect(runWithTenantContext({ tenantId: 'tenantB', role: 'user' }, () => registration.deleteModel(ownedC.id, 'group_b')))
      .rejects.toMatchObject({ code: 'not_found' });
    await runWithTenantContext({ tenantId: 'tenantB', role: 'user' }, () => registration.deleteModel(ownedB.id, 'group_b'));
    expect((await pool.query('SELECT id FROM model_definition ORDER BY id')).rows.map(row => row.id).sort()).toEqual([modelId, ownedC.id].sort());
  });

  it('keeps platform Model administration and binding selection separate from tenant inventories', async () => {
    const privateId = randomUUID();
    await pool.query("INSERT INTO model_definition(id,tenant_id,provider_id,name,model,profile) VALUES ($1,'tenantB',$2,'Private B','private-b','generic-chat')", [privateId, providerId]);
    const platformView = await runWithTenantContext({ tenantId: 'tenantB', role: 'admin' }, () => service.view());
    expect(platformView.models.map(model => model.id)).toEqual([modelId]);
    expect(platformView.models[0]).toMatchObject({ tenantId: null, protocolEditable: true });
    const tenantView = await runWithTenantContext({ tenantId: 'tenantB', role: 'user' }, () => service.view());
    expect(tenantView.models.map(model => model.id)).toEqual([privateId]);
    for (const mutate of [() => service.revalidateModel(privateId, 'admin'),
      () => service.testModelConnection(privateId, 'admin'),
      () => service.configureModel(privateId, { profile: 'generic-chat', timeoutSeconds: 20, maxTokens: 128 }, 'admin'),
      () => service.configureConcurrency(privateId, { maxConcurrency: 4 }, 'admin'),
      () => service.deleteModel(privateId, 'admin')]) {
      await expect(runWithTenantContext({ tenantId: 'tenantB', role: 'admin' }, mutate)).rejects.toMatchObject({ code: 'not_found' });
    }
    await seed();
    await expect(service.previewAssignment('control_plane', privateId, 'admin')).rejects.toMatchObject({ code: 'not_found' });
    const assignments = { ...emptyModelAssignments(), controlPlane: privateId };
    await expect(service.updateDraft(assignments, 'admin')).rejects.toThrow('Assigned Models were not found');
    expect((await pool.query('SELECT tenant_id,model FROM model_definition WHERE id=$1', [privateId])).rows[0])
      .toMatchObject({ tenant_id: 'tenantB', model: 'private-b' });
  });

  it('uses global detector and chat configurations independently of tenant revision rows', async () => {
    const activeId = await seed(true);
    await pool.query("UPDATE model_configuration_revision SET state='active',generation=1 WHERE id=$1", [activeId]);
    const tenantAssignments = emptyModelAssignments();
    const tenantModelId = randomUUID();
    tenantAssignments.bindings['content_safety.input'] = tenantModelId;
    await pool.query("INSERT INTO model_definition(id,tenant_id,provider_id,name,model,profile) VALUES ($1,'tenantB',$2,'Private B','private-b','generic-chat')", [tenantModelId, providerId]);
    await pool.query("INSERT INTO model_configuration_revision(id,tenant_id,revision,generation,state,assignments) VALUES ($1,'tenantB',99,99,'active',$2)", [randomUUID(), tenantAssignments]);
    const active = await runWithTenantContext({ tenantId: 'tenantB', role: 'user' }, () => service.activeConfiguration());
    expect(active!.revisionId).toBe(activeId);
    expect(active!.assignments.bindings['content_safety.input']).toBe(modelId);
    const readiness = await runWithTenantContext({ tenantId: 'tenantB', role: 'user' }, () => service.readinessView());
    expect(JSON.stringify(readiness)).not.toContain(tenantModelId);
    expect(JSON.stringify(readiness)).not.toContain('private-b');

    await pool.query("UPDATE model_definition SET profile='generic-chat' WHERE id=$1", [modelId]);
    const globalChat = { ...emptyModelAssignments(), controlPlane: modelId };
    const report = { valid: true, checkedAt: new Date().toISOString(), checks: [{ id: `probe:control_plane:${modelId}`, status: 'passed', scope: 'control_plane', message: 'Passed' }], contractCoverage: [], policies: [] };
    await pool.query("INSERT INTO model_configuration_revision(id,tenant_id,revision,state,assignments,validation_report) VALUES ($1,'tenantA',2,'validated',$2,$3)", [randomUUID(), globalChat, report]);
    await pool.query("INSERT INTO model_configuration_revision(id,tenant_id,revision,state,assignments,validation_report) VALUES ($1,'tenantB',100,'validated',$2,$3)", [randomUUID(), { ...emptyModelAssignments(), controlPlane: tenantModelId },
      { ...report, checks: [{ ...report.checks[0], id: `probe:control_plane:${tenantModelId}` }] }]);
    expect(await runWithTenantContext({ tenantId: 'tenantB', role: 'user' }, () => service.controlPlaneModel('playground_chat')))
      .toMatchObject({ model: 'synthetic', provider: 'Synthetic' });
    expect(await runWithTenantContext({ tenantId: 'tenantB', role: 'user' }, () => service.statusSummary()))
      .toMatchObject({ controlPlane: { status: 'configured', model: 'Configured control-plane model' },
        dataPlane: { models: [expect.objectContaining({ model: 'Configured detector' })] } });
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
  it('defaults migrated models to two and distributes operational concurrency changes without rewriting active evidence', async () => {
    const { activeId } = await seedPartial();
    expect((await pool.query('SELECT max_concurrency FROM model_definition WHERE id=$1', [modelId])).rows[0].max_concurrency).toBe(2);
    const before = (await pool.query('SELECT assignments,validation_report FROM model_configuration_revision WHERE id=$1', [activeId])).rows[0];
    expect((await service.activeConfiguration())?.models[0]?.maxConcurrency).toBe(2);
    expect((await service.configureConcurrency(modelId, { maxConcurrency: 4 }, 'admin')).maxConcurrency).toBe(4);
    expect((await service.activeConfiguration())?.models[0]?.maxConcurrency).toBe(4);
    expect((await pool.query('SELECT assignments,validation_report FROM model_configuration_revision WHERE id=$1', [activeId])).rows[0]).toEqual(before);
    expect(Number((await pool.query('SELECT desired_generation FROM controller_state')).rows[0].desired_generation)).toBe(1);
    expect((await pool.query('SELECT kind,payload FROM controller_outbox')).rows).toEqual([
      { kind: 'runner.desired_state_changed', payload: { resourceType: 'model_definition', modelId, generation: 1 } },
    ]);
    expect((await pool.query("SELECT detail FROM audit_event WHERE kind='model_definition.concurrency_updated'")).rows[0].detail)
      .toEqual({ previousMaxConcurrency: 2, maxConcurrency: 4 });
  });
  it('requires formal policy examples and passes them to the scoped Runner validation', async () => {
    await seed();
    await pool.query("UPDATE model_definition SET profile='tali.automated-reasoning.v1' WHERE id=$1", [modelId]);
    const validator = vi.fn(async () => ({ passed: true, message: 'Synthetic contract proof', latencyMs: 1 }));
    service.setRailValidator(validator);
    await expect(service.previewAssignment('automated_reasoning.output', modelId, 'admin')).rejects.toThrow();
    expect(validator).not.toHaveBeenCalled();
    const formalValidation = { policyId: 'warranty', policyVersion: '3', confidenceThreshold: 0.8, query: 'Warranty?', validResponse: 'One year.', invalidResponse: 'Ten years.' };
    const receipt = await service.previewAssignment('automated_reasoning.output', modelId, 'admin', formalValidation);
    expect(validator).toHaveBeenCalledWith(expect.objectContaining({ formalValidation, bindingId: 'automated_reasoning.output' }));
    const draft = await service.updateAssignment('automated_reasoning.output', modelId, 'admin', receipt.validationId);
    expect(draft.assignments.bindings['automated_reasoning.output']).toBe(modelId);
  });
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
    })).rejects.toMatchObject({ code: kind === 'unready' ? 'validation_failed' : 'model_configuration_changed' });
    expect(Number((await pool.query('SELECT desired_generation FROM controller_state')).rows[0].desired_generation)).toBe(0);
    expect((await pool.query('SELECT id FROM controller_outbox')).rows).toHaveLength(0);
  });
  it.each(["failed", "not_tested"])("activates %s model bindings without changing their test results", async status => {
    const draftId = await seed(true);
    if (status === "failed") {
      service.setRailValidator(async () => ({ passed: false, message: "Model API returned 429", latencyMs: 1 }));
      const receipt = await service.previewAssignment("content_safety.input", modelId, "synthetic-admin");
      await service.updateAssignment("content_safety.input", modelId, "synthetic-admin", receipt.validationId);
    }
    const result = await service.applyConfiguration("synthetic-admin", await review());
    expect(result.validationReport?.valid).toBe(false);
    await service.finalizeActivation(result.id);
    expect((await service.activeConfiguration())?.assignments.bindings["content_safety.input"]).toBe(modelId);
    expect(await service.modelHealth([])).toEqual({ status: "healthy", reason: "not_required", bindings: [] });
    expect(await service.modelHealth(["content_safety.input"])).toMatchObject({ status: "unhealthy", bindings: [{ status }] });
    if (status === "failed") {
      expect((await service.view()).active?.validationReport?.checks).toContainEqual(expect.objectContaining({ status: "failed", message: "Model API returned 429" }));
      service.setRailValidator(async () => ({ passed: true, message: "Recovered", latencyMs: 1 }));
      await service.validateAssignment("content_safety.input", "synthetic-admin");
      expect((await service.modelHealth(["content_safety.input"])).status).toBe("healthy");
    }
    expect((await pool.query("SELECT detail FROM audit_event WHERE kind='model_configuration.activation_started'")).rows[0].detail.validationPassed).toBe(false);
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
    const peer = new ModelConfigurationService(database.db, 'synthetic-root', directory);
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
    const chat = new ModelConfigurationService(database.db, 'synthetic-root', directory,
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

});
