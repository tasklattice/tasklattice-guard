import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
// TaskLattice account initials: a product identity element, not a second widget library.
export function Avatar({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="avatar"
      className={cn(
        "inline-flex size-8 shrink-0 overflow-hidden bg-muted",
        className,
      )}
      {...props}
    />
  );
}
export function AvatarFallback({
  className,
  ...props
}: ComponentProps<"span">) {
  return (
    <span
      data-slot="avatar-fallback"
      className={cn(
        "flex size-full items-center justify-center text-xs font-semibold",
        className,
      )}
      {...props}
    />
  );
}
