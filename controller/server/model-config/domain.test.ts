import { describe, expect, it } from "vitest";

import {
  assignmentTargetAcceptsModel,
  assignmentTargetProfiles,
  capabilityBindingContracts,
  controlPlaneProfiles,
  emptyModelAssignments,
  modelInputSchema,
  modelAssignmentTargetSchema,
  normalizeModelAssignments,
  profileContracts,
  profileTransports,
  providerAcceptsProfile,
} from "./domain.js";

describe("Guardrail Catalog capability binding profiles", () => {
  it("keeps Laya decision classifiers independent from TypeSafe and output models", () => {
    expect(profileTransports["tali.laya.v1"]).toBe("laya_systemone");
    for (const target of ["content_safety.input", "jailbreak.input", "topic_control.input"] as const) {
      expect(assignmentTargetAcceptsModel(target, "tali.laya.v1", "laya")).toBe(true);
      expect(capabilityBindingContracts(target, "tali.laya.v1")).toHaveLength(1);
      expect(assignmentTargetAcceptsModel(target, "tali.laya.v1", "typesafe")).toBe(false);
      expect(assignmentTargetAcceptsModel(target, "tali.typesafe-jev.v1", "laya")).toBe(false);
    }
    for (const target of ["control_plane", "content_safety.output", "pii_semantic.input", "classifier_review.input"] as const) {
      expect(assignmentTargetAcceptsModel(target, "tali.laya.v1", "laya")).toBe(false);
    }
    expect(providerAcceptsProfile("laya", "generic-chat")).toBe(false);
    expect(providerAcceptsProfile("custom-openai-compatible", "tali.laya.v1")).toBe(false);
    expect(assignmentTargetAcceptsModel("topic_control.input", "tali.laya-topic.v1", "laya")).toBe(true);
    expect(assignmentTargetAcceptsModel("jailbreak.input", "tali.laya-topic.v1", "laya")).toBe(false);
  });
  it("supports independent JEV input detectors without extending output or the topic-only contract", () => {
    const profile = "tali.typesafe-jev.v1";
    expect(profileTransports[profile]).toBe("typesafe_systemone");
    for (const [target, contract] of [["topic_control.input", "tali.guard.topic-control.semantic.v1"], ["jailbreak.input", "tali.guard.jailbreak.v1"], ["content_safety.input", "tali.guard.content-safety.v1"]] as const) {
      expect(assignmentTargetAcceptsModel(target, profile, "typesafe")).toBe(true);
      expect(capabilityBindingContracts(target, profile)).toEqual([contract]);
    }
    for (const target of ["control_plane", "content_safety.output", "pii_semantic.input"] as const) {
      expect(assignmentTargetAcceptsModel(target, profile, "typesafe")).toBe(false);
    }
    expect(providerAcceptsProfile("custom-openai-compatible", profile)).toBe(false);
    expect(providerAcceptsProfile("openai", profile)).toBe(false);
    expect(assignmentTargetAcceptsModel("jailbreak.input", "tali.typesafe-jev-topic.v1", "typesafe")).toBe(false);
  });
  it("restricts Jev to native TypeSafe input Topic Control and preserves existing choices", () => {
    const profile = "tali.typesafe-jev-topic.v1";
    expect(profileTransports[profile]).toBe("typesafe_systemone");
    expect(capabilityBindingContracts("topic_control.input", profile)).toEqual(["tali.guard.topic-control.semantic.v1"]);
    expect(assignmentTargetAcceptsModel("topic_control.input", profile, "typesafe")).toBe(true);
    for (const target of ["control_plane", "content_safety.input", "jailbreak.input", "pii_semantic.output"] as const) {
      expect(assignmentTargetAcceptsModel(target, profile, "typesafe")).toBe(false);
    }
    expect(providerAcceptsProfile("typesafe", "generic-chat")).toBe(false);
    expect(providerAcceptsProfile("openai", profile)).toBe(false);
    expect(assignmentTargetAcceptsModel("topic_control.input", "tali.nemoguard-topic-control.v1", "custom-openai-compatible")).toBe(true);
    expect(assignmentTargetAcceptsModel("topic_control.input", "tali.taxonomy-judge.v1", "custom-openai-compatible")).toBe(true);
  });
  it("assigns Nemotron Content Safety only to the content-safety detector", () => {
    const profile = "tali.nemotron-content-safety.v1";
    expect(assignmentTargetProfiles("content_safety.input")).toContain(profile);
    expect(assignmentTargetProfiles("content_safety.output")).toContain(profile);
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
    expect(assignmentTargetProfiles("jailbreak.input")).toContain(profile);
    expect(assignmentTargetProfiles("jailbreak.input")).toContain("tali.openai-compatible-jailbreak.v1");
    expect(controlPlaneProfiles).not.toContain(profile);
    expect(assignmentTargetProfiles("content_safety.input")).not.toContain(profile);
    expect(profileContracts[profile]).toEqual(["tali.guard.jailbreak.v1"]);
    expect(profileTransports[profile]).toBe("nemoguard_jailbreak_detect");
  });

  it("keeps content safety, topic control, and jailbreak independently replaceable", () => {
    expect(assignmentTargetProfiles("content_safety.input")).toContain("tali.nemotron-safety-guard-v3.v1");
    expect(assignmentTargetProfiles("topic_control.input")).toContain("tali.nemoguard-topic-control.v1");
    expect(assignmentTargetProfiles("jailbreak.input")).toContain("tali.openai-compatible-jailbreak.v1");
  });

  it("reserves DeepSeek for the Control Plane even when a Data Plane profile is supplied", () => {
    expect(assignmentTargetAcceptsModel("control_plane", "generic-chat", "deepseek")).toBe(true);
    expect(assignmentTargetAcceptsModel("topic_control.input", "tali.taxonomy-judge.v1", "deepseek")).toBe(false);
    expect(assignmentTargetAcceptsModel("content_safety.output", "tali.qwen3guard.v1", "qwen")).toBe(true);
    expect(providerAcceptsProfile("deepseek", "generic-chat")).toBe(true);
    expect(providerAcceptsProfile("deepseek", "tali.grounding-judge.v1")).toBe(false);
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

describe("capability bindings", () => {
  it("normalizes the explicit catalog shape without inferring model roles", () => {
    expect(normalizeModelAssignments({ bindings: { "content_safety.input": "safety" } })).toEqual({
      ...emptyModelAssignments(),
      bindings: { ...emptyModelAssignments().bindings, "content_safety.input": "safety" },
    });
    expect(normalizeModelAssignments({})).toEqual(emptyModelAssignments());
  });

  it("projects a multi-purpose profile into only the selected detector contract", () => {
    expect(capabilityBindingContracts("content_safety.input", "tali.qwen3guard.v1")).toEqual([
      "tali.guard.content-safety.v1",
    ]);
    expect(capabilityBindingContracts("jailbreak.input", "tali.qwen3guard.v1")).toEqual([
      "tali.guard.jailbreak.v1",
    ]);
    expect(capabilityBindingContracts("pii_semantic.output", "tali.qwen3guard.v1")).toEqual([
      "tali.guard.pii.semantic.v1",
    ]);
  });
});

it("uses one Topic Control binding and permits generic PII judges on both Rails", () => {
  expect(capabilityBindingContracts("topic_control.input", "tali.taxonomy-judge.v1")).toEqual(["tali.guard.topic-control.semantic.v1"]);
  expect(Object.keys(emptyModelAssignments().bindings).filter(id => id.startsWith("topic_control."))).toEqual(["topic_control.input"]);
  expect(assignmentTargetAcceptsModel("topic_control.input", "tali.typesafe-jev-topic.v1", "typesafe")).toBe(true);
  expect(modelAssignmentTargetSchema.safeParse("company_policy.input").success).toBe(false);
  expect(emptyModelAssignments().bindings).not.toHaveProperty("company_policy.input");
  for (const target of ["pii_semantic.input", "pii_semantic.output"] as const) {
    expect(assignmentTargetAcceptsModel(target, "tali.openai-compatible-pii.v1", "custom-openai-compatible")).toBe(true);
    expect(capabilityBindingContracts(target, "tali.openai-compatible-pii.v1")).toEqual(["tali.guard.pii.semantic.v1"]);
  }
});
