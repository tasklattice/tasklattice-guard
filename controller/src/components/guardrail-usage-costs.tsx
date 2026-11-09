import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Skeleton } from "./ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { ErrorNotice } from "./product-shell";
import { formatCost } from "./model-pricing";
import { getGuardrailCosts } from "@/lib/model-pricing-api";
import type { CostQuery, GuardrailCostView } from "../../shared/model-pricing";

export function GuardrailUsageCosts({ guardrailId, guardrailFilter }: { guardrailId: string; guardrailFilter?: ReactNode }) {
  const { t, i18n } = useTranslation();
  const [window, setWindow] = useState<CostQuery["window"]>("month");
  const [source, setSource] = useState<CostQuery["source"]>("all");
  const query = useQuery({ queryKey: ["guardrail-costs", guardrailId, window, source], queryFn: () => getGuardrailCosts(guardrailId, { window, source }), refetchInterval: 30_000, retry: false });
  const data = query.data;
  const count = (value: number) => value.toLocaleString(i18n.language);
  return <div className="space-y-5">
    <div className="flex items-center gap-4">
      {guardrailFilter}
      <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-sm">{t("modelPricing.period")}<Select value={window} onValueChange={value => setWindow(value as CostQuery["window"])}><SelectTrigger className="w-36" aria-label={t("modelPricing.period")}><SelectValue /></SelectTrigger><SelectContent>{(["month", "7d", "30d"] as const).map(value => <SelectItem key={value} value={value}>{t(`modelPricing.${value}`)}</SelectItem>)}</SelectContent></Select></label>
      <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-sm">{t("modelPricing.source")}<Select value={source} onValueChange={value => setSource(value as CostQuery["source"])}><SelectTrigger className="w-52" aria-label={t("modelPricing.source")}><SelectValue /></SelectTrigger><SelectContent>{(["all", "runtime", "testing"] as const).map(value => <SelectItem key={value} value={value}>{t(`modelPricing.${value}`)}</SelectItem>)}</SelectContent></Select></label>
      <span className="shrink-0 text-xs text-muted-foreground">UTC</span><Button className="ml-auto shrink-0" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw className={query.isFetching ? "animate-spin" : ""} />{t("modelPricing.refresh")}</Button>
    </div>
    <p className="max-w-3xl text-sm text-muted-foreground">{t("modelPricing.description")}</p>
    {query.isPending && <Skeleton className="h-64" />}
    {query.error && <ErrorNotice error={query.error} />}
    {data && <>
      <div className="grid grid-cols-[1.4fr_1fr_1fr_1fr] divide-x border bg-card">
        <Metric label={t("modelPricing.accounted")}>{data.totals.length ? data.totals.map(total => <div key={total.currency}>{formatCost(total.cost, total.currency, i18n.language)}</div>) : data.unpriced ? <span className="text-xl">{t("modelPricing.unpriced")}</span> : formatCost(0, "USD", i18n.language)}</Metric>
        <Metric label={t("modelPricing.calls")}>{count(data.calls)}</Metric><Metric label={t("modelPricing.input")}>{data.unknownUsage === data.calls && data.calls > 0 ? "—" : count(data.inputTokens)}</Metric><Metric label={t("modelPricing.output")}>{data.unknownUsage === data.calls && data.calls > 0 ? "—" : count(data.outputTokens)}</Metric>
      </div>
      {data.unpriced > 0 && <Alert><AlertTitle>{t("modelPricing.incomplete", { count: data.unpriced })}</AlertTitle><AlertDescription>{t("modelPricing.incompleteHint")}</AlertDescription></Alert>}
      {data.unknownUsage > 0 && <p className="text-sm text-muted-foreground">{t("modelPricing.unknownUsage", { count: data.unknownUsage })}</p>}
      {!data.calls ? <div className="border bg-card px-6 py-12 text-center"><h3 className="text-base">{t("modelPricing.empty")}</h3><p className="mt-2 text-sm text-muted-foreground">{t("modelPricing.emptyHint")}</p></div> : <>
        <div className="border bg-card"><Table><TableHeader><TableRow><TableHead>{t("modelPricing.model")}</TableHead><TableHead>{t("modelPricing.provider")}</TableHead><TableHead className="text-right">{t("modelPricing.calls")}</TableHead><TableHead className="text-right">{t("modelPricing.input")}</TableHead><TableHead className="text-right">{t("modelPricing.output")}</TableHead><TableHead className="text-right">{t("modelPricing.cost")}</TableHead><TableHead className="text-right">{t("modelPricing.unpricedCalls")}</TableHead></TableRow></TableHeader><TableBody>{data.models.map((row, index) => <TableRow key={`${row.modelId}-${row.model}-${row.currency}-${index}`}><TableCell className="max-w-72 break-all font-mono text-xs">{row.model}</TableCell><TableCell>{row.provider}</TableCell><TableCell className="text-right font-mono">{count(row.calls)}</TableCell><TableCell className="text-right font-mono">{row.unknownUsage === row.calls ? "—" : count(row.inputTokens)}</TableCell><TableCell className="text-right font-mono">{row.unknownUsage === row.calls ? "—" : count(row.outputTokens)}</TableCell><TableCell className="text-right font-mono">{row.cost === null || !row.currency ? t("modelPricing.unpriced") : formatCost(row.cost, row.currency, i18n.language)}</TableCell><TableCell className="text-right font-mono">{count(row.unpriced)}</TableCell></TableRow>)}</TableBody></Table></div>
        {data.totals.length > 0 && <CostTrend data={data} />}
      </>}
      <div className="space-y-1 text-xs text-muted-foreground">{data.meteringSince && <p>{t("modelPricing.since", { date: new Date(data.meteringSince).toISOString().slice(0, 10) })}</p>}<p>{t("modelPricing.retention")}</p></div>
    </>}
  </div>;
}
function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-3 p-5"><p className="text-sm text-muted-foreground">{label}</p><div className="font-mono text-2xl tabular-nums">{children}</div></div>;
}
function CostTrend({ data }: { data: GuardrailCostView }) {
  const { t, i18n } = useTranslation();
  return <div className="border bg-card"><div className="border-b p-4"><h3 className="text-sm">{t("modelPricing.trend")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("modelPricing.trendHint")}</p></div><div className="grid gap-4 p-4" style={{ gridTemplateColumns: `repeat(${data.totals.length}, minmax(0, 1fr))` }}>{data.totals.map(total => {
    const chart: Array<{ day: string; cost: number | null }> = [];
    const start = new Date(`${data.since.slice(0, 10)}T00:00:00Z`);
    const end = data.until.slice(0, 10);
    for (let date = start; date.toISOString().slice(0, 10) <= end; date = new Date(date.getTime() + 86_400_000)) {
      const day = date.toISOString().slice(0, 10);
      const rows = data.trend.filter(point => point.day === day);
      const known = rows.find(point => point.currency === total.currency);
      chart.push({ day, cost: known?.cost ?? (rows.some(point => point.unpriced > 0) || (data.meteringSince && day < data.meteringSince.slice(0, 10)) ? null : 0) });
    }
    return <div key={total.currency}><p className="mb-2 font-mono text-xs text-muted-foreground">{total.currency}</p><div className="h-48" aria-label={`${t("modelPricing.trend")} ${total.currency}`}><ResponsiveContainer width="100%" height="100%"><LineChart data={chart} margin={{ left: 8, right: 20, top: 8 }}><CartesianGrid vertical={false} stroke="var(--chart-grid)" /><XAxis dataKey="day" tickFormatter={value => String(value).slice(5)} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} /><YAxis width={72} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} /><Tooltip formatter={value => formatCost(Number(value), total.currency, i18n.language)} /><Line name={t("modelPricing.accounted")} type="linear" dataKey="cost" stroke="var(--chart-1)" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} /></LineChart></ResponsiveContainer></div></div>;
  })}</div></div>;
}
