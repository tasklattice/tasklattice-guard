import { Webhook } from "lucide-react";
import type { EndpointProtocol } from "@/lib/api-types";

export function EndpointProtocolIcon({
  protocol,
  size = "default",
}: {
  protocol: EndpointProtocol;
  size?: "default" | "sm";
}) {
  const frameClassName =
    size === "sm" ? "size-7 rounded-md" : "size-10 rounded-lg";
  const iconClassName = size === "sm" ? "size-4" : "size-5";
  return (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden border border-border/80 bg-background shadow-xs ${frameClassName}`}
    >
      {protocol === "litellm" ? (
        <img
          alt=""
          src="/assets/integrations/litellm-train.webp"
          className="size-full object-cover"
        />
      ) : protocol === "a2a" ? (
        <img
          alt=""
          src="/assets/integrations/a2a-agent.png"
          className="size-full object-contain p-1"
        />
      ) : (
        <Webhook
          aria-hidden="true"
          className={`${iconClassName} text-primary`}
        />
      )}
    </span>
  );
}
