import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ControllerDatabase } from "../db/client.js";
import { controllerState, outboxEvents, modelConfigurationRevisions, modelDefinitions, modelProviders, policyVersions } from "../db/schema.js";
import { emptyModelAssignments } from "./domain.js";
import { ModelConfigurationService } from "./service.js";
import { jailbreakDetectAttackInput, jailbreakDetectProfile, jailbreakDetectSafeInput } from "./jailbreak-detect.js";

const id = "7471c0eb-a533-449a-8814-98c3bc23aa98";
const input = { profile: "tali.qwen3guard.v1", timeoutSeconds: 30, maxTokens: 512 };

// Single-model repository double: exercises service contracts without a live
// database or Provider. DB locking/transaction semantics need integration QA.
function setup(state = "draft", assigned = false, failProbe = false) {
  const empty = emptyModelAssignments();
  const assignments = assigned
    ? { ...empty, bindings: { ...empty.bindings, "content_safety.input": id, "jailbreak.input": id } }
    : empty;
  const rows = new Map<unknown, Array<Record<string, unknown>>>([
    [modelProviders, [{ id: "provider-1", name: "Mock", kind: "custom-openai-compatible", baseUrl: "https://provider.test/v1", credentialCiphertext: null }]],
    [modelDefinitions, [{ id, providerId: "provider-1", name: "Guard alias", model: "guard-alias", ...input, status: "pending", validatedAt: null }]],
    [modelConfigurationRevisions, [{ id: "revision-1", revision: 1, state, assignments, rowVersion: "synthetic-tx-1" }]],
  ]);
  const query = (table: unknown) => {
    const result = rows.get(table) ?? [];
    const promise = Promise.resolve(result);
    return Object.assign(promise, { where: () => query(table), orderBy: () => query(table), limit: () => promise });
  };
  const tx = {
    execute: vi.fn(async () => {}),
    select: () => ({ from: query }),
    update: vi.fn((table: unknown) => ({ set: (patch: Record<string, unknown>) => ({ where: () => {
      const updated = (rows.get(table) ?? []).map((row) => ({ ...row, ...patch }));
      rows.set(table, updated);
      return Object.assign(Promise.resolve(updated), { returning: async () => updated });
    } }) })),
    insert: vi.fn(() => ({ values: vi.fn(async () => {}) })),
  };
  const db = { ...tx, transaction: async (run: (value: typeof tx) => unknown) => run(tx) };
  const fetcher = vi.fn(async () => failProbe ? new Response("Unavailable", { status: 503 }) : Response.json({ choices: [{ message: { content: "Safety: Safe\nCategories: None" } }] }));
  const service = new ModelConfigurationService(db as unknown as ControllerDatabase, "test-root-secret", resolve("../runner/toolkit/policy_library/assets"), fetcher);
  const railValidator = vi.fn(async () => ({ passed: !failProbe, message: failProbe ? "Runner Rail case failed." : "Runner safe and unsafe cases passed.", latencyMs: 12 }));
  service.setRailValidator(railValidator);
  return { service, rows, tx, fetcher, railValidator };
}

describe("Capability configuration after registration", () => {
  it("requires a successful preview before saving and preserves the evidence", async () => {
    const { service, rows } = setup();
    await expect(service.updateAssignment("content_safety.input", id, "admin"))
      .rejects.toMatchObject({ code: "model_assignment_not_validated" });
    const before = structuredClone(rows.get(modelConfigurationRevisions));
    await service.previewAssignment("content_safety.input", id, "admin");
    expect(rows.get(modelConfigurationRevisions)).toEqual(before);
    const saved = await service.updateAssignment("content_safety.input", id, "admin");
    expect(saved.validationReport?.checks).toContainEqual(expect.objectContaining({
      id: `probe:content_safety.input:${id}`, status: "passed", evidenceKind: "nemo-rail-v1",
    }));
  });

  it("rejects failed previews and changes to the validated model", async () => {
    const { service, rows, railValidator } = setup();
    railValidator.mockResolvedValueOnce({ passed: false, message: "Failed", latencyMs: 1 });
    await service.previewAssignment("content_safety.input", id, "admin");
    await expect(service.updateAssignment("content_safety.input", id, "admin"))
      .rejects.toMatchObject({ code: "model_assignment_not_validated" });
    await service.previewAssignment("content_safety.input", id, "admin");
    rows.get(modelDefinitions)![0]!.model = "changed-model";
    await expect(service.updateAssignment("content_safety.input", id, "admin"))
      .rejects.toMatchObject({ code: "model_assignment_not_validated" });
  });

  it("makes Chat available only after validated Save without activating Runner", async () => {
    const { service, rows, railValidator } = setup();
    rows.get(modelDefinitions)![0]!.profile = "generic-chat";
    const active = vi.spyOn(service, "activeConfiguration");
    expect(await service.controlPlaneModel("playground_chat")).toBeNull();
    await service.previewAssignment("control_plane", id, "admin");
    expect(await service.controlPlaneModel("playground_chat")).toBeNull();
    await service.updateAssignment("control_plane", id, "admin");
    expect(await service.controlPlaneModel("playground_chat")).toMatchObject({ model: "guard-alias" });
    expect(await service.controlPlaneModel("policy_authoring")).toMatchObject({ model: "guard-alias" });
    expect(active).not.toHaveBeenCalled();
    expect(railValidator).not.toHaveBeenCalled();
    expect(rows.get(modelConfigurationRevisions)![0]!.state).not.toBe("active");
  });

  it("keeps undeclared custom dependencies unknown in the actual setup report", async () => {
    const { service, rows, fetcher, railValidator } = setup();
    rows.set(policyVersions, [
      { policyId: "custom-local-claim", version: 1, snapshot: { name: "Custom local claim", evaluation_contracts: [],
        rail_bindings: [{ rail_type: "input" }] } },
      { policyId: "custom-model", version: 1, snapshot: { name: "Custom model", evaluation_contracts: ["tali.guard.content-safety.v1"],
        rail_bindings: [{ rail_type: "output" }] } },
    ]);
    const report = (await service.validateDraft("admin")).validationReport!;
    expect(report.valid).toBe(true); // Empty model setup is valid, not proof that every Policy can run.
    expect(report.policies.find(item => item.id === "custom-local-claim"))
      .toMatchObject({ status: "unknown", dependenciesComplete: false, missingContracts: [] });
    expect(report.policies.find(item => item.id === "custom-model"))
      .toMatchObject({ status: "blocked", dependenciesComplete: false, missingContracts: ["output:tali.guard.content-safety.v1"] });
    expect(fetcher).not.toHaveBeenCalled();
    expect(railValidator).not.toHaveBeenCalled();
  });
  it("leases only the candidate Provider credential and revokes it after Rail validation", async () => {
    const { service, fetcher } = setup("draft", true);
    let leaseId = "";
    service.setRailValidator(async (request) => {
      leaseId = request.credentialLeaseId!;
      expect(request.bindingId).toBe("content_safety.input");
      expect(request.configuration?.bindings?.[0]?.railType).toBe("RAIL_TYPE_INPUT");
      expect(await service.resolveCredentials(["provider-1"], leaseId)).toEqual({ "provider-1": "" });
      expect(await service.resolveCredentials(["other-provider"], leaseId)).toEqual({});
      return { passed: true, message: "Rail samples passed.", latencyMs: 1 };
    });
    const revision = await service.validateAssignment("content_safety.input", "admin");
    expect(await service.resolveCredentials(["provider-1"], leaseId)).toEqual({});
    expect(fetcher).not.toHaveBeenCalled();
    expect(revision.validationReport?.checks).toContainEqual(expect.objectContaining({ evidenceKind: "nemo-rail-v1", status: "passed" }));
  });

  it("never substitutes a Controller model probe when the Runner validation fails", async () => {
    const { service, fetcher } = setup("draft", true);
    service.setRailValidator(async () => { throw new Error("Runner disconnected"); });
    const revision = await service.validateAssignment("content_safety.input", "admin");
    expect(revision.validationReport?.valid).toBe(false);
    expect(revision.validationReport?.checks).toContainEqual(expect.objectContaining({ evidenceKind: "nemo-rail-v1", status: "failed" }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps classifier call health independent of paired jailbreak capability checks", async () => {
    const { service, rows, fetcher } = setup();
    Object.assign(rows.get(modelDefinitions)![0]!, { model: "nvidia/nemoguard-jailbreak-detect", profile: jailbreakDetectProfile });
    rows.get(modelProviders)![0]!.skipTlsVerify = true;
    fetcher.mockImplementation(async () => Response.json({ jailbreak: true, score: 0.99 }));
    const before = structuredClone(rows.get(modelConfigurationRevisions));
    expect((await service.testModelConnection(id, "admin")).connectionStatus).toBe("validated");
    expect(rows.get(modelConfigurationRevisions)).toEqual(before);
    expect(fetcher).toHaveBeenCalledWith("https://provider.test/v1/classify", expect.objectContaining({
      method: "POST", body: JSON.stringify({ input: jailbreakDetectSafeInput }), dispatcher: expect.anything(),
    }));
    const rejected = await service.revalidateModel(id, "admin");
    expect(rejected).toMatchObject({ status: "failed", connectionStatus: "validated" });
    expect(rejected.validationMessage).toContain("benign validation sample");
    fetcher.mockResolvedValueOnce(Response.json({ jailbreak: false, score: 0.01 }))
      .mockResolvedValueOnce(Response.json({ jailbreak: true, score: 0.99 }));
    expect((await service.revalidateModel(id, "admin")).status).toBe("validated");
  });

  it("rejects a classifier that always returns safe, without changing its successful call result", async () => {
    const { service, rows, fetcher } = setup();
    Object.assign(rows.get(modelDefinitions)![0]!, { profile: jailbreakDetectProfile, connectionStatus: "validated" });
    fetcher.mockImplementation(async () => Response.json({ jailbreak: false, score: 0.01 }));
    const result = await service.revalidateModel(id, "admin");
    expect(result).toMatchObject({ status: "failed", connectionStatus: "validated" });
    expect(result.validationMessage).toContain("did not detect");
    expect(result.validationMessage).toContain("score 0.01");
    expect(jailbreakDetectAttackInput.length).toBeGreaterThan(500);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps chat-model callability separate from paired jailbreak behavior validation", async () => {
    const { service, rows, fetcher } = setup();
    Object.assign(rows.get(modelDefinitions)![0]!, {
      model: "example/jailbreak-judge",
      profile: "tali.openai-compatible-jailbreak.v1",
      connectionStatus: "validated",
    });
    fetcher.mockResolvedValue(Response.json({ choices: [{ message: { content: "OK" } }] }));
    expect((await service.testModelConnection(id, "admin")).connectionStatus).toBe("validated");
    expect((await service.revalidateModel(id, "admin")).status).toBe("failed");

    fetcher.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "SAFE" } }] }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "JAILBREAK" } }] }));
    expect((await service.revalidateModel(id, "admin")).status).toBe("validated");
    const requests = fetcher.mock.calls.slice(-2).map(([, init]) => JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> });
    expect(requests[0]!.messages.at(-1)!.content).toContain(jailbreakDetectSafeInput);
    expect(requests[1]!.messages.at(-1)!.content).not.toContain(jailbreakDetectSafeInput);
  });

  it("validates and publishes the new implementation under the existing jailbreak contract", async () => {
    const { service, rows, fetcher } = setup();
    Object.assign(rows.get(modelDefinitions)![0]!, { profile: jailbreakDetectProfile });
    const empty = emptyModelAssignments();
    await service.updateDraft({ ...empty, bindings: { ...empty.bindings, "jailbreak.input": id } }, "admin");
    fetcher.mockResolvedValueOnce(Response.json({ jailbreak: false, score: 0.01 }))
      .mockResolvedValueOnce(Response.json({ jailbreak: true, score: 0.99 }));
    const revision = await service.validateDraft("admin");
    expect(revision.validationReport?.valid).toBe(true);
    expect(revision.validationReport?.contractCoverage).toContainEqual({ contract: "tali.guard.jailbreak.v1", source: "model", modelId: id, bindingId: "jailbreak.input", railType: "input" });
    rows.get(modelConfigurationRevisions)![0]!.state = "active";
    expect((await service.activeConfiguration())?.models[0]).toMatchObject({ profile: jailbreakDetectProfile, baseUrl: "https://provider.test/v1" });
  });

  it.each([{}, { jailbreak: "false", score: 0.1 }, { jailbreak: false }, { jailbreak: false, score: -1.01 }, { jailbreak: true, score: 2 }])("rejects malformed native classifier responses: %j", async (payload) => {
    const { service, rows, fetcher } = setup();
    rows.get(modelDefinitions)![0]!.profile = jailbreakDetectProfile;
    fetcher.mockImplementation(async () => Response.json(payload));
    expect((await service.testModelConnection(id, "admin")).connectionStatus).toBe("failed");
  });

  it("accepts a negative score from the native classifier for a safe request", async () => {
    const { service, rows, fetcher } = setup();
    rows.get(modelDefinitions)![0]!.profile = jailbreakDetectProfile;
    fetcher.mockResolvedValue(Response.json({ jailbreak: false, score: -0.99 }));
    expect((await service.testModelConnection(id, "admin")).connectionStatus).toBe("validated");
  });

  it.each([401, 410, 500])("reports classifier HTTP %s without converting failure to safe", async (status) => {
    const { service, rows, fetcher } = setup();
    rows.get(modelDefinitions)![0]!.profile = jailbreakDetectProfile;
    fetcher.mockResolvedValue(new Response("Upstream error", { status }));
    expect((await service.testModelConnection(id, "admin")).connectionMessage).toContain(`HTTP ${status}`);
  });

  it("records classifier timeouts and allows retry", async () => {
    const { service, rows, fetcher } = setup();
    rows.get(modelDefinitions)![0]!.profile = jailbreakDetectProfile;
    fetcher.mockRejectedValueOnce(new DOMException("Request timed out", "TimeoutError"))
      .mockResolvedValueOnce(Response.json({ jailbreak: false, score: 0.01 }));
    expect((await service.testModelConnection(id, "admin")).connectionStatus).toBe("failed");
    expect((await service.testModelConnection(id, "admin")).connectionStatus).toBe("validated");
  });

  it("stores model-call health separately from capability outcomes and assignments", async () => {
    const { service, rows, fetcher } = setup("draft", true);
    fetcher.mockImplementation(async () => Response.json({ choices: [{ message: { content: "OK" } }] }));
    const before = structuredClone(rows.get(modelConfigurationRevisions));
    const called = await service.testModelConnection(id, "admin");
    expect(called).toMatchObject({ connectionStatus: "validated", status: "pending", validatedAt: null });
    expect(rows.get(modelConfigurationRevisions)).toEqual(before);
    const validated = await service.revalidateModel(id, "admin");
    expect(validated.status).toBe("failed");
    expect(validated.validationMessage).toContain("Safety label");
    expect(validated.connectionStatus).toBe("validated");
  });

  it.each([
    [401, "Unauthorized"], [404, "Model not found"], [503, "Unavailable"],
  ])("keeps HTTP %s errors visible without altering capability validation", async (status, body) => {
    const { service, rows, fetcher } = setup("validated", true);
    rows.get(modelDefinitions)![0]!.status = "validated";
    fetcher.mockResolvedValue(new Response(String(body), { status: Number(status) }));
    const result = await service.testModelConnection(id, "admin");
    expect(result).toMatchObject({ connectionStatus: "failed", status: "validated", connectionCheckedAt: expect.any(Date) });
    expect(result.connectionMessage).toContain(`HTTP ${status}`);
    expect(rows.get(modelConfigurationRevisions)?.[0]?.state).toBe("validated");
  });

  it.each([{}, { choices: [{ message: { content: "" } }] }])("does not report HTTP 200 with an invalid or empty response as callable", async (payload) => {
    const { service, fetcher } = setup();
    fetcher.mockResolvedValue(Response.json(payload));
    expect((await service.testModelConnection(id, "admin")).connectionStatus).toBe("failed");
  });

  it("records timeouts and permits a successful retry", async () => {
    const { service, fetcher } = setup();
    fetcher.mockRejectedValueOnce(new DOMException("Request timed out", "TimeoutError"));
    expect((await service.testModelConnection(id, "admin")).connectionMessage).toContain("timed out");
    expect((await service.testModelConnection(id, "admin")).connectionStatus).toBe("validated");
  });
  it("forwards the saved Provider TLS choice to capability probes and active runtimes", async () => {
    const { service, rows, fetcher } = setup("active", true);
    rows.get(modelProviders)![0]!.skipTlsVerify = true;
    await service.revalidateModel(id, "admin");
    expect(fetcher).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ dispatcher: expect.anything() }));
    expect((await service.activeConfiguration())?.models[0]?.skipTlsVerify).toBe(true);
  });

  it("invalidates old probe evidence and publishes a Runner reload when TLS changes", async () => {
    const { service, rows, fetcher, tx } = setup("validated", true);
    rows.set(controllerState, [{ id: "singleton", desiredGeneration: 9 }]);
    fetcher.mockResolvedValue(Response.json({ choices: [{ message: { content: "OK" } }] }));
    const updated = await service.updateProvider("provider-1", { skipTlsVerify: true }, "admin");
    expect(updated.skipTlsVerify).toBe(true);
    expect(rows.get(modelDefinitions)?.[0]).toMatchObject({ status: "pending", validatedAt: null });
    expect(rows.get(modelDefinitions)?.[0]).toMatchObject({ connectionStatus: "validated", connectionCheckedAt: expect.any(Date) });
    expect(rows.get(modelConfigurationRevisions)?.[0]).toMatchObject({ state: "draft", validationReport: null });
    expect(tx.insert).toHaveBeenCalledWith(outboxEvents);
    expect(tx.update).toHaveBeenCalledWith(controllerState);
    expect(fetcher).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ dispatcher: expect.anything() }));
  });

  it("derives Provider health from a real registered Model call", async () => {
    const { service, rows, fetcher } = setup();
    fetcher.mockResolvedValue(new Response(JSON.stringify({ status: 401, title: "Unauthorized" }), { status: 401 }));

    const result = await service.revalidateProvider("provider-1", "admin");

    expect(result).toMatchObject({ status: "failed", validationMessage: expect.stringContaining("HTTP 401") });
    expect(rows.get(modelDefinitions)?.[0]).toMatchObject({ connectionStatus: "failed", connectionMessage: expect.stringContaining("HTTP 401") });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://provider.test/v1/chat/completions");
  });

  it("configures an unused alias without invoking it and resets old probe evidence", async () => {
    const { service, fetcher, tx } = setup();
    const result = await service.configureModel(id, input, "admin");
    expect(result).toMatchObject({ id, ...input, status: "pending", validatedAt: null, validationLatencyMs: null });
    expect(fetcher).not.toHaveBeenCalled();
    expect(tx.execute).toHaveBeenCalledOnce();
  });

  it.each(["draft", "validated", "activating", "active", "superseded"])("preserves protocols referenced by a %s revision", async (state) => {
    const { service, tx, fetcher } = setup(state, true);
    await expect(service.configureModel(id, { ...input, profile: "generic-chat" }, "admin")).rejects.toThrow("cannot be changed");
    expect(tx.update).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([false, true])("validates a pending model in Capabilities and publishes accurate probe evidence (failure=%s)", async (failed) => {
    const { service, rows, fetcher, railValidator } = setup("draft", true, failed);
    const revision = await service.validateDraft("admin");
    expect(revision.validationReport?.valid).toBe(!failed);
    expect(rows.get(modelDefinitions)?.[0]).toMatchObject({ status: failed ? "failed" : "validated", validatedAt: expect.any(Date) });
    // Sharing a model must not reuse evidence between different Rail bindings.
    expect(fetcher).not.toHaveBeenCalled();
    expect(railValidator).toHaveBeenCalledTimes(2);
    expect(revision.validationReport?.checks.filter((check) => check.scope === "capability")).toHaveLength(2);
  });

  it("assigns a registered but unvalidated model to multiple capabilities before probing", async () => {
    const { service, fetcher, railValidator } = setup();
    const empty = emptyModelAssignments();
    const draft = await service.updateDraft({ ...empty, bindings: { ...empty.bindings, "content_safety.input": id, "jailbreak.input": id } }, "admin");
    expect(draft.assignments.bindings).toMatchObject({ "content_safety.input": id, "jailbreak.input": id });
    expect(draft.state).toBe("draft");
    expect(fetcher).not.toHaveBeenCalled();
    expect((await service.validateDraft("admin")).validationReport?.valid).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    expect(railValidator).toHaveBeenCalledTimes(2);
  });

  it("saves and validates capability assignments independently", async () => {
    const { service, fetcher, railValidator } = setup("draft", true);
    await service.previewAssignment("content_safety.input", id, "admin");
    railValidator.mockClear();
    const saved = await service.updateAssignment("content_safety.input", id, "admin");
    expect(saved.assignments.bindings["content_safety.input"]).toBe(id);
    expect(fetcher).not.toHaveBeenCalled();

    const first = await service.validateAssignment("content_safety.input", "admin");
    expect(railValidator).toHaveBeenCalledOnce();
    expect(first.validationReport?.checks).toContainEqual(expect.objectContaining({ id: `probe:content_safety.input:${id}`, status: "passed" }));
    expect(first.validationReport?.checks.some((check) => check.id.startsWith("probe:jailbreak.input:"))).toBe(false);
    expect(first.validationReport?.valid).toBe(false);

    const second = await service.validateAssignment("jailbreak.input", "admin");
    expect(railValidator).toHaveBeenCalledTimes(2);
    expect(second.validationReport?.checks).toContainEqual(expect.objectContaining({ id: `probe:content_safety.input:${id}`, status: "passed" }));
    expect(second.validationReport?.checks).toContainEqual(expect.objectContaining({ id: `probe:jailbreak.input:${id}`, status: "passed" }));
    expect(second.validationReport?.valid).toBe(true);
  });
});
