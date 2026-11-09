import { Tag } from "@carbon/react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
type Variant =
  "default" | "secondary" | "destructive" | "outline" | "ghost" | "link";
export function Badge({
  variant = "default",
  className,
  ...props
}: ComponentProps<"span"> & { variant?: Variant }) {
  return (
    <Tag
      {...props}
      data-slot="badge"
      data-variant={variant}
      type={
        variant === "destructive"
          ? "red"
          : variant === "default"
            ? "blue"
            : "gray"
      }
      size="sm"
      className={cn("guard-tag", className)}
    />
  );
}
