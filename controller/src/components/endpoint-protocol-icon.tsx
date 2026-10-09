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
      ) : (
        <img
          alt=""
          src="/assets/integrations/f5.ico"
          className="size-full object-contain p-1"
        />
      )}
    </span>
  );
}
