import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
export function Label({
  className,
  htmlFor,
  id,
  ...props
}: ComponentProps<"label">) {
  return (
    <label
      htmlFor={htmlFor}
      id={id ?? (htmlFor ? `${htmlFor}-label` : undefined)}
      data-slot="label"
      className={cn("cds--label", className)}
      {...props}
    />
  );
}
