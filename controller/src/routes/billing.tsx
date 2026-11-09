import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { GuardrailUsageCosts } from "@/components/guardrail-usage-costs";
import { EmptyState, ErrorNotice, PageHeader } from "@/components/product-shell";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { queryKeys } from "@/features/query-keys";
import { getGuardrails } from "@/lib/api";

export function BillingPage({ guardrailId, onGuardrailChange }: { guardrailId?: string; onGuardrailChange: (id: string) => void }) {
  const { t } = useTranslation();
  const query = useQuery({ queryKey: queryKeys.guardrails, queryFn: getGuardrails });
  const guardrails = query.data?.items ?? [];
  const selected = guardrailId ?? guardrails[0]?.id;
  const available = guardrails.some(guardrail => guardrail.id === selected);

  const guardrailFilter = <label className="flex min-w-0 items-center gap-2 whitespace-nowrap text-sm">
    <span className="shrink-0">{t("modelPricing.selectGuardrail")}</span>
    <Select value={available ? selected : ""} onValueChange={onGuardrailChange}>
      <SelectTrigger className="w-80 min-w-48" aria-label={t("modelPricing.selectGuardrail")}><SelectValue placeholder={t("modelPricing.selectGuardrail")} /></SelectTrigger>
      <SelectContent>{guardrails.map(guardrail => <SelectItem key={guardrail.id} value={guardrail.id}>{guardrail.name}</SelectItem>)}</SelectContent>
    </Select>
  </label>;

  return <section className="space-y-6 py-8">
    <PageHeader title={t("nav.billing")} description={t("modelPricing.billingDescription")} />
    {query.isPending && <Skeleton className="h-64" />}
    {query.isError && <div className="space-y-4"><ErrorNotice error={query.error} /><Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>{t("common.retry")}</Button></div>}
    {query.isSuccess && (guardrails.length ? (
      available && selected ? <GuardrailUsageCosts guardrailId={selected} guardrailFilter={guardrailFilter} /> : <>
        {guardrailFilter}
        <p role="status" className="text-sm text-muted-foreground">{t("modelPricing.missingGuardrail")}</p>
      </>
    ) : <EmptyState title={t("modelPricing.noGuardrails")} description={t("modelPricing.noGuardrailsHint")} />)}
  </section>;
}
