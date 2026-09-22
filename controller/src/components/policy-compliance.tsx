import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import type { Policy } from "@/lib/api-types";
import { Badge } from "@/components/ui/badge";

export function PolicyCompliancePanel({ policy }: { policy: Policy }) {
  const { t, i18n } = useTranslation();
  const data = policy.compliance;
  const text = (value: { en: string; zh: string }) => i18n.language.startsWith("zh") ? value.zh : value.en;
  const key = "policyLibrary.compliance";
  // Never silently display documentation belonging to a different Policy version.
  if (!data || data.policy_version !== policy.version) return <section className="space-y-2 py-5">
    <h3 className="text-sm font-semibold">{t(`${key}.title`)}</h3>
    <p className="text-sm leading-6 text-muted-foreground">{t(`${key}.empty`)}</p>
    <p className="text-xs text-muted-foreground">{t(`${key}.version`)}: {policy.version}</p>
  </section>;
  const rules = (ids: string[]) => <ul className="mt-2 space-y-1 text-xs text-muted-foreground" aria-label={t(`${key}.rules`)}>
    {ids.map(id => <li key={id} className="break-words"><span className="font-medium">{policy.rules.find(rule => rule.id === id)?.name ?? id}</span><code className="mt-0.5 block break-all">{id}</code></li>)}
  </ul>;
  return <div className="space-y-6 text-sm leading-6">
    <section className="space-y-2 border-b pb-5">
      <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{t(`${key}.title`)}</h3><Badge variant="outline">{t(`${key}.${data.review.status}`)}</Badge></div>
      <p>{text(data.summary)}</p>
      <p className="text-muted-foreground">{text(data.jurisdiction)}</p>
      <p className="text-xs text-muted-foreground">{t(`${key}.version`)}: <code>{data.policy_version}</code></p>
    </section>
    <section className="space-y-3">
      <h3 className="font-semibold">{t(`${key}.provenance`)}</h3>
      <p className="break-words">{text(data.provenance)}</p>
      <dl className="space-y-3">
        <div><dt className="text-xs font-medium text-muted-foreground">{t(`${key}.maintainer`)}</dt><dd>{data.maintainer}</dd></div>
        <div><dt className="text-xs font-medium text-muted-foreground">{t(`${key}.upstream`)}</dt><dd>{text(data.upstream_status)}</dd></div>
        <div><dt className="text-xs font-medium text-muted-foreground">{t(`${key}.license`)}</dt><dd>{text(data.license_status)}</dd></div>
      </dl>
    </section>
    <section className="space-y-3 border-t pt-5">
      <h3 className="font-semibold">{t(`${key}.references`)}</h3>
      {data.references.map(reference => <article key={reference.url} className="space-y-2 border-l-2 pl-4">
        <a href={reference.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 font-medium underline underline-offset-4">
          {reference.title}<ExternalLink aria-hidden className="size-3.5 shrink-0" /><span className="sr-only">{t(`${key}.external`)}</span>
        </a>
        <p className="text-xs text-muted-foreground">{reference.publisher} · {reference.provision}</p>
        <p>{text(reference.relevance)}</p>
        {rules(reference.rule_ids)}
      </article>)}
    </section>
    <section className="space-y-3 border-t pt-5">
      <h3 className="font-semibold">{t(`${key}.coverage`)}</h3>
      {data.coverage.map((entry, index) => <div key={index}><p>{text(entry.description)}</p>{rules(entry.rule_ids)}</div>)}
      <h4 className="pt-2 font-medium">{t(`${key}.limitations`)}</h4>
      <ul className="list-disc space-y-2 pl-5">{data.limitations.map((entry, index) => <li key={index}>{text(entry)}</li>)}</ul>
    </section>
    <section className="space-y-2 border-t pt-5">
      <h3 className="font-semibold">{t(`${key}.review`)}</h3>
      <p>{text(data.review.notes)}</p>
      <dl className="grid gap-3 text-xs sm:grid-cols-2">
        <div><dt className="text-muted-foreground">{t(`${key}.date`)}</dt><dd>{data.review.reviewed_on ?? t(`${key}.notReviewed`)}</dd></div>
        <div><dt className="text-muted-foreground">{t(`${key}.reviewer`)}</dt><dd>{data.review.reviewer ?? t(`${key}.notReviewed`)}</dd></div>
      </dl>
    </section>
  </div>;
}
