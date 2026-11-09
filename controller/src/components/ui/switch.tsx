import { useId, type ComponentProps } from "react";
import { Toggle } from "@carbon/react";
type Props = Omit<ComponentProps<typeof Toggle>, "id" | "onToggle" | "size"> & {
  id?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  size?: "sm" | "default";
};
export function Switch({
  id,
  checked,
  defaultChecked,
  onCheckedChange,
  size = "default",
  ...props
}: Props) {
  const generated = useId();
  return (
    <Toggle
      {...props}
      id={id ?? generated}
      data-slot="switch"
      labelText=""
      labelA=""
      labelB=""
      hideLabel
      size={size === "sm" ? "sm" : "md"}
      toggled={checked}
      defaultToggled={defaultChecked}
      onToggle={onCheckedChange}
    />
  );
}
