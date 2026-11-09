import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ExternalLink, LoaderCircle } from "lucide-react";
import { EntitySheet } from "./entity-sheet";
import { ErrorNotice } from "./product-shell";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Skeleton } from "./ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { toast } from "./ui/notifications";
import { getModelPrices, pricingQueryKey, saveModelPrice, searchModelPrices } from "@/lib/model-pricing-api";
import { pricingRuleSchema, type ModelPricingView, type ModelRates } from "../../shared/model-pricing";

export function formatCost(value: number, currency: string, locale: string) {
  if (value > 0 && value < 0.000001) return `${currency} <0.000001`;
  return `${currency} ${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value)}`;
}
export function ModelRate({ rates }: { rates: ModelRates | null }) {
  const { t, i18n } = useTranslation();
  if (!rates) return <span className="text-muted-foreground">{t("modelPricing.missing")}</span>;
  if (rates.unit === "free") return <span>{t("modelPricing.free")}</span>;
  if (rates.unit === "request") return <span>{formatCost(rates.request, rates.currency, i18n.language)} / {t("modelPricing.perThousand")}</span>;
  return <div className="space-y-1 text-xs"><div>{t("modelPricing.input")} {formatCost(rates.input, rates.currency, i18n.language)} · {t("modelPricing.output")} {formatCost(rates.output, rates.currency, i18n.language)}</div><div className="text-muted-foreground">{t("modelPricing.perMillion")}{rates.cachedInput !== null ? ` · ${t("modelPricing.cached")} ${formatCost(rates.cachedInput, rates.currency, i18n.language)}` : ""}</div></div>;
}
export function ModelPricingPanel({ administrator }: { administrator: boolean }) {
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState<ModelPricingView | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const query = useQuery({ queryKey: pricingQueryKey, queryFn: getModelPrices, refetchInterval: 60_000 });
  if (query.isPending) return <Skeleton className="h-64" />;
  if (query.error || !query.data) return <div className="space-y-3"><ErrorNotice error={query.error} /><Button variant="outline" onClick={() => void query.refetch()}>{t("modelPricing.retry")}</Button></div>;
  const status = query.data.sync;
  return <div className="space-y-5">
    <div className="space-y-2"><h2 className="text-lg">{t("modelPricing.prices")}</h2><p className="text-sm text-muted-foreground">{t("modelPricing.priceDescription")}</p></div>
    <div className="border bg-card p-4 text-sm space-y-2">
      <p className="font-medium">{t("modelPricing.snapshot", { version: status.catalogVersion ?? "—", count: status.entries })}</p>
      <p className="text-muted-foreground">{t("modelPricing.schedule")}</p>
      <p className="text-muted-foreground">{status.lastSuccessAt ? t("modelPricing.synced", { date: new Date(status.lastSuccessAt).toLocaleString(i18n.language) }) : t("modelPricing.neverSynced")}</p>
      <a className="inline-flex items-center gap-1 text-primary hover:underline" href={status.sourceUrl} target="_blank" rel="noreferrer">{t("modelPricing.upstream")}<ExternalLink className="size-3.5" /></a>
    </div>
    {status.error && <Alert><AlertTitle>{t("modelPricing.syncError")}</AlertTitle><AlertDescription>{status.error}</AlertDescription></Alert>}
    <div className="border bg-card"><Table><TableHeader><TableRow><TableHead>{t("modelPricing.model")}</TableHead><TableHead>{t("modelPricing.provider")}</TableHead><TableHead>{t("modelPricing.mode")}</TableHead><TableHead>{t("modelPricing.rate")}</TableHead>{administrator && <TableHead><span className="sr-only">{t("modelPricing.edit")}</span></TableHead>}</TableRow></TableHeader><TableBody>
      {query.data.models.map(model => <TableRow key={model.modelId}><TableCell className="max-w-80 break-all font-mono text-xs">{model.model}</TableCell><TableCell>{model.provider}</TableCell><TableCell>{model.source ? t(`modelPricing.${model.source === "litellm" ? "automatic" : "manual"}`) : "—"}</TableCell><TableCell><ModelRate rates={model.rates} /></TableCell>{administrator && <TableCell className="text-right"><Button variant="ghost" aria-label={t("modelPricing.editFor", { model: model.model })} onClick={event => { opener.current = event.currentTarget; setEditing(model); }}>{t("modelPricing.edit")}</Button></TableCell>}</TableRow>)}
      {!query.data.models.length && <TableRow><TableCell colSpan={administrator ? 5 : 4} className="h-28 text-center text-muted-foreground">{t("modelPricing.noModels")}</TableCell></TableRow>}
    </TableBody></Table></div>
    {editing && <PriceEditor model={editing} onClose={() => setEditing(null)} returnFocusRef={opener} />}
  </div>;
}
function PriceEditor({ model, onClose, returnFocusRef }: { model: ModelPricingView; onClose: () => void; returnFocusRef: React.RefObject<HTMLElement | null> }) {
  const { t } = useTranslation(); const client = useQueryClient();
  const [mode, setMode] = useState(model.mode); const [key, setKey] = useState(model.catalogKey ?? ""); const [search, setSearch] = useState("");
  const [unit, setUnit] = useState<ModelRates["unit"]>(model.rates?.unit ?? "token");
  const currency = "USD" as const;
  const [input, setInput] = useState(model.rates?.unit === "token" ? String(model.rates.input) : "");
  const [output, setOutput] = useState(model.rates?.unit === "token" ? String(model.rates.output) : "");
  const [cached, setCached] = useState(model.rates?.unit === "token" && model.rates.cachedInput !== null ? String(model.rates.cachedInput) : "");
  const [request, setRequest] = useState(model.rates?.unit === "request" ? String(model.rates.request) : "");
  const catalog = useQuery({ queryKey: [...pricingQueryKey, "catalog", search], queryFn: () => searchModelPrices(search), enabled: mode === "automatic" && search.trim().length >= 2 });
  const number = (value: string) => value.trim() ? Number(value) : NaN;
  const parsed = pricingRuleSchema.safeParse({ mode, catalogKey: mode === "automatic" ? key || null : null, rates: mode === "automatic" ? null : unit === "free" ? { unit, currency } : unit === "request" ? { unit, currency, request: number(request) } : { unit, currency, input: number(input), output: number(output), cachedInput: cached.trim() ? number(cached) : null } });
  const save = useMutation({ mutationFn: () => { if (!parsed.success) throw new Error(t("modelPricing.invalid")); return saveModelPrice(model.modelId, parsed.data); }, onSuccess: async () => { await client.invalidateQueries({ queryKey: pricingQueryKey }); toast.success(t("modelPricing.saved")); onClose(); } });
  const field = (id: string, label: string, value: string, change: (value: string) => void, optional = false) => <div className="space-y-2"><Label htmlFor={id}>{label}{optional ? ` (${t("modelPricing.optional")})` : ""}</Label><Input id={id} type="number" min="0" max="1000000" step="any" value={value} onChange={event => change(event.target.value)} required={!optional} /></div>;
  return <EntitySheet open onOpenChange={open => { if (!open && !save.isPending) onClose(); }} returnFocusRef={returnFocusRef} closeDisabled={save.isPending} eyebrow={t("modelPricing.prices")} title={model.model} description={`${model.provider} · ${t("modelPricing.globalHint")}`} width="md" footer={<><Button variant="outline" onClick={onClose} disabled={save.isPending}>{t("modelPricing.cancel")}</Button><Button type="submit" form="model-price-form" disabled={!parsed.success || save.isPending}>{t(save.isPending ? "modelPricing.saving" : "modelPricing.save")}</Button></>}>
    <form id="model-price-form" className="space-y-6" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
      {save.error && <ErrorNotice error={save.error} />}
      <div className="space-y-2"><Label htmlFor="price-mode">{t("modelPricing.mode")}</Label><Select value={mode} onValueChange={v => setMode(v as typeof mode)}><SelectTrigger id="price-mode"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="automatic">{t("modelPricing.autoMode")}</SelectItem><SelectItem value="manual">{t("modelPricing.manualMode")}</SelectItem></SelectContent></Select></div>
      {mode === "automatic" ? <div className="space-y-3"><Label htmlFor="catalog-search">{t("modelPricing.alias")}</Label><p className="text-sm text-muted-foreground">{t("modelPricing.aliasHint")}</p><div className="flex items-center justify-between gap-3 border p-3"><span className="break-all text-sm">{key ? t("modelPricing.selected", { key }) : t("modelPricing.autoMatch")}</span>{key && <Button variant="ghost" onClick={() => setKey("")}>{t("modelPricing.autoMatch")}</Button>}</div><Input id="catalog-search" value={search} maxLength={256} placeholder={t("modelPricing.search")} onChange={event => setSearch(event.target.value)} />{catalog.isFetching && <LoaderCircle className="size-4 animate-spin" aria-label={t("modelPricing.searching")} />}{catalog.error && <ErrorNotice error={catalog.error} />}{catalog.data && <div className="max-h-72 overflow-y-auto border">{catalog.data.items.map(item => <div key={item.key} className="space-y-2 border-b p-3 last:border-b-0"><p className="break-all font-mono text-xs">{item.key}</p><ModelRate rates={item.rates} /><Button size="sm" variant="outline" onClick={() => { setKey(item.key); setSearch(""); }}>{t("modelPricing.selectEntry")}</Button></div>)}{!catalog.data.items.length && <p className="p-3 text-sm text-muted-foreground">{t("modelPricing.noMatch")}</p>}</div>}</div> : <>
        <div className="space-y-2"><Label htmlFor="price-unit">{t("modelPricing.unit")}</Label><Select value={unit} onValueChange={v => setUnit(v as typeof unit)}><SelectTrigger id="price-unit"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="token">{t("modelPricing.tokenUnit")}</SelectItem><SelectItem value="request">{t("modelPricing.requestUnit")}</SelectItem><SelectItem value="free">{t("modelPricing.freeUnit")}</SelectItem></SelectContent></Select></div>
        <p className="text-sm text-muted-foreground">{t("modelPricing.usdOnly")}</p>
        {unit === "token" && <><p className="text-sm text-muted-foreground">{currency} / {t("modelPricing.perMillion")}</p><div className="grid grid-cols-2 gap-4">{field("price-input", t("modelPricing.input"), input, setInput)}{field("price-output", t("modelPricing.output"), output, setOutput)}</div>{field("price-cache", t("modelPricing.cached"), cached, setCached, true)}<p className="text-xs text-muted-foreground">{t("modelPricing.cacheHint")}</p></>}
        {unit === "request" && field("price-request", `${currency} / ${t("modelPricing.perThousand")}`, request, setRequest)}
      </>}
    </form>
  </EntitySheet>;
}
