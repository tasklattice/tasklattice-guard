import { useId, type ComponentProps } from "react";
import { TextInput } from "@carbon/react";
/** className lays out the Carbon wrapper; field: utilities style the visible control. */
export function Input({
  id,
  className,
  size: _size,
  onClick,
  value,
  defaultValue,
  ...props
}: ComponentProps<"input">) {
  const generated = useId();
  return (
    <TextInput
      {...props}
      onClick={onClick as ComponentProps<typeof TextInput>["onClick"]}
      id={id ?? generated}
      data-slot="input"
      className={className}
      size="md"
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
