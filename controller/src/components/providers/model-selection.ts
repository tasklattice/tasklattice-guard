import type { ModelDefinition, ModelProfile } from "@/lib/controller-api";
import { isLayaProfile } from "../../../shared/guardrail-catalog";

export const profiles: ModelProfile[] = [
  "generic-chat",
  "tali.qwen3guard.v1",
  "tali.llama-guard-3.v1",
  "tali.nemotron-content-safety.v1",
  "tali.nemotron-safety-guard-v3.v1",
  "tali.nemoguard-topic-control.v1",
  "tali.typesafe-jev-topic.v1",
  "tali.typesafe-jev.v1",
  "tali.laya-topic.v1",
  "tali.laya.v1",
  "tali.classifier-review.v1",
  "tali.openai-compatible-pii.v1",
  "tali.openai-compatible-jailbreak.v1",
  "tali.nemoguard-jailbreak-detect.v1",
  "tali.taxonomy-judge.v1",
  "tali.grounding-judge.v1",
  "tali.automated-reasoning.v1",
];

export function suggestedProfile(modelId: string): ModelProfile {
  const value = modelId.toLowerCase();
  if (/^(?:typesafe\/)?jev(?:-|$)/.test(value)) return "tali.typesafe-jev.v1";
  if (/^(?:laya\/)?laya(?:[-/]|$)/.test(value)) return "tali.laya.v1";
  if (value === "nvidia/nemoguard-jailbreak-detect" || value === "nemoguard-jailbreak-detect") return "tali.nemoguard-jailbreak-detect.v1";
  if (value.includes("qwen3guard") || value.includes("qwen-guard")) return "tali.qwen3guard.v1";
  if (value.includes("nemotron-safety-guard-8b-v3")) return "tali.nemotron-safety-guard-v3.v1";
  if (value.includes("nemoguard") && value.includes("topic")) return "tali.nemoguard-topic-control.v1";
  if ((value.includes("nemotron") || value.includes("nemoguard")) && value.includes("content-safety")) return "tali.nemotron-content-safety.v1";
  if (value.includes("llama-guard")) return "tali.llama-guard-3.v1";
  return "generic-chat";
}

export function displayNameForModel(modelId: string) {
  return modelId.split("/").at(-1)?.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) ?? modelId;
}

/** Only Laya models persist a request mode; it is absent or null for every other profile. */
export function isLayaModel(model: Pick<ModelDefinition, "providerKind" | "profile">) {
  return model.providerKind === "laya" || isLayaProfile(model.profile);
}

/** Localized label for a Laya request mode, including legacy rows that were never detected. */
export function layaRequestModeLabelKey(mode: ModelDefinition["layaRequestMode"]) {
  return mode === "native" ? "providerRegistration.layaRequestModeNative"
    : mode === "compatible" ? "providerRegistration.layaRequestModeCompatible"
    : "providerRegistration.layaRequestModeNotDetected";
}
