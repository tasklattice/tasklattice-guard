import { useCallback, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ComboBox, FilterableMultiSelect, DismissibleTag } from "@carbon/react";
import { useTranslation } from "react-i18next";
import {
  filterMultiSelectOptions,
  sortMultiSelectOptions,
  isMultiSelectOptionDisabled,
  type MultiSelectOption,
} from "./multi-select-options";
import "./multi-select-combobox.scss";
export type { MultiSelectOption } from "./multi-select-options";
export type MultiSelectComboboxProps = {
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  emptyDescription?: string;
  emptyMessage?: string;
  id?: string;
  maxSelected?: number;
  noOptionsDescription?: string;
  noOptionsMessage?: string;
  onValueChange: (value: string[]) => void;
  options: readonly MultiSelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  selectionMode?: "multiple" | "single";
  value: readonly string[];
};
export function MultiSelectCombobox({
  ariaLabel,
  className,
  disabled,
  id,
  maxSelected,
  onValueChange,
  options,
  placeholder,
  searchPlaceholder,
  selectionMode = "multiple",
  value,
  emptyMessage,
  noOptionsMessage,
  noOptionsDescription,
}: MultiSelectComboboxProps) {
  const generated = useId();
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState("");
  const [selectionHost, setSelectionHost] = useState<Element | null>(null);
  // Carbon has no selected-item renderer for FilterableMultiSelect. Mount the
  // native tags in its field, retaining its search, listbox and keyboard logic.
  const attachSelectionHost = useCallback((element: HTMLDivElement | null) => {
    setSelectionHost(element?.querySelector(".cds--list-box__field") ?? null);
  }, []);
  const items = useMemo(
    () =>
      sortMultiSelectOptions(options, i18n.language).map((item) => ({
        ...item,
        disabled: isMultiSelectOptionDisabled(
          item,
          value,
          selectionMode === "single" ? undefined : maxSelected,
        ),
      })),
    [options, value, maxSelected, selectionMode, i18n.language],
  );
  const selected = value.flatMap((id) => items.filter((item) => item.value === id));
  const render = (item: MultiSelectOption) => (
    <span className="guard-option">
      <span>
        {item.label}
        {item.meta ? <small className="font-mono">{item.meta}</small> : null}
      </span>
      {item.description ? <small>{item.description}</small> : null}
    </span>
  );
  const helper = !items.length
    ? (noOptionsDescription ?? noOptionsMessage)
    : query && !filterMultiSelectOptions(items, query).length
      ? (emptyMessage ?? t("common.multiSelect.clearSearch"))
      : maxSelected !== undefined && value.length >= maxSelected
        ? t("common.multiSelect.selectedMaximum", {
            count: value.length,
            maximum: maxSelected,
          })
        : undefined;
  const translate = (key: string) =>
    key === "clear.all"
      ? t("common.multiSelect.clearAll")
      : key === "clear.selection"
        ? t("common.multiSelect.clearAll")
        : t(
            key === "close.menu"
              ? "common.multiSelect.close"
              : "common.multiSelect.open",
            { name: ariaLabel },
          );
  return (
    <div className={className} onKeyDownCapture={(event) => {
      if (selectionMode !== "multiple" || disabled || !(event.target instanceof HTMLInputElement)) return;
      if (!event.target.value && (event.key === "Backspace" || event.key === "Delete")) {
        // Carbon clears the whole selection here; named tags remove one at a time.
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Backspace" && value.length) onValueChange(value.slice(0, -1));
      }
    }}>
      {selectionMode === "single" ? (
        <ComboBox<MultiSelectOption>
          autoAlign
          id={id ?? generated}
          aria-label={ariaLabel}
          titleText=""
          placeholder={placeholder}
          disabled={disabled}
          items={items}
          selectedItem={selected[0] ?? null}
          itemToString={(item) => item?.label ?? ""}
          itemToElement={render}
          shouldFilterItem={({ item, inputValue }) =>
            Boolean(filterMultiSelectOptions([item], inputValue ?? "").length)
          }
          downshiftProps={{ isItemDisabled: (item) => Boolean(item?.disabled) }}
          onInputChange={setQuery}
          onChange={({ selectedItem }) =>
            onValueChange(selectedItem ? [selectedItem.value] : [])
          }
          helperText={helper}
          size="md"
          translateWithId={translate}
        />
      ) : (
        <FilterableMultiSelect<MultiSelectOption>
          ref={attachSelectionHost}
          className="guard-multi-select"
          autoAlign
          id={id ?? generated}
          titleText={ariaLabel}
          clearSelectionText={t("common.multiSelect.removeLast")}
          hideLabel
          inputProps={{ "aria-label": ariaLabel }}
          placeholder={selected.length ? (searchPlaceholder ?? placeholder) : placeholder}
          disabled={disabled}
          items={items}
          selectedItems={selected}
          itemToString={(item) => item?.label ?? ""}
          itemToElement={render}
          filterItems={(all, { inputValue }) =>
            filterMultiSelectOptions(all, inputValue ?? "")
          }
          onInputValueChange={({ inputValue }) => setQuery(inputValue ?? "")}
          onChange={({ selectedItems }) =>
            onValueChange(selectedItems.map((item) => item.value))
          }
          helperText={helper}
          size="md"
          selectionFeedback="fixed"
          translateWithId={translate}
        />
      )}
      {selectionMode === "multiple" && selectionHost && createPortal(
        <div className="guard-multi-select__values">
          {selected.map((item) => (
            <DismissibleTag
              key={item.value}
              className="guard-multi-select__value"
              type="gray"
              size="sm"
              disabled={disabled}
              text={item.label}
              title={t("common.multiSelect.remove", { name: item.label })}
              onClose={() => {
                onValueChange(value.filter((v) => v !== item.value));
                selectionHost.querySelector("input")?.focus();
              }}
            />
          ))}
        </div>, selectionHost,
      )}
    </div>
  );
}
