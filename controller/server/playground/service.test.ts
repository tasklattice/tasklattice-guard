import { describe, expect, it } from "vitest";

import { PlaygroundDraftPreviewStore } from "./service.js";

const candidate = {
  actorId: "admin-1",
  guardrailId: "guardrail-1",
  guardrailName: "Guardrail 1",
  draftRevision: 7,
  candidateVersion: "20260904-040000.004Z",
  plan: { guardrail_id: "guardrail-1", guardrail_version: "20260904-040000.004Z" },
  runtimeProfile: "auto",
  compilerVersion: "controller-plan-v2",
};

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
