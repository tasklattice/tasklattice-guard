import { describe, expect, it } from "vitest";

import {
  controlPlaneProfiles,
  detectorContracts,
  detectorProfiles,
  emptyModelAssignments,
  modelInputSchema,
  normalizeModelAssignments,
  profileContracts,
  profileTransports,
} from "./domain.js";

describe("Guardrail Catalog detector profiles", () => {
  it("assigns Nemotron Content Safety only to the content-safety detector", () => {
    const profile = "tali.nemotron-content-safety.v1";
    expect(detectorProfiles.content_safety).toContain(profile);
    expect(controlPlaneProfiles).not.toContain(profile);
    expect(profileContracts[profile]).toEqual(["tali.guard.content-safety.v1"]);
    expect(modelInputSchema.parse({
      providerId: "2da89935-e001-4a43-a47b-95f419666bb0",
      name: "NVIDIA Nemotron Content Safety",
      model: "nvidia/nemotron-3.5-content-safety",
      profile,
    }).profile).toBe(profile);
  });

  it("keeps interchangeable jailbreak implementations under one detector type", () => {
    const profile = "tali.nemoguard-jailbreak-detect.v1";
    expect(detectorProfiles.jailbreak_detection).toContain(profile);
    expect(detectorProfiles.jailbreak_detection).toContain("tali.openai-compatible-jailbreak.v1");
    expect(controlPlaneProfiles).not.toContain(profile);
    expect(detectorProfiles.content_safety).not.toContain(profile);
    expect(profileContracts[profile]).toEqual(["tali.guard.jailbreak.v1"]);
    expect(profileTransports[profile]).toBe("nemoguard_jailbreak_detect");
  });

  it("keeps content safety, topic control, and jailbreak independently replaceable", () => {
    expect(detectorProfiles.content_safety).toContain("tali.nemotron-safety-guard-v3.v1");
    expect(detectorProfiles.topic_control).toContain("tali.nemoguard-topic-control.v1");
    expect(detectorProfiles.jailbreak_detection).toContain("tali.openai-compatible-jailbreak.v1");
  });

  it("rejects the retired Nano model while allowing another OpenAI-compatible judge", () => {
    const base = {
      providerId: "2da89935-e001-4a43-a47b-95f419666bb0",
      name: "Jailbreak judge",
      profile: "tali.openai-compatible-jailbreak.v1",
    };
    expect(modelInputSchema.safeParse({ ...base, model: "nvidia/nvidia-nemotron-nano-9b-v2" }).success).toBe(false);
    expect(modelInputSchema.safeParse({ ...base, model: "example/jailbreak-judge" }).success).toBe(true);
  });
});

describe("detector assignments", () => {
  it("normalizes the explicit catalog shape without legacy role inference", () => {
    expect(normalizeModelAssignments({ detectors: { content_safety: "safety" } })).toEqual({
      ...emptyModelAssignments(),
      detectors: { ...emptyModelAssignments().detectors, content_safety: "safety" },
    });
    expect(normalizeModelAssignments({})).toEqual(emptyModelAssignments());
  });

  it("projects a multi-purpose profile into only the selected detector contract", () => {
    expect(detectorContracts("content_safety", "tali.qwen3guard.v1")).toEqual([
      "tali.guard.content-safety.v1",
    ]);
    expect(detectorContracts("jailbreak_detection", "tali.qwen3guard.v1")).toEqual([
      "tali.guard.jailbreak.v1",
    ]);
    expect(detectorContracts("pii_detection", "tali.qwen3guard.v1")).toEqual([
      "tali.guard.pii.semantic.v1",
    ]);
  });
});
