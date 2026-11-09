import { useId, type ComponentProps } from "react";
import { Select } from "@carbon/react";
/** Native-select behavior for short option lists and HTML form integrations. */
export function NativeSelect({
  id,
  size: _size,
  ...props
}: ComponentProps<"select">) {
  const generated = useId();
  return (
    <Select {...props} id={id ?? generated} labelText="" hideLabel size="md" />
  );
}
