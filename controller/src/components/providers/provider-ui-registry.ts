import type { ModelProviderKind, ProviderConnectionDraft } from "@/lib/controller-api";

// Ported from Relay's provider-ui-registry. Only expose protocols supported by
// Guard; NVIDIA NIM uses Guard's existing OpenAI-compatible transport.
export const providerPresets = [
  { id: "openai", name: "OpenAI", kind: "openai", category: "popular", endpoint: "https://api.openai.com/v1", icon: "openai.webp", keyRequired: true },
  { id: "deepseek", name: "DeepSeek", kind: "deepseek", category: "chinese", endpoint: "https://api.deepseek.com/v1", icon: "deepseek.webp", keyRequired: true },
  { id: "qwen", name: "Qwen", kind: "qwen", category: "chinese", endpoint: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", icon: "qwen.webp", keyRequired: true },
  { id: "nvidia-nim", name: "NVIDIA NIM", kind: "custom-openai-compatible", category: "infrastructure", endpoint: "https://integrate.api.nvidia.com/v1", icon: "nvidia.webp", keyRequired: true },
  { id: "ollama", name: "Ollama", kind: "ollama", category: "selfHosted", endpoint: "http://host.docker.internal:11434/v1", icon: "ollama.webp", keyRequired: false },
  { id: "vllm", name: "vLLM", kind: "vllm", category: "selfHosted", endpoint: "http://host.docker.internal:8000/v1", icon: "vllm.webp", keyRequired: false },
  { id: "custom-openai-compatible", name: "Custom OpenAI-compatible", kind: "custom-openai-compatible", category: "selfHosted", endpoint: "", icon: "custom.svg", keyRequired: false },
] as const satisfies readonly { id: string; name: string; kind: ModelProviderKind; category: string; endpoint: string; icon: string; keyRequired: boolean }[];

export type ProviderPresetId = (typeof providerPresets)[number]["id"];
export const providerCategories = ["popular", "chinese", "infrastructure", "selfHosted"] as const;

export function createProviderDraft(id: ProviderPresetId): ProviderConnectionDraft {
  const preset = providerPresets.find((item) => item.id === id)!;
  return { name: preset.name, kind: preset.kind, baseUrl: preset.endpoint, apiKey: "" };
}
