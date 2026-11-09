import { SkeletonPlaceholder } from "@carbon/react";
import type { ComponentProps } from "react";
export function Skeleton(props: ComponentProps<typeof SkeletonPlaceholder>) {
  return <SkeletonPlaceholder {...props} />;
}
