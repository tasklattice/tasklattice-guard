import { ProgressBar } from "@carbon/react";
import type { ComponentProps } from "react";
export function Progress({
  value,
  max = 100,
  className,
  indicatorClassName: _indicator,
  ...props
}: ComponentProps<"div"> & {
  value?: number | null;
  max?: number;
  indicatorClassName?: string;
}) {
  return (
    <ProgressBar
      {...props}
      className={className}
      label={props["aria-label"] ?? "Progress"}
      hideLabel
      size="small"
      value={value ?? undefined}
      max={max}
    />
  );
}
