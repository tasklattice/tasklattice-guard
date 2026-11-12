import { describe, expect, it } from "vitest";

import { PlaygroundDraftPreviewStore, RunnerPlaygroundClient } from "./service.js";

const candidate = {
  actorId: "admin-1",
  allocation: { poolId: "pool-1", groupId: "group-1", runtimeUrl: "http://pool-1" },
  guardrailId: "guardrail-1",
  guardrailName: "Guardrail 1",
  draftRevision: 7,
  candidateVersion: "20260904-040000.004Z",
  plan: { guardrail_id: "guardrail-1", guardrail_version: "20260904-040000.004Z" },
  runtimeProfile: "auto",
  compilerVersion: "controller-plan-v1",
};

it("reports an incompatible historical Artifact as a version conflict", async () => {
  const runner = new RunnerPlaygroundClient({ baseUrl: "http://runner", token: "test",
    fetcher: async () => Response.json({ detail: "incompatible" }, { status: 409 }) });
  await expect(runner.evaluate({ guardrailId: "g", target: { kind: "published", version: candidate.candidateVersion,
    artifact: "signed-artifact" }, phase: "input", text: "hello", callId: "playground:test", history: [] }))
    .rejects.toMatchObject({ status: 409, code: "playground_artifact_incompatible" });
});

describe("PlaygroundDraftPreviewStore", () => {
  it("binds a preview to its administrator and preserves the draft revision", () => {
    const store = new PlaygroundDraftPreviewStore();
    const preview = store.create(candidate);

    expect(store.get(preview.previewId, "admin-1")).toMatchObject({
      guardrailId: "guardrail-1",
      draftRevision: 7,
      candidateVersion: "20260904-040000.004Z",
    });
    expect(() => store.get(preview.previewId, "admin-2")).toThrow(/expired/i);
  });

  it("expires previews at the configured TTL", () => {
    const store = new PlaygroundDraftPreviewStore(0);
    const preview = store.create(candidate);
    expect(() => store.get(preview.previewId, "admin-1")).toThrow(/expired/i);
  });
});
