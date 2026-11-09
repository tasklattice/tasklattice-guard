import { useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { providerCategories, providerPresets, type ProviderPresetId } from "./provider-ui-registry";
import "./provider-picker.scss";

// Keep the categorized catalog: categories are navigation, not item descriptions.
export function ProviderPicker({ value, disabled, onChange }: {
  value?: ProviderPresetId;
  disabled?: boolean;
  onChange: (value: ProviderPresetId) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(-1);
  const selected = providerPresets.find(item => item.id === value);
  const visible = providerCategories.flatMap(category => providerPresets.filter(item => item.category === category &&
    `${item.name} ${t(`providerRegistration.descriptions.${item.id}`)} ${t(`providerRegistration.categories.${category}`)}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  const close = () => { setOpen(false); setSearch(""); setActive(-1); };
  const choose = (preset: ProviderPresetId) => { onChange(preset); close(); input.current?.focus(); };
  const expanded = open && !disabled;
  const move = (index: number) => {
    if (!visible.length) return;
    const next = (index + visible.length) % visible.length;
    setActive(next);
    document.getElementById(`${id}-${visible[next]!.id}`)?.scrollIntoView?.({ block: "nearest" });
  };
  return <div className="provider-catalog-picker" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) close();
  }} onKeyDown={event => {
    if (disabled) return;
    if (event.key === "Escape" && expanded) { event.preventDefault(); event.stopPropagation(); close(); }
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault(); setOpen(true); move(event.key === "ArrowDown" ? active + 1 : active < 0 ? visible.length - 1 : active - 1);
    }
    if (event.key === "Enter" && expanded) {
      event.preventDefault();
      if (active >= 0 && visible[active]) choose(visible[active].id);
    }
  }}>
    <div className="provider-catalog-field">
      <Input ref={input} id="provider-picker" role="combobox" aria-label={t("modelSettings.selectProvider")}
        aria-expanded={expanded} aria-controls={`${id}-catalog`} aria-autocomplete="list" aria-haspopup="listbox"
        aria-activedescendant={expanded && active >= 0 && visible[active] ? `${id}-${visible[active].id}` : undefined}
        disabled={disabled} autoComplete="off" placeholder={t("modelSettings.selectProvider")}
        value={expanded ? search : selected?.name ?? ""}
        onClick={() => setOpen(true)} onChange={event => { setSearch(event.target.value); setActive(-1); setOpen(true); }} />
      <button type="button" disabled={disabled} tabIndex={-1} aria-label={t(expanded ? "common.closeOptions" : "common.openOptions")}
        onMouseDown={event => event.preventDefault()} onClick={() => { if (expanded) close(); else setOpen(true); input.current?.focus(); }}>
        <ChevronDown size={16} aria-hidden="true" className={expanded ? "is-open" : undefined} />
      </button>
    </div>
    {expanded && <div className="provider-catalog-popup">
      <div className="provider-catalog-heading"><span>{t("providerRegistration.providerCatalog")}</span><span>{t("providerRegistration.shown", { count: visible.length })}</span></div>
      <div id={`${id}-catalog`} role="listbox" aria-label={t("providerRegistration.providerCatalog")} className="provider-catalog-groups">
        {providerCategories.map(category => {
          const items = visible.filter(item => item.category === category);
          return items.length ? <section key={category} role="group" aria-labelledby={`${id}-${category}`}>
            <h3 id={`${id}-${category}`}>{t(`providerRegistration.categories.${category}`)}</h3>
            <div className="provider-catalog-options">{items.map(item => <div key={item.id} id={`${id}-${item.id}`} role="option" aria-selected={value === item.id}
              className="provider-catalog-option" data-highlighted={visible[active]?.id === item.id || undefined}
              onMouseDown={event => event.preventDefault()} onClick={() => choose(item.id)} onMouseEnter={() => setActive(visible.indexOf(item))}>
              <img src={`/assets/providers/${item.icon}`} alt="" />
              <span><strong>{item.name}</strong><small>{t(`providerRegistration.descriptions.${item.id}`)}</small></span>
              {value === item.id && <Check size={16} aria-hidden="true" />}
            </div>)}</div>
          </section> : null;
        })}
      </div>
      {!visible.length && <p role="status" className="provider-catalog-empty">{t("providerRegistration.noProviderMatches")}</p>}
    </div>}
  </div>;
}
