import { Bot } from "lucide-react";

import { providerPresets } from "@/components/providers/provider-ui-registry";
import type { PlaygroundModel } from "@/lib/api";
import { cn } from "@/lib/utils";

export function ModelMark({ model, className }: { model?: Pick<PlaygroundModel, "provider" | "icon"> | null; className?: string }) {
  if (!model) return <Bot aria-hidden="true" className={cn("size-5 shrink-0 text-muted-foreground", className)} />;
  const normalize = (value: string) => value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  // Resolve the Provider, never the model ID: NVIDIA can serve openai/gpt-oss.
  const identities = [model.icon, model.provider].map(normalize);
  const preset = identities.flatMap(identity => providerPresets.filter(item =>
    identity === item.id || identity === normalize(item.name) || (item.id === "nvidia-nim" && identity === "nvidia"),
  ))[0];
  return <img src={`/assets/providers/${preset?.icon ?? "custom.svg"}`} alt="" className={cn("size-5 shrink-0 object-contain", className)} />;
}
