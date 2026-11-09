import { useId, type ComponentProps } from "react";
import { Checkbox as CarbonCheckbox } from "@carbon/react";
type Props = Omit<
  ComponentProps<"input">,
  "type" | "checked" | "onChange" | "onClick"
> & {
  checked?: boolean | "indeterminate";
  onCheckedChange?: (checked: boolean) => void;
  onChange?: ComponentProps<"input">["onChange"];
  onClick?: ComponentProps<typeof CarbonCheckbox>["onClick"];
};
export function Checkbox({
  id,
  checked,
  onCheckedChange,
  onChange,
  className,
  ...props
}: Props) {
  const generated = useId();
  return (
    <CarbonCheckbox
      {...props}
      className={`guard-checkbox ${className ?? ""}`}
      id={id ?? generated}
      data-slot="checkbox"
      labelText=""
      hideLabel
      checked={checked === "indeterminate" ? false : checked}
      indeterminate={checked === "indeterminate"}
      onChange={(event, { checked }) => {
        onChange?.(event);
        onCheckedChange?.(checked);
      }}
    />
  );
}
