import {
  Children,
  isValidElement,
  type ReactNode,
  type ReactElement,
} from "react";
/** Inspect application content slots without invoking components or their hooks. */
export function elements(
  children: ReactNode,
): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(children).filter(isValidElement) as ReactElement<
    Record<string, unknown>
  >[];
}
export function textContent(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      typeof child === "string" || typeof child === "number"
        ? String(child)
        : isValidElement<{ children?: ReactNode }>(child)
          ? textContent(child.props.children)
          : "",
    )
    .join(" ");
}
export function findSlots(
  children: ReactNode,
  type: unknown,
): ReactElement<Record<string, unknown>>[] {
  return elements(children).flatMap((child) =>
    child.type === type
      ? [child]
      : findSlots(child.props.children as ReactNode, type),
  );
}
