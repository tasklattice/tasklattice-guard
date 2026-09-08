import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  filterMultiSelectOptions,
  isMultiSelectOptionDisabled,
  sortMultiSelectOptions,
  type MultiSelectOption,
} from "@/components/ui/multi-select-options";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type MultiSelectComboboxProps = {
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
  showSelectedValues?: boolean;
  value: readonly string[];
};

export type { MultiSelectOption } from "@/components/ui/multi-select-options";

export function MultiSelectCombobox({
  ariaLabel,
  className,
  disabled = false,
  emptyDescription,
  emptyMessage = "No options match",
  id,
  maxSelected,
  noOptionsDescription,
  noOptionsMessage = "No options are available.",
  onValueChange,
  options,
  placeholder = "Select options…",
  searchPlaceholder = "Filter by name…",
  showSelectedValues = true,
  value,
}: MultiSelectComboboxProps) {
  const { t, i18n } = useTranslation();
  const generatedId = useId();
  const inputId = id ?? `${generatedId}-input`;
  const listboxId = `${inputId}-listbox`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const sortedOptions = useMemo(
    () => sortMultiSelectOptions(options, i18n.language),
    [i18n.language, options],
  );
  const filteredOptions = filterMultiSelectOptions(sortedOptions, query);
  const selectedOptions = value
    .map((selectedValue) => options.find((option) => option.value === selectedValue))
    .filter((option): option is MultiSelectOption => Boolean(option));
  const activeOption = filteredOptions[activeIndex];
  const selectionLimitReached = maxSelected !== undefined && value.length >= maxSelected;

  useEffect(() => setActiveIndex(0), [query]);

  const focusInput = () => inputRef.current?.focus();
  const openOptions = () => {
    if (disabled) return;
    setOpen(true);
    focusInput();
  };
  const toggleOption = (option: MultiSelectOption) => {
    if (isMultiSelectOptionDisabled(option, value, maxSelected)) return;
    const nextValue = value.includes(option.value)
      ? value.filter((selectedValue) => selectedValue !== option.value)
      : [...value, option.value];
    onValueChange(nextValue);
    setQuery("");
    setOpen(true);
  };
  const removeOption = (optionValue: string) => {
    onValueChange(value.filter((selectedValue) => selectedValue !== optionValue));
    setOpen(true);
    focusInput();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(event.key === "ArrowDown" ? 0 : Math.max(0, filteredOptions.length - 1));
        return;
      }
      if (!filteredOptions.length) return;
      setActiveIndex((current) => {
        const direction = event.key === "ArrowDown" ? 1 : -1;
        return (current + direction + filteredOptions.length) % filteredOptions.length;
      });
      return;
    }
    if (event.key === "Home" && open && filteredOptions.length) {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End" && open && filteredOptions.length) {
      event.preventDefault();
      setActiveIndex(filteredOptions.length - 1);
      return;
    }
    if (event.key === "Enter" && open && activeOption) {
      event.preventDefault();
      toggleOption(activeOption);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (showSelectedValues && event.key === "Backspace" && !query && value.length) {
      const lastValue = value.at(-1);
      if (lastValue) removeOption(lastValue);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div
          className={cn(
            "flex min-h-12 w-full cursor-text flex-wrap items-center gap-2 rounded-lg border border-input bg-card px-2.5 py-2 shadow-xs transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25",
            disabled && "cursor-not-allowed bg-muted opacity-60",
            className,
          )}
          onClick={openOptions}
        >
          {showSelectedValues && selectedOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-label={t("common.multiSelect.remove", { name: option.label })}
              className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-md border border-primary/25 bg-primary/8 py-1 pr-2 pl-3 text-xs font-medium text-primary transition-colors hover:bg-primary/12 focus-visible:outline-2 focus-visible:outline-ring"
              onClick={(event) => {
                event.stopPropagation();
                removeOption(option.value);
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <span className="truncate">{option.label}</span>
              <X className="size-3.5 shrink-0" />
            </button>
          ))}
          <span className="flex min-w-48 flex-1 items-center">
            <input
              ref={inputRef}
              id={inputId}
              role="combobox"
              aria-activedescendant={open && activeOption ? `${listboxId}-option-${activeIndex}` : undefined}
              aria-autocomplete="list"
              aria-controls={open ? listboxId : undefined}
              aria-expanded={open}
              aria-haspopup="listbox"
              aria-label={ariaLabel}
              autoComplete="off"
              className="h-8 min-w-0 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
              disabled={disabled}
              onChange={(event) => {
                setQuery(event.target.value);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={handleKeyDown}
              placeholder={selectedOptions.length ? searchPlaceholder : placeholder}
              value={query}
            />
            <button
              type="button"
              aria-controls={open ? listboxId : undefined}
              aria-expanded={open}
              aria-label={t(open ? "common.multiSelect.close" : "common.multiSelect.open", { name: ariaLabel })}
              className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed"
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation();
                if (open) setOpen(false);
                else openOptions();
              }}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              <ChevronDown className={cn("size-4 transition-transform duration-200", open && "rotate-180")} />
            </button>
          </span>
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        collisionPadding={10}
        className="flex max-h-[min(30rem,var(--radix-popover-content-available-height))] w-(--radix-popover-trigger-width) max-w-[calc(100vw-2rem)] flex-col overflow-hidden p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="flex min-h-11 items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
          <Search className="size-4 shrink-0" />
          <span aria-live="polite" className="min-w-0 flex-1">
            {selectionLimitReached
              ? t("common.multiSelect.selectedMaximum", { count: value.length, maximum: maxSelected })
              : query
                ? t("common.multiSelect.matching", { count: filteredOptions.length })
                : t("common.multiSelect.available", { count: options.length })}
          </span>
          {value.length ? (
            <button
              type="button"
              className="min-h-8 shrink-0 rounded-md px-2 font-medium text-foreground hover:bg-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => {
                onValueChange([]);
                setQuery("");
                focusInput();
              }}
            >
              {t("common.multiSelect.clearAll")}
            </button>
          ) : null}
        </div>
        <div
          id={listboxId}
          role="listbox"
          aria-label={t("common.multiSelect.options", { name: ariaLabel })}
          aria-multiselectable="true"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
        >
          {filteredOptions.length ? filteredOptions.map((option, index) => {
            const selected = value.includes(option.value);
            const active = index === activeIndex;
            const optionDisabled = isMultiSelectOptionDisabled(option, value, maxSelected);
            return (
              <button
                key={option.value}
                id={`${listboxId}-option-${index}`}
                type="button"
                role="option"
                aria-disabled={optionDisabled || undefined}
                aria-selected={selected}
                disabled={optionDisabled}
                className={cn(
                  "grid min-h-16 w-full grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 rounded-md px-3 py-2.5 text-left outline-hidden transition-colors",
                  selected && "bg-primary/5 text-foreground",
                  active && !selected && "bg-accent text-accent-foreground",
                  active && selected && "bg-primary/10",
                  optionDisabled && "cursor-not-allowed opacity-50",
                )}
                onClick={() => toggleOption(option)}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span className={cn(
                  "mt-0.5 grid size-5 place-items-center rounded-sm border",
                  selected && "border-primary bg-primary text-primary-foreground",
                )}>
                  {selected ? <Check className="size-3.5" /> : null}
                </span>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <strong className="min-w-0 flex-1 truncate text-sm font-medium">{option.label}</strong>
                    {option.meta ? <span className="max-w-full shrink-0 truncate rounded-md bg-muted px-2 py-1 font-mono text-[10px] text-muted-foreground" title={option.meta}>{option.meta}</span> : null}
                  </span>
                  {option.description ? <span className="mt-1 block line-clamp-2 text-xs leading-5 text-muted-foreground">{option.description}</span> : null}
                </span>
              </button>
            );
          }) : (
            <div className="px-4 py-8 text-center">
              <strong className="block text-sm">
                {query.trim() ? `${emptyMessage} “${query.trim()}”` : noOptionsMessage}
              </strong>
              <span className="mt-1 block text-xs text-muted-foreground">
                {query.trim()
                  ? emptyDescription ?? t("common.multiSelect.clearSearch")
                  : noOptionsDescription}
              </span>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
