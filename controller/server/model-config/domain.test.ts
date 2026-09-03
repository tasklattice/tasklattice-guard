import { describe, expect, it } from "vitest";

import { assignmentContracts, emptyModelAssignments, modelInputSchema, normalizeModelAssignments, profileContracts, roleProfiles } from "./domain.js";


describe("Nemotron Content Safety profile", () => {
  it("is assignable only to the data-plane content-safety contract", () => {
    const profile = "tali.nemotron-content-safety.v1";
    expect(roleProfiles.safety_evaluator).toContain(profile);
    expect(roleProfiles.control_plane).not.toContain(profile);
    expect(profileContracts[profile]).toEqual(["tali.guard.content-safety.v1"]);
    expect(modelInputSchema.parse({
      providerId: "2da89935-e001-4a43-a47b-95f419666bb0",
      name: "NVIDIA Nemotron Content Safety",
      model: "nvidia/nemotron-3.5-content-safety",
      profile,
    }).profile).toBe(profile);
  });
});

describe("legacy NVIDIA model trio", () => {
  it("keeps content safety, topic control, and jailbreak as independent replaceable slots", () => {
    expect(roleProfiles.safety_evaluator).toContain("tali.nemotron-safety-guard-v3.v1");
    expect(roleProfiles.topic_policy_judge).toContain("tali.nemoguard-topic-control.v1");
    expect(roleProfiles.jailbreak_evaluator).toContain("tali.nemotron-nano-jailbreak.v1");
    expect(profileContracts["tali.nemotron-safety-guard-v3.v1"]).toEqual(["tali.guard.content-safety.v1"]);
    expect(profileContracts["tali.nemoguard-topic-control.v1"]).toEqual([
      "tali.guard.topic-control.semantic.v1",
      "tali.guard.company-policy.v1",
    ]);
    expect(profileContracts["tali.nemotron-nano-jailbreak.v1"]).toEqual(["tali.guard.jailbreak.v1"]);
  });

  it("adds the new jailbreak slot to revisions created before the role existed", () => {
    expect(normalizeModelAssignments({ safety_evaluator: "safety" })).toEqual({
      ...emptyModelAssignments(),
      safety_evaluator: "safety",
    });
  });

  it("migrates either legacy control-plane assignment into the single control-plane slot", () => {
    expect(normalizeModelAssignments({ policy_authoring: "authoring", playground_chat: "chat" })).toEqual({
      ...emptyModelAssignments(),
      control_plane: "authoring",
    });
    expect(normalizeModelAssignments({ playground_chat: "chat" })).toEqual({
      ...emptyModelAssignments(),
      control_plane: "chat",
    });
  });

  it("lets a dedicated jailbreak assignment override Qwen's bundled jailbreak contract", () => {
    const assignments = {
      ...emptyModelAssignments(),
      safety_evaluator: "qwen",
      jailbreak_evaluator: "nano",
    };
    expect(assignmentContracts("safety_evaluator", "tali.qwen3guard.v1", assignments)).toEqual([
      "tali.guard.content-safety.v1",
      "tali.guard.pii.semantic.v1",
    ]);
    expect(assignmentContracts("jailbreak_evaluator", "tali.nemotron-nano-jailbreak.v1", assignments)).toEqual([
      "tali.guard.jailbreak.v1",
    ]);
  });
});
