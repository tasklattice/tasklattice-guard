import { describe, expect, it } from "vitest";

import {
  assignmentTargetAcceptsModel,
  assignmentTargetProfiles,
  assignmentInputSchema,
  capabilityBindingContracts,
  controlPlaneProfiles,
  emptyModelAssignments,
  modelInputSchema,
  modelAssignmentTargetSchema,
  normalizeModelAssignments,
  profileContracts,
  profileTransports,
  providerAcceptsProfile,
  resolveLayaRequestMode,
} from "./domain.js";

describe("Laya request mode resolution", () => {
  it("uses the compatible request shape until a remote Laya connection probe selects a mode", () => {
    expect(resolveLayaRequestMode("tali.laya.v1", null)).toBe("compatible");
    expect(resolveLayaRequestMode("tali.laya-topic.v1", undefined)).toBe("compatible");
    expect(resolveLayaRequestMode("tali.laya.v1", "native")).toBe("native");
    expect(resolveLayaRequestMode("tali.laya.v1", "compatible")).toBe("compatible");
    for (const profile of ["generic-chat", "tali.typesafe-jev.v1", "tali.qwen3guard.v1"] as const) {
      expect(resolveLayaRequestMode(profile, "native")).toBeUndefined();
    }
  });
});

describe("Protection Capabilities capability binding profiles", () => {
  it("supports Laya output content safety while keeping its other contracts scoped", () => {
    expect(profileTransports["tali.laya.v1"]).toBe("laya_systemone");
    for (const target of ["content_safety.input", "content_safety.output", "jailbreak.input", "topic_control.input",
      "pii_semantic.input", "pii_semantic.output"] as const) {
      expect(assignmentTargetAcceptsModel(target, "tali.laya.v1", "laya")).toBe(true);
      expect(capabilityBindingContracts(target, "tali.laya.v1")).toHaveLength(1);
      expect(assignmentTargetAcceptsModel(target, "tali.laya.v1", "typesafe")).toBe(false);
      expect(assignmentTargetAcceptsModel(target, "tali.typesafe-jev.v1", "laya")).toBe(false);
    }
    for (const target of ["control_plane", "classifier_review.content_safety.input", "classifier_review.content_safety.output"] as const) {
      expect(assignmentTargetAcceptsModel(target, "tali.laya.v1", "laya")).toBe(false);
    }
    expect(providerAcceptsProfile("laya", "generic-chat")).toBe(false);
    expect(providerAcceptsProfile("custom-openai-compatible", "tali.laya.v1")).toBe(false);
    expect(assignmentTargetAcceptsModel("topic_control.input", "tali.laya-topic.v1", "laya")).toBe(true);
    expect(assignmentTargetAcceptsModel("jailbreak.input", "tali.laya-topic.v1", "laya")).toBe(false);
  });
  it("allows an OpenAI-compatible chat model to serve the grounding judge", () => {
    expect(providerAcceptsProfile("deepseek", "tali.grounding-judge.v1")).toBe(true);
    expect(assignmentTargetAcceptsModel("contextual_grounding.output", "tali.grounding-judge.v1", "deepseek")).toBe(true);
    expect(providerAcceptsProfile("openai", "tali.automated-reasoning.v1")).toBe(true);
    expect(assignmentTargetAcceptsModel("automated_reasoning.output", "tali.automated-reasoning.v1", "openai")).toBe(true);
  });
  it("supports JEV input/output content safety while keeping its other contracts scoped", () => {
    const profile = "tali.typesafe-jev.v1";
    expect(profileTransports[profile]).toBe("typesafe_systemone");
    for (const [target, contract] of [["topic_control.input", "tali.guard.topic-control.semantic.v1"], ["jailbreak.input", "tali.guard.jailbreak.v1"], ["content_safety.input", "tali.guard.content-safety.v1"], ["content_safety.output", "tali.guard.content-safety.v1"], ["pii_semantic.input", "tali.guard.pii.semantic.v1"], ["pii_semantic.output", "tali.guard.pii.semantic.v1"]] as const) {
      expect(assignmentTargetAcceptsModel(target, profile, "typesafe")).toBe(true);
      expect(capabilityBindingContracts(target, profile)).toEqual([contract]);
    }
    for (const target of ["control_plane", "classifier_review.content_safety.output"] as const) {
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

  it("reuses DeepSeek chat for explicit input review while preserving primary detector contracts", () => {
    expect(assignmentTargetAcceptsModel("control_plane", "generic-chat", "deepseek")).toBe(true);
    for (const profile of ["generic-chat", "tali.classifier-review.v1"] as const) {
      expect(assignmentTargetAcceptsModel("classifier_review.content_safety.input", profile, "deepseek")).toBe(true);
      expect(assignmentTargetAcceptsModel("classifier_review.content_safety.input", profile, "custom-openai-compatible")).toBe(true);
      expect(capabilityBindingContracts("classifier_review.content_safety.input", profile)).toEqual(["tali.guard.classifier-review.v1"]);
      expect(providerAcceptsProfile("deepseek", profile)).toBe(true);
      expect(assignmentTargetAcceptsModel("classifier_review.content_safety.output", profile, "deepseek")).toBe(true);
      for (const target of Object.keys(emptyModelAssignments().bindings).filter(id => !id.startsWith("classifier_review."))) {
        expect(assignmentTargetAcceptsModel(target as Parameters<typeof assignmentTargetAcceptsModel>[0], profile, "deepseek")).toBe(false);
      }
    }
    for (const target of ["classifier_review.content_safety.input", "classifier_review.content_safety.output"] as const) {
      expect(assignmentTargetAcceptsModel(target, "tali.qwen3guard.v1", "qwen")).toBe(true);
      expect(assignmentTargetAcceptsModel(target, "tali.qwen3guard.v1", "custom-openai-compatible")).toBe(true);
      expect(capabilityBindingContracts(target, "tali.qwen3guard.v1")).toEqual(["tali.guard.classifier-review.v1"]);
    }
    expect(assignmentTargetAcceptsModel("classifier_review.content_safety.input", "tali.typesafe-jev.v1", "typesafe")).toBe(false);
    expect(assignmentTargetAcceptsModel("topic_control.input", "tali.taxonomy-judge.v1", "deepseek")).toBe(false);
    expect(assignmentTargetAcceptsModel("content_safety.output", "tali.qwen3guard.v1", "qwen")).toBe(true);
    expect(providerAcceptsProfile("deepseek", "generic-chat")).toBe(true);
    // Generic chat models may serve the grounding judge; see
    // "feat(models): allow chat grounding judge".
    expect(providerAcceptsProfile("deepseek", "tali.grounding-judge.v1")).toBe(true);
  });

  it("allows DeepSeek PII on both rails only with the explicit PII protocol", () => {
    const profile = "tali.openai-compatible-pii.v1";
    expect(providerAcceptsProfile("deepseek", profile)).toBe(true);
    expect(profileTransports[profile]).toBe("openai_chat");
    for (const target of ["pii_semantic.input", "pii_semantic.output"] as const) {
      expect(assignmentTargetAcceptsModel(target, profile, "deepseek")).toBe(true);
      expect(capabilityBindingContracts(target, profile)).toEqual(["tali.guard.pii.semantic.v1"]);
      expect(assignmentTargetAcceptsModel(target, "generic-chat", "deepseek")).toBe(false);
    }
    for (const target of ["classifier_review.content_safety.input", "content_safety.input", "jailbreak.input", "topic_control.input", "control_plane"] as const) {
      expect(assignmentTargetAcceptsModel(target, profile, "deepseek")).toBe(false);
    }
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
  it("migrates legacy stage reviewers to security capabilities and leaves Topic unassigned", () => {
    const input = "f6b9f056-f61b-4ae8-9e27-abca498ae9e3";
    const output = "4feebaf7-2fb7-4c82-8a99-bf0554aa211d";
    const migrated = assignmentInputSchema.parse({controlPlane:null, bindings:{
      ...Object.fromEntries(Object.entries(emptyModelAssignments().bindings).filter(([id]) => !id.startsWith("classifier_review."))),
      "classifier_review.input":input, "classifier_review.output":output,
      "classifier_review.pii_semantic.input":null,
    }});
    expect(migrated.bindings).toMatchObject({
      "classifier_review.content_safety.input":input,
      "classifier_review.content_safety.output":output,
      "classifier_review.jailbreak.input":input,
      "classifier_review.pii_semantic.input":null,
      "classifier_review.pii_semantic.output":output,
      "classifier_review.topic_control.input":null,
    });
    expect(migrated.bindings).not.toHaveProperty("classifier_review.input");
    expect(modelAssignmentTargetSchema.safeParse("classifier_review.input").success).toBe(false);
    expect(assignmentInputSchema.safeParse({controlPlane:null,bindings:{}}).success).toBe(false);
  });

  it("allows Qwen3Guard only for security reviews and chat profiles for Topic review", () => {
    const topic = "classifier_review.topic_control.input";
    for (const profile of ["generic-chat", "tali.classifier-review.v1"] as const) {
      expect(assignmentTargetAcceptsModel(topic, profile, "custom-openai-compatible")).toBe(true);
      expect(assignmentTargetAcceptsModel(topic, profile, "deepseek")).toBe(true);
    }
    expect(assignmentTargetAcceptsModel(topic, "tali.qwen3guard.v1", "qwen")).toBe(false);
    expect(assignmentTargetAcceptsModel(topic, "tali.laya.v1", "laya")).toBe(false);
    for (const target of ["classifier_review.jailbreak.input", "classifier_review.pii_semantic.input", "classifier_review.pii_semantic.output"] as const) {
      expect(assignmentTargetAcceptsModel(target, "tali.qwen3guard.v1", "qwen")).toBe(true);
      expect(capabilityBindingContracts(target, "tali.qwen3guard.v1")).toEqual(["tali.guard.classifier-review.v1"]);
    }
  });

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
