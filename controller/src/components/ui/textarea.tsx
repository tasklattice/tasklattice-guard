import { useId, type ComponentProps } from "react";
import { TextArea } from "@carbon/react";
/** className lays out the Carbon wrapper; field: utilities style the visible control. */
export function Textarea({
  id,
  value,
  defaultValue,
  ...props
}: ComponentProps<"textarea">) {
  const generated = useId();
  return (
    <TextArea
      {...props}
      id={id ?? generated}
      data-slot="textarea"
      labelText=""
      hideLabel
      value={value as string | number | undefined}
      defaultValue={defaultValue as string | number | undefined}
      invalid={
        props["aria-invalid"] === true || props["aria-invalid"] === "true"
      }
    />
  );
}
