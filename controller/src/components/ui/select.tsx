import {
  useId,
  useState,
  useRef,
  useLayoutEffect,
  type ComponentProps,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Dropdown } from "@carbon/react";
import { findSlots, textContent } from "@/components/carbon/composition";
type SlotProps = { children?: ReactNode; className?: string };
type Item = {
  value: string;
  label: ReactNode;
  text: string;
  disabled?: boolean;
};
export function Select({
  children,
  value,
  defaultValue,
  onValueChange,
  disabled,
  name,
  required,
}: SlotProps & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  name?: string;
  required?: boolean;
}) {
  const { t } = useTranslation();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const generated = useId();
  const [local, setLocal] = useState(defaultValue);
  const trigger = findSlots(children, SelectTrigger)[0]?.props ?? {};
  const placeholder = findSlots(children, SelectValue)[0]?.props.placeholder as
    string | undefined;
  const items: Item[] = findSlots(children, SelectItem).map(({ props }) => ({
    value: String(props.value),
    label: props.children as ReactNode,
    text: String(
      props.textValue ??
        (textContent(props.children as ReactNode) || props.value),
    ),
    disabled: Boolean(props.disabled),
  }));
  const selected = value ?? local;
  useLayoutEffect(() => {
    const button = buttonRef.current;
    if (!button) return;
    const description = trigger["aria-describedby"];
    if (description)
      button.setAttribute("aria-describedby", String(description));
    else button.removeAttribute("aria-describedby");
  }, [trigger["aria-describedby"]]);
  return (
    <>
      <Dropdown<Item>
        autoAlign
        ref={buttonRef}
        translateWithId={(key) =>
          t(
            key === "close.menu"
              ? "common.closeOptions"
              : "common.openOptions",
            { name: "" },
          )
        }
        id={`${String(trigger.id ?? generated)}-listbox`}
        aria-label={trigger["aria-label"] as string | undefined}
        aria-describedby={trigger["aria-describedby"] as string | undefined}
        data-testid={trigger["data-testid"] as string | undefined}
        titleText=""
        hideLabel
        label={placeholder ?? ""}
        items={items}
        selectedItem={
          items.find((item) => item.value === selected) ??
          (null as unknown as Item)
        }
        itemToString={(item) => item?.text ?? ""}
        itemToElement={(item) => (
          <span className="guard-select-option">{item.label ?? item.text}</span>
        )}
        renderSelectedItem={(item) => item.label}
        disabled={disabled}
        size={trigger.size === "sm" ? "sm" : "md"}
        className={`guard-select ${trigger.variant === "rich" ? "guard-select--rich" : ""} ${trigger.className ?? ""}`}
        invalid={
          trigger["aria-invalid"] === true || trigger["aria-invalid"] === "true"
        }
        onChange={({ selectedItem }) => {
          if (selectedItem && !selectedItem.disabled) {
            setLocal(selectedItem.value);
            onValueChange?.(selectedItem.value);
          }
        }}
        downshiftProps={{
          toggleButtonId: String(trigger.id ?? generated),
          labelId: trigger["aria-label"]
            ? undefined
            : `${String(trigger.id ?? generated)}-label`,
          isItemDisabled: (item) => Boolean(item?.disabled),
        }}
      />
      {name ? (
        <input
          type="hidden"
          name={name}
          value={selected ?? ""}
          disabled={disabled}
          required={required}
        />
      ) : null}
    </>
  );
}
/** className lays out the Carbon wrapper; field: utilities style the visible control. */
export function SelectTrigger(
  _props: ComponentProps<"button"> & { size?: "sm" | "default"; variant?: "default" | "rich" },
) {
  return null;
}
export function SelectValue(_props: SlotProps & { placeholder?: string }) {
  return null;
}
export function SelectContent(
  _props: SlotProps & { position?: string; align?: string },
) {
  return null;
}
export function SelectItem(
  _props: SlotProps & { value: string; disabled?: boolean; textValue?: string },
) {
  return null;
}
export function SelectGroup(_props: SlotProps) {
  return null;
}
export function SelectLabel(_props: SlotProps) {
  return null;
}
export function SelectSeparator() {
  return null;
}
