import * as React from "react";
import { Button as CarbonButton } from "@carbon/react";
import { cn } from "@/lib/utils";
type Variant =
  | "default"
  | "create"
  | "edit"
  | "testing"
  | "outline"
  | "secondary"
  | "ghost"
  | "destructive"
  | "link";
type Size =
  "default" | "xs" | "sm" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg";
const kinds = {
  default: "primary",
  create: "primary",
  edit: "primary",
  testing: "primary",
  outline: "tertiary",
  secondary: "secondary",
  ghost: "ghost",
  destructive: "danger",
  link: "ghost",
} as const;
const sizes = {
  default: "md",
  xs: "xs",
  sm: "sm",
  lg: "lg",
  icon: "md",
  "icon-xs": "xs",
  "icon-sm": "sm",
  "icon-lg": "lg",
} as const;
export function buttonVariants({
  variant = "default",
  size = "default",
  className,
}: { variant?: Variant; size?: Size; className?: string } = {}) {
  return cn(
    "cds--btn",
    `cds--btn--${kinds[variant]}`,
    `cds--btn--${sizes[size]}`,
    variant === "testing" && "guard-testing-button",
    className,
  );
}
export function Button({
  variant = "default",
  size = "default",
  asChild,
  children,
  className,
  ...props
}: React.ComponentProps<"button"> & {
  variant?: Variant;
  size?: Size;
  asChild?: boolean;
}) {
  const styles = cn(
    "guard-button",
    size.startsWith("icon") && "guard-icon-button",
    variant === "link" && "guard-link-button",
    variant === "testing" && "guard-testing-button",
    className,
  );
  if (asChild && React.isValidElement<Record<string, unknown>>(children)) {
    const child = children;
    return (
      <CarbonButton
        as={child.type as React.ElementType}
        {...props}
        {...child.props}
        // Router links build their own href, including search and hash. A plain
        // `to` fallback overrides that destination when the link is clicked.
        href={child.props.href as string | undefined}
        data-slot="button"
        data-variant={variant}
        data-size={size}
        kind={kinds[variant]}
        size={sizes[size]}
        className={cn(styles, child.props.className as string)}
      />
    );
  }
  return (
    <CarbonButton
      {...props}
      type={props.type ?? "button"}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={styles}
      kind={kinds[variant]}
      size={sizes[size]}
    >
      {children}
    </CarbonButton>
  );
}
