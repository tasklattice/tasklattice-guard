import {
  Breadcrumb as CarbonBreadcrumb,
  BreadcrumbItem as CarbonBreadcrumbItem,
  Link,
} from "@carbon/react";
import { isValidElement, type ElementType, type ComponentProps } from "react";
export function Breadcrumb(props: ComponentProps<typeof CarbonBreadcrumb>) {
  return (
    <CarbonBreadcrumb {...props} aria-label="breadcrumb" noTrailingSlash />
  );
}
export function BreadcrumbList({ children }: ComponentProps<"ol">) {
  return children;
}
export function BreadcrumbItem(
  props: ComponentProps<typeof CarbonBreadcrumbItem>,
) {
  return <CarbonBreadcrumbItem {...props} />;
}
export function BreadcrumbPage(props: ComponentProps<"span">) {
  return <span {...props} aria-current="page" />;
}
export function BreadcrumbSeparator(_props: ComponentProps<"li">) {
  return null;
}
export function BreadcrumbLink({
  asChild,
  children,
  ...props
}: ComponentProps<"a"> & { asChild?: boolean }) {
  const child =
    asChild && isValidElement<ComponentProps<"a">>(children) ? children : null;
  return child ? (
    <Link as={child.type as ElementType} {...props} {...child.props} />
  ) : (
    <Link {...props}>{children}</Link>
  );
}
