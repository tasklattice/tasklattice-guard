import { forwardRef, useMemo, useState } from "react";
import { ChevronDown, Plus, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { providerCategories, providerPresets, type ProviderPresetId } from "./provider-ui-registry";

// Relay provider-picker: searchable, categorized catalog in a width-matched
// Popover. Guard has no compliance-boundary filter.
export const ProviderPicker = forwardRef<HTMLButtonElement, {
  value?: ProviderPresetId;
  disabled?: boolean;
  onChange: (value: ProviderPresetId) => void;
}>(function ProviderPicker({ value, disabled, onChange }, ref) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selected = providerPresets.find((provider) => provider.id === value);
  const visibleProviders = useMemo(() => {
    const query = search.trim().toLowerCase();
    return providerPresets.filter((provider) => !query || `${provider.name} ${t(`providerRegistration.descriptions.${provider.id}`)}`.toLowerCase().includes(query));
  }, [search, t]);
  const close = () => { setOpen(false); setSearch(""); };
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setSearch(""); }}>
      <PopoverTrigger asChild>
        <button id="provider-picker" ref={ref} type="button" disabled={disabled}
          aria-label={selected ? `${t("providerRegistration.selectedProvider")}: ${selected.name}` : t("modelSettings.selectProvider")}
          className="flex min-h-12 w-full items-center gap-3 rounded-md border bg-background px-3 text-left text-sm shadow-xs transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50">
          {selected ? <ProviderIcon id={selected.id} /> : <span aria-hidden className="grid size-7 place-items-center rounded-md border bg-muted/25 text-muted-foreground"><Plus className="size-4" /></span>}
          <span className={cn("min-w-0 flex-1 truncate", !selected && "text-muted-foreground")}>{selected?.name ?? t("modelSettings.selectProvider")}</span>
          <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        </button>
      </PopoverTrigger>
      <PopoverContent aria-label={t("providerRegistration.providerCatalog")} align="start" sideOffset={4} collisionPadding={10}
        className="flex max-h-[min(36rem,var(--radix-popover-content-available-height))] w-(--radix-popover-trigger-width) max-w-[calc(100vw-1.25rem)] flex-col overflow-hidden rounded-lg p-0">
        <div className="border-b p-3">
          <div className="mb-3 flex items-baseline justify-between gap-3"><p className="text-sm font-medium">{t("providerRegistration.providerCatalog")}</p><span className="text-xs tabular-nums text-muted-foreground">{t("providerRegistration.shown", { count: visibleProviders.length })}</span></div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input autoFocus aria-label={t("providerRegistration.searchProviders")} className="h-11 pl-9" placeholder={t("providerRegistration.searchProviders")} value={search} onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }} />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {providerCategories.map((category) => {
            const items = visibleProviders.filter((provider) => provider.category === category);
            return items.length ? <section key={category} className="border-b px-3 py-3 last:border-b-0">
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">{t(`providerRegistration.categories.${category}`)}</h3>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {items.map((provider) => <button key={provider.id} type="button" aria-pressed={value === provider.id} onClick={() => { onChange(provider.id); close(); }}
                  className={cn("flex min-h-16 max-w-full items-start gap-2.5 rounded-md border border-transparent px-2.5 py-2 text-left text-sm transition-colors hover:border-border hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/20", value === provider.id && "border-primary/30 bg-primary/5")}>
                  <ProviderIcon id={provider.id} />
                  <span className="min-w-0"><span className="block truncate font-medium">{provider.name}</span><span className="mt-0.5 line-clamp-2 block text-xs leading-4 text-muted-foreground">{t(`providerRegistration.descriptions.${provider.id}`)}</span></span>
                </button>)}
              </div>
            </section> : null;
          })}
          {!visibleProviders.length ? <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t("providerRegistration.noProviderMatches")}</p> : null}
        </div>
      </PopoverContent>
    </Popover>
  );
});

function ProviderIcon({ id }: { id: ProviderPresetId }) {
  const preset = providerPresets.find((item) => item.id === id)!;
  return <span className="grid size-7 shrink-0 place-items-center rounded-md border bg-card shadow-xs"><img src={`/assets/providers/${preset.icon}`} alt="" className="size-5 rounded-sm object-contain" /></span>;
}
