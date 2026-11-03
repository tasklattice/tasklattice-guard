import { isValidElement, useId, type ReactNode, type ComponentProps } from "react";
import { OverflowMenu, OverflowMenuItem } from "@carbon/react";
import { findSlots, textContent } from "@/components/carbon/composition";
import { cn } from "@/lib/utils";
type SlotProps = { children?: ReactNode; className?: string };
export function DropdownMenu({ children }: SlotProps) {
  const labelId = useId();
  const trigger = findSlots(children, DropdownMenuTrigger)[0];
  const content = findSlots(children, DropdownMenuContent)[0];
  const side = content?.props.side === "top" ? "top" : "bottom";
  const offset: Exclude<ComponentProps<typeof OverflowMenu>["menuOffset"], undefined> =
    (menu, direction, target, flipped) => ({
      left: (flipped ? -1 : 1) * (menu.offsetWidth - (target?.offsetWidth ?? 0)) / 2,
      top: (direction === "top" ? -1 : 1) * Number(content?.props.sideOffset ?? 8),
    });
  const child = trigger?.props.children;
  const childProps = isValidElement<Record<string, unknown>>(child)
    ? child.props
    : {};
  const label = String(
    childProps["aria-label"] ??
      (textContent(childProps.children as ReactNode) || "Actions"),
  );
  const Icon = () => (
    <span className="guard-menu-trigger-content">
      {childProps.children as ReactNode}
    </span>
  );
  return (
    <>
      {/* Keep the trigger name independent of the transient floating tooltip. */}
      <span id={labelId} className="sr-only">{label}</span>
      <OverflowMenu
        autoAlign
        align={content?.props.align === "end" ? "top-end" : "top-start"}
        aria-label={label}
        aria-labelledby={labelId}
        iconDescription={label}
        renderIcon={Icon}
        size="md"
        direction={side}
        menuOffset={offset}
        menuOffsetFlip={offset}
        flipped={content?.props.align === "end"}
        className={cn("guard-overflow-menu", childProps.className as string)}
        menuOptionsClass={cn(
          "guard-menu-options",
          content?.props.className as string,
        )}
        disabled={Boolean(childProps.disabled)}
      >
        {content?.props.children as ReactNode}
      </OverflowMenu>
    </>
  );
}
export function DropdownMenuTrigger(
  _props: ComponentProps<"button"> & { asChild?: boolean },
) {
  return null;
}
export function DropdownMenuContent(
  _props: SlotProps & {
    align?: string;
    side?: string;
    sideOffset?: number;
    onCloseAutoFocus?: (e: Event) => void;
  },
) {
  return null;
}
export function DropdownMenuItem({
  children,
  className,
  asChild,
  disabled,
  variant,
  onSelect,
  onClick,
  ...props
}: Omit<ComponentProps<typeof OverflowMenuItem>, "onSelect"> & {
  children?: ReactNode;
  asChild?: boolean;
  variant?: "default" | "edit" | "testing" | "destructive";
  onSelect?: (event: Event) => void;
}) {
  const child =
    asChild && isValidElement<Record<string, unknown>>(children)
      ? children
      : null;
  let href = child?.props.to as string | undefined;
  for (const [key, value] of Object.entries(
    (child?.props.params as Record<string, string>) ?? {},
  ))
    href = href?.replace(`$${key}`, encodeURIComponent(value));
  const search = child?.props.search as Record<string, string> | undefined;
  if (href && search) href += `?${new URLSearchParams(search).toString()}`;
  return (
    <OverflowMenuItem
      {...props}
      data-slot="dropdown-menu-item"
      className={cn(variant === "testing" && "guard-testing-menu-item", className)}
      disabled={disabled}
      isDelete={variant === "destructive"}
      href={href}
      itemText={
        <span className="guard-menu-item-content">
          {child ? (child.props.children as ReactNode) : children}
        </span>
      }
      onClick={(event) => {
        const select = new Event("select", { cancelable: true });
        onSelect?.(select);
        onClick?.(event);
        if (select.defaultPrevented) event.preventDefault();
      }}
    />
  );
}
export function DropdownMenuLabel({ children, className }: SlotProps) {
  return (
    <li role="presentation" className={cn("guard-menu-label", className)}>
      {children}
    </li>
  );
}
export function DropdownMenuSeparator() {
  return <li role="separator" className="guard-menu-separator" />;
}
