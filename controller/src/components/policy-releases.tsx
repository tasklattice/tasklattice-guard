import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { CopyableChecksum } from "@/components/copyable-checksum";
import { InfoNotice, StateBadge } from "@/components/product-shell";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Policy } from "@/lib/api";
import type { ReleasedPolicy, ReleasedPolicyVersion } from "@/lib/controller-api";

/**
 * A released Policy in the shape the Policy Library lists: the definition
 * serving traffic (else the newest), with every other released version
 * reachable as a pinned version.
 */
export function releasedPolicyView(policy: ReleasedPolicy): Policy {
  const [head, ...rest] = policy.versions.map((version) => version.definition);
  return { ...head!, published_versions: rest };
}

/** Where each released version of one Policy is used in this environment. */
export function PolicyReleases({ policy }: { policy: ReleasedPolicy }) {
  const { t } = useTranslation();
  return <div className="space-y-6">
    <InfoNotice>{t("releasedPolicies.readOnlyNotice")}</InfoNotice>
    {policy.conflictingVersions.length ? <div role="alert" className="rounded-lg border border-destructive/40 p-4 text-sm">
      <p className="font-medium text-destructive">{t("releasedPolicies.conflict", { versions: policy.conflictingVersions.join(", ") })}</p>
      <p className="mt-1 text-destructive/80">{t("releasedPolicies.conflictDetail")}</p>
    </div> : null}
    {policy.versions.map((version) => <ReleasedVersion key={`${version.version}-${version.contentDigest}`} policy={policy} version={version} />)}
  </div>;
}

function ReleasedVersion({ policy, version }: { policy: ReleasedPolicy; version: ReleasedPolicyVersion }) {
  const { t } = useTranslation();
  const rules = version.definition.rules.length;
  return <section className="space-y-4 border-t pt-6 first-of-type:border-t-0 first-of-type:pt-0">
    <div className="flex flex-wrap items-center gap-3">
      <h3 className="font-mono text-sm font-semibold">{t("releasedPolicies.versionTitle", { version: version.version })}</h3>
      {version.usage.some((item) => item.serving) ? <StateBadge state="active" label={t("releasedPolicies.serving")} /> : null}
      {version.name !== policy.name ? <span className="text-xs text-muted-foreground">{t("releasedPolicies.nameAtVersion", { name: version.name })}</span> : null}
    </div>
    <div><p className="mb-1 text-xs text-muted-foreground">{t("releasedPolicies.digest")}</p>
      {version.contentDigest ? <CopyableChecksum value={version.contentDigest} /> : <p className="text-sm text-muted-foreground">{t("releasedPolicies.digestUnavailable")}</p>}</div>
    <Table>
      <TableHeader><TableRow><TableHead>{t("releasedPolicies.guardrail")}</TableHead><TableHead>{t("releasedPolicies.enabledRules")}</TableHead><TableHead>{t("releasedPolicies.action")}</TableHead><TableHead>{t("releasedPolicies.origin")}</TableHead><TableHead>{t("releasedPolicies.status")}</TableHead></TableRow></TableHeader>
      <TableBody>{version.usage.map((usage) => <TableRow key={`${usage.guardrailId}@${usage.guardrailVersion}`}>
        <TableCell className="whitespace-normal">
          <Link to="/guardrails/$guardrailId" params={{ guardrailId: usage.guardrailId }} search={{ tab: "immutable" }} className="text-sm text-primary hover:underline" aria-label={t("releasedPolicies.openGuardrail", { name: usage.guardrailName })}>{usage.guardrailName}</Link>
          <code className="mt-0.5 block text-xs text-muted-foreground">{usage.guardrailVersion}</code>
        </TableCell>
        <TableCell className="tabular-nums text-sm">{usage.enabledRuleIds.length || rules} / {rules}</TableCell>
        <TableCell className="text-sm">{usage.action ?? t("releasedPolicies.defaultAction")}</TableCell>
        <TableCell className="text-sm">{usage.origin === "imported" ? t("releasedPolicies.importedFrom", { source: usage.sourceId ?? "" }) : t("releasedPolicies.local")}</TableCell>
        <TableCell className="min-w-36"><span className="whitespace-nowrap"><StateBadge state={usage.serving ? "active" : "unknown"} label={t(usage.serving ? "releasedPolicies.serving" : "releasedPolicies.released")} /></span></TableCell>
      </TableRow>)}</TableBody>
    </Table>
  </section>;
}

/** Card footnote: whether the Policy serves traffic and how many versions are released. */
export function ReleaseSummary({ policy }: { policy: ReleasedPolicy }) {
  const { t } = useTranslation();
  return <span className="flex min-w-0 items-center gap-2 whitespace-nowrap">
    <StateBadge state={policy.serving ? "active" : "unknown"} label={t(policy.serving ? "releasedPolicies.serving" : "releasedPolicies.released")} />
    {policy.versions.length > 1 ? <span className="text-xs text-muted-foreground">{t("releasedPolicies.versionsInUse", { count: policy.versions.length })}</span> : null}
  </span>;
}
