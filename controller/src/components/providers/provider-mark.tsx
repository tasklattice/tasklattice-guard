import type { ModelProviderKind } from "@/lib/controller-api";
import { cn } from "@/lib/utils";

export function ProviderMark({ provider, kind, model, size = "md" }: { provider: string; kind: ModelProviderKind; model?: string; size?: "sm" | "md" }) {
  const identity = `${provider} ${kind} ${model ?? ""}`.toLowerCase();
  const brand = identity.includes("nvidia") || identity.includes("nemotron") || identity.includes("nemoguard")
    ? { label: "NVIDIA", src: "/assets/providers/nvidia.webp" }
    : identity.includes("qwen") || identity.includes("dashscope")
      ? { label: "Qwen", src: "/assets/providers/qwen.webp" }
      : identity.includes("deepseek")
        ? { label: "DeepSeek", src: "/assets/providers/deepseek.webp" }
        : kind === "openai"
          ? { label: "OpenAI", src: "/assets/providers/openai.webp" }
          : kind === "ollama"
            ? { label: "Ollama", src: "/assets/providers/ollama.webp" }
            : kind === "vllm"
              ? { label: "vLLM", src: "/assets/providers/vllm.webp" }
              : { label: provider, src: "/assets/providers/custom.svg" };
  return (
    <span aria-label={brand.label} title={brand.label} className={cn("block shrink-0 overflow-hidden rounded-md", size === "sm" ? "size-5" : "size-9")}>
      <img src={brand.src} alt="" className="size-full object-cover" />
    </span>
  );
}

