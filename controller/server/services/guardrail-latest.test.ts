import { describe, expect, it, vi } from "vitest";
import type { ControllerConfig } from "../config.js";
import type { ControllerDatabase } from "../db/client.js";
import { artifacts, guardrailVersions, guardrails } from "../db/schema.js";
import { ControlPlaneService } from "./control-plane.js";

const currentVersion = "20261007-010000.000Z";
const input = { guardrailId: "guard-1", version: "20261006-010000.000Z", actorId: "admin" };
function setup(target = input.version, missing = false) {
  const guardrail = { id: input.guardrailId, status: "active", latestVersion: currentVersion, latestArtifactId: "current-artifact", draftRevision: 5, draftConfig: { policies: ["draft-only"] } };
  const version = { guardrailId: input.guardrailId, version: target, status: "ready", artifactId: target === currentVersion ? "current-artifact" : "selected-artifact", plan: { frozen: true }, generation: 2 };
  const rows = [[guardrail], missing ? [] : [version]];
  const writes: Array<{ table: unknown; value: Record<string, unknown> }> = [];
  const update = vi.fn((table: unknown) => {
    const query = { set: (value: Record<string, unknown>) => { writes.push({ table, value }); return query; }, where: () => query, returning: async () => [{ desiredGeneration: 8 }] };
    return query;
  });
  const insert = vi.fn((table: unknown) => ({ values: async (value: Record<string, unknown>) => { writes.push({ table, value }); } }));
  const tx = { update, insert, select: () => {
    const query = { from: () => query, where: () => query, for: async () => rows.shift(), then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows.shift()).then(resolve) };
    return query;
  } };
  const db = { transaction: async (fn: (transaction: typeof tx) => unknown) => fn(tx) } as unknown as ControllerDatabase;
  return { service: new ControlPlaneService(db, {} as ControllerConfig), version, guardrail, writes, update, insert };
}

describe("Mark a Guardrail version active", () => {
  it.each(["20261006-010000.000Z", "20261008-010000.000Z"])("selects existing older or newer version %s without creating a release", async target => {
    const { service, version, guardrail, writes } = setup(target);
    const original = structuredClone({ version, guardrail });
    expect(await service.markGuardrailVersionLatest({ ...input, version: target })).toEqual(version);
    expect({ version, guardrail }).toEqual(original);
    expect(writes.find(write => write.table === guardrails)?.value).toMatchObject({ latestVersion: target, latestArtifactId: version.artifactId });
    expect(writes.some(write => write.table === guardrailVersions || write.table === artifacts)).toBe(false);
    expect(writes.some(write => "draftConfig" in write.value || "draftRevision" in write.value)).toBe(false);
    expect(writes.filter(write => write.value.kind === "guardrail.latest_version_marked")).toHaveLength(1);
    expect(writes.some(write => write.value.kind === "guardrail.compile_requested")).toBe(false);
  });

  it("leaves the already active version unchanged without another generation or audit event", async () => {
    const { service, version, update, insert } = setup(currentVersion);
    expect(await service.markGuardrailVersionLatest({ ...input, version: currentVersion })).toEqual(version);
    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects a missing or unready version before any write", async () => {
    const { service, update, insert } = setup(input.version, true);
    await expect(service.markGuardrailVersionLatest(input)).rejects.toMatchObject({ code: "guardrail_version_not_ready" });
    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
});
