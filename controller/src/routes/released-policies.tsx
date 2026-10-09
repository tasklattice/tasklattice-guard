import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { LockKeyhole, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CopyableChecksum } from "@/components/copyable-checksum";
import { EntitySheet } from "@/components/entity-sheet";
import { InfoNotice, PageHeader, StateBadge } from "@/components/product-shell";
import { ResourceList } from "@/components/resource-list";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { queryKeys } from "@/features/query-keys";
import { getReleasedPolicies, type ReleasedPolicy, type ReleasedPolicyVersion } from "@/lib/controller-api";

/**
 * Policy Library where Policies are not authored: the Policies frozen in this
 * environment's released Guardrail versions, grouped by Policy ID.
 */
export function ReleasedPoliciesPage() {
  const { t } = useTranslation();
  const query = useQuery({ queryKey: queryKeys.releasedPolicies, queryFn: getReleasedPolicies });
  const [selected, setSelected] = useState<string | null>(null);
  const policies = query.data?.items ?? [];
  const open = policies.find(policy => policy.policyId === selected) ?? null;
  return (
    <section className="py-8">
      <PageHeader title={t("releasedPolicies.title")} description={t("releasedPolicies.description")} />
      <ResourceList items={policies} label={t("releasedPolicies.title")} searchPlaceholder={t("releasedPolicies.search")}
        searchText={policy => `${policy.name} ${policy.policyId} ${policy.versions.map(version => version.name).join(" ")}`}
        filter={{ label: t("releasedPolicies.status"), options: [{ value: "", label: t("resourceList.allStatuses") }, { value: "serving", label: t("releasedPolicies.serving") }, { value: "released", label: t("releasedPolicies.released") }],
          matches: (policy, value) => value === "serving" ? policy.serving : !policy.serving }}
        loading={query.isPending} refreshing={query.isFetching} error={query.error} onRefresh={() => void query.refetch()}
        emptyTitle={t("releasedPolicies.empty")} emptyDescription={t("releasedPolicies.emptyDescription")}>
        {items => <Table>
          <TableHeader><TableRow>
            <TableHead>{t("releasedPolicies.policy")}</TableHead><TableHead>{t("releasedPolicies.source")}</TableHead>
            <TableHead>{t("releasedPolicies.versions")}</TableHead><TableHead>{t("releasedPolicies.usedBy")}</TableHead><TableHead>{t("releasedPolicies.status")}</TableHead>
          </TableRow></TableHeader>
          <TableBody>{items.map(policy => <TableRow key={policy.policyId} className="cursor-pointer" onClick={() => setSelected(policy.policyId)}>
            <TableCell className="whitespace-normal">
              <button type="button" className="text-left font-medium text-primary hover:underline" onClick={event => { event.stopPropagation(); setSelected(policy.policyId); }}>{policy.name}</button>
              <code className="mt-1 block break-all text-xs text-muted-foreground">{policy.policyId}</code>
            </TableCell>
            <TableCell><Badge variant="outline">{t(policy.source === "custom" ? "releasedPolicies.custom" : "releasedPolicies.builtIn")}</Badge></TableCell>
            <TableCell className="whitespace-normal"><div className="flex flex-wrap items-center gap-1.5">
              {policy.versions.map(version => <code key={`${version.version}-${version.contentDigest}`} className="rounded-sm border px-1.5 py-0.5 text-xs">{version.version}</code>)}
              {policy.versions.length > 1 ? <span className="text-xs text-muted-foreground">{t("releasedPolicies.versionsInUse", { count: policy.versions.length })}</span> : null}
              {policy.conflictingVersions.length ? <TriangleAlert className="size-4 text-destructive" aria-label={t("releasedPolicies.conflict", { versions: policy.conflictingVersions.join(", ") })} /> : null}
            </div></TableCell>
            <TableCell className="tabular-nums text-sm">{t("releasedPolicies.usedByCount", { count: policy.versions.reduce((sum, version) => sum + version.usage.length, 0) })}</TableCell>
            <TableCell className="min-w-36"><span className="whitespace-nowrap"><StateBadge state={policy.serving ? "active" : "unknown"} label={t(policy.serving ? "releasedPolicies.serving" : "releasedPolicies.released")} /></span></TableCell>
          </TableRow>)}</TableBody>
        </Table>}
      </ResourceList>
      {open ? <ReleasedPolicyDetail policy={open} onClose={() => setSelected(null)} /> : null}
    </section>
  );
}

function ReleasedPolicyDetail({ policy, onClose }: { policy: ReleasedPolicy; onClose: () => void }) {
  const { t } = useTranslation();
  return <EntitySheet open width="xl" onOpenChange={next => { if (!next) onClose(); }} footer={null}
    eyebrow={t(policy.source === "custom" ? "releasedPolicies.custom" : "releasedPolicies.builtIn")}
    title={policy.name}
    description={<span className="flex items-center gap-2"><LockKeyhole className="size-3.5" /><code className="text-xs">{policy.policyId}</code></span>}>
    <div className="space-y-6">
      <InfoNotice>{t("releasedPolicies.readOnlyNotice")}</InfoNotice>
      {policy.conflictingVersions.length ? <div role="alert" className="border border-destructive/40 p-4 text-sm">
        <p className="font-medium text-destructive">{t("releasedPolicies.conflict", { versions: policy.conflictingVersions.join(", ") })}</p>
        <p className="mt-1 text-destructive/80">{t("releasedPolicies.conflictDetail")}</p>
      </div> : null}
      {policy.versions.map(version => <ReleasedVersion key={`${version.version}-${version.contentDigest}`} policy={policy} version={version} />)}
    </div>
  </EntitySheet>;
}

function ReleasedVersion({ policy, version }: { policy: ReleasedPolicy; version: ReleasedPolicyVersion }) {
  const { t } = useTranslation();
  return <section className="space-y-4 border-t pt-6 first-of-type:border-t-0 first-of-type:pt-0">
    <div className="flex flex-wrap items-center gap-3">
      <h3 className="font-mono text-base font-semibold">{t("releasedPolicies.versionTitle", { version: version.version })}</h3>
      {version.usage.some(item => item.serving) ? <StateBadge state="active" label={t("releasedPolicies.serving")} /> : null}
      {version.name !== policy.name ? <span className="text-xs text-muted-foreground">{t("releasedPolicies.nameAtVersion", { name: version.name })}</span> : null}
    </div>
    {version.description ? <p className="text-sm text-muted-foreground">{version.description}</p> : null}
    <div><p className="mb-1 text-xs text-muted-foreground">{t("releasedPolicies.digest")}</p>
      {version.contentDigest ? <CopyableChecksum value={version.contentDigest} /> : <p className="text-sm text-muted-foreground">{t("releasedPolicies.digestUnavailable")}</p>}</div>
    <div>
      <h4 className="mb-2 text-sm font-medium">{t("releasedPolicies.rules")}</h4>
      <Table>
        <TableHeader><TableRow><TableHead>{t("releasedPolicies.rule")}</TableHead><TableHead>{t("releasedPolicies.action")}</TableHead><TableHead>{t("releasedPolicies.phases")}</TableHead></TableRow></TableHeader>
        <TableBody>{version.rules.map(rule => <TableRow key={rule.id}>
          <TableCell className="whitespace-normal"><span className="text-sm">{rule.name}</span><code className="mt-0.5 block break-all text-xs text-muted-foreground">{rule.id}</code></TableCell>
          <TableCell className="text-sm">{rule.action ?? "—"}</TableCell>
          <TableCell className="text-sm">{rule.phases.join(" · ") || "—"}</TableCell>
        </TableRow>)}</TableBody>
      </Table>
    </div>
    <div>
      <h4 className="mb-2 text-sm font-medium">{t("releasedPolicies.usage")}</h4>
      <Table>
        <TableHeader><TableRow><TableHead>{t("releasedPolicies.guardrail")}</TableHead><TableHead>{t("releasedPolicies.enabledRules")}</TableHead><TableHead>{t("releasedPolicies.action")}</TableHead><TableHead>{t("releasedPolicies.origin")}</TableHead><TableHead>{t("releasedPolicies.status")}</TableHead></TableRow></TableHeader>
        <TableBody>{version.usage.map(usage => <TableRow key={`${usage.guardrailId}@${usage.guardrailVersion}`}>
          <TableCell className="whitespace-normal">
            <Link to="/guardrails/$guardrailId" params={{ guardrailId: usage.guardrailId }} search={{ tab: "immutable" }} className="text-sm text-primary hover:underline" aria-label={t("releasedPolicies.openGuardrail", { name: usage.guardrailName })}>{usage.guardrailName}</Link>
            <span className="mt-0.5 flex items-center gap-2"><code className="text-xs text-muted-foreground">{usage.guardrailVersion}</code>{usage.latest ? <Badge variant="outline">{t("releasedPolicies.latest")}</Badge> : null}</span>
          </TableCell>
          <TableCell className="tabular-nums text-sm">{usage.enabledRuleIds.length || version.rules.length} / {version.rules.length}</TableCell>
          <TableCell className="text-sm">{usage.action ?? t("releasedPolicies.defaultAction")}</TableCell>
          <TableCell className="text-sm">{usage.origin === "imported" ? t("releasedPolicies.importedFrom", { source: usage.sourceId ?? "" }) : t("releasedPolicies.local")}</TableCell>
          <TableCell className="min-w-36"><span className="whitespace-nowrap"><StateBadge state={usage.serving ? "active" : "unknown"} label={t(usage.serving ? "releasedPolicies.serving" : "releasedPolicies.released")} /></span></TableCell>
        </TableRow>)}</TableBody>
      </Table>
    </div>
  </section>;
}
