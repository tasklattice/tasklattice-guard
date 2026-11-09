import {
  cloneElement,
  isValidElement,
  useId,
  type ReactNode,
  type ComponentProps,
} from "react";
import {
  Tooltip as CarbonTooltip,
  Popover,
  PopoverContent,
} from "@carbon/react";
import { findSlots } from "@/components/carbon/composition";
export function TooltipProvider({
  children,
}: {
  children?: ReactNode;
  delayDuration?: number;
}) {
  return children;
}
export function Tooltip({
  children,
  open,
  onOpenChange,
}: {
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
}) {
  const id = useId();
  const trigger = findSlots(children, TooltipTrigger)[0];
  const content = findSlots(children, TooltipContent)[0];
  const child = trigger?.props.children;
  if (!isValidElement<ComponentProps<"button">>(child)) return null;
  if (content?.props.hidden) return child;
  const align = (content?.props.side ?? "top") as
    "top" | "bottom" | "left" | "right";
  if (open !== undefined)
    return (
      <Popover
        open={open}
        align={align}
        autoAlign
        highContrast
        onKeyDown={(e) => {
          if (e.key === "Escape") onOpenChange?.(false);
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) onOpenChange?.(false);
        }}
      >
        {cloneElement(child, {
          "aria-describedby": open ? id : undefined,
          onFocus: (e) => {
            child.props.onFocus?.(e);
            onOpenChange?.(true);
          },
          onMouseEnter: (e) => {
            child.props.onMouseEnter?.(e);
            onOpenChange?.(true);
          },
          onMouseLeave: (e) => {
            child.props.onMouseLeave?.(e);
            onOpenChange?.(false);
          },
        })}
        {open ? (
          <PopoverContent id={id} role="tooltip" aria-hidden={!open}>
            {content?.props.children as ReactNode}
          </PopoverContent>
        ) : null}
      </Popover>
    );
  return (
    <CarbonTooltip
      description={content?.props.children as ReactNode}
      align={align}
      enterDelayMs={200}
      autoAlign
    >
      {child}
    </CarbonTooltip>
  );
}
export function TooltipTrigger(
  _props: ComponentProps<"button"> & { asChild?: boolean },
) {
  return null;
}
export function TooltipContent(_props: {
  children?: ReactNode;
  className?: string;
  side?: string;
  align?: string;
  sideOffset?: number;
  hidden?: boolean;
  collisionPadding?: number;
}) {
  return null;
}
