import type { ModelProfile } from "@/lib/controller-api";

export const profiles: ModelProfile[] = [
  "generic-chat",
  "tali.qwen3guard.v1",
  "tali.llama-guard-3.v1",
  "tali.nemotron-content-safety.v1",
  "tali.nemotron-safety-guard-v3.v1",
  "tali.nemoguard-topic-control.v1",
  "tali.openai-compatible-jailbreak.v1",
  "tali.nemoguard-jailbreak-detect.v1",
  "tali.taxonomy-judge.v1",
  "tali.grounding-judge.v1",
  "tali.automated-reasoning.v1",
];

export function suggestedProfile(modelId: string): ModelProfile {
  const value = modelId.toLowerCase();
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
