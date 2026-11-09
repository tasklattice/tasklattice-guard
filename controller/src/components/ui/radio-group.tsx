import {
  createContext,
  useContext,
  useId,
  useState,
  type ComponentProps,
} from "react";
import { RadioButtonGroup, RadioButton } from "@carbon/react";
const Context = createContext({
  value: "",
  name: "",
  change: (_value: string) => {},
});
export function RadioGroup({
  value,
  defaultValue,
  onValueChange,
  name,
  children,
  ...props
}: Omit<
  ComponentProps<typeof RadioButtonGroup>,
  "name" | "value" | "defaultValue"
> & {
  value?: string;
  defaultValue?: string;
  name?: string;
  onValueChange?: (value: string) => void;
}) {
  const generated = useId();
  const [local, setLocal] = useState(defaultValue ?? "");
  const change = (next: string) => {
    setLocal(next);
    onValueChange?.(next);
  };
  return (
    <Context.Provider
      value={{ value: value ?? local, name: name ?? generated, change }}
    >
      <RadioButtonGroup
        {...props}
        name={name ?? generated}
        valueSelected={value ?? local}
        onChange={(next) => change(String(next))}
      >
        {children}
      </RadioButtonGroup>
    </Context.Provider>
  );
}
export function RadioGroupItem({
  value,
  ...props
}: Omit<ComponentProps<typeof RadioButton>, "labelText">) {
  const context = useContext(Context);
  return (
    <RadioButton
      {...props}
      value={value}
      name={context.name}
      checked={context.value === value}
      onChange={(next) => context.change(String(next))}
      labelText=""
      hideLabel
    />
  );
}
