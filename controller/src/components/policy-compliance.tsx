import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import type { Policy } from "@/lib/api-types";
import { Badge } from "@/components/ui/badge";

const key = "policyLibrary.compliance";
const localText = (value: { en: string; zh: string }, language: string) => language.startsWith("zh") ? value.zh : value.en;

const ExternalPolicyLink = memo(function ExternalPolicyLink({ href, children }: { href: string; children: string }) {
  const { t } = useTranslation();
  return <a href={href} target="_blank" rel="noopener noreferrer"
    className="inline-flex min-h-11 flex-wrap items-center gap-2 font-medium text-blue-700 underline decoration-blue-300 underline-offset-4 hover:text-blue-800 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:text-blue-300 dark:hover:text-blue-200">
    <span>{children}</span><ExternalLink aria-hidden className="size-3.5 shrink-0" />
    <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold no-underline dark:border-blue-800 dark:bg-blue-950">{t(`${key}.externalLink`)}</span>
  </a>;
});

function RuleReferences({ ids, names }: { ids: string[]; names: ReadonlyMap<string, string> }) {
  const { t } = useTranslation();
  return <ul className="mt-2 space-y-1 text-xs text-muted-foreground" aria-label={t(`${key}.rules`)}>
    {ids.map(id => <li key={id} className="break-words"><span className="font-medium">{names.get(id) ?? id}</span><code className="mt-0.5 block break-all">{id}</code></li>)}
  </ul>;
}

export const PolicyCompliancePanel = memo(function PolicyCompliancePanel({ policy }: { policy: Policy }) {
  const { t, i18n } = useTranslation();
  const data = policy.compliance;
  const names = useMemo(() => new Map(policy.rules.map(rule => [rule.id, rule.name])), [policy.rules]);
  const text = (value: { en: string; zh: string }) => localText(value, i18n.language);
  // Never silently display documentation belonging to a different Policy version.
  if (!data || data.policy_version !== policy.version) return <section className="space-y-2 py-5">
    <h3 className="text-sm font-semibold">{t(`${key}.title`)}</h3>
    <p className="text-sm leading-6 text-muted-foreground">{t(`${key}.empty`)}</p>
    <p className="text-xs text-muted-foreground">{t(`${key}.version`)}: {policy.version}</p>
  </section>;
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
      {!data.references.length ? <p className="text-muted-foreground">{t(`${key}.noExternalReferences`)}</p> : null}
      {data.references.map(reference => <article key={reference.url} className="space-y-2 border-l-2 pl-4">
        <ExternalPolicyLink href={reference.url}>{reference.title}</ExternalPolicyLink>
        <p className="text-xs text-muted-foreground">{reference.publisher} · {reference.provision}</p>
        <p>{text(reference.relevance)}</p>
        <RuleReferences ids={reference.rule_ids} names={names} />
      </article>)}
    </section>
    <section className="space-y-3 border-t pt-5">
      <h3 className="font-semibold">{t(`${key}.coverage`)}</h3>
      {data.coverage.map((entry, index) => <div key={index}><p>{text(entry.description)}</p><RuleReferences ids={entry.rule_ids} names={names} /></div>)}
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
});
