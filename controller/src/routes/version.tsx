import { SettingsNavigation } from "@/components/settings-navigation";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PageHeader, StateBadge } from "@/components/product-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { getSystemVersion } from "@/lib/controller-api";
import type { SoftwareVersion } from "../../shared/software-version";

export function VersionPage() {
  const { t, i18n } = useTranslation();
  const query = useQuery({ queryKey: ["system-version"], queryFn: getSystemVersion, retry: false });
  return <section className="py-6 sm:py-8">
    <PageHeader title={t("softwareVersion.title")} description={t("softwareVersion.description")} action={
      <Button variant="outline" className="min-h-11" disabled={query.isFetching} onClick={() => void query.refetch()}>
        <RefreshCw className={query.isFetching ? "animate-spin motion-reduce:animate-none" : ""} />
        {t(query.isFetching ? "softwareVersion.refreshing" : "softwareVersion.refresh")}
      </Button>
    } />
    <SettingsNavigation />
    <div className="mt-6 space-y-6">
      {query.isError && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{t("softwareVersion.error")}</p>}
      {query.isPending && <div role="status" aria-label={t("softwareVersion.refreshing")} className="space-y-4"><Skeleton className="h-48 w-full" /><Skeleton className="h-48 w-full" /></div>}
      {query.data && <>
        <section aria-labelledby="control-version-heading">
          <h2 id="control-version-heading" className="mb-3 text-base font-semibold">{t("softwareVersion.controlPlane")}</h2>
          <VersionDetails title={t("softwareVersion.controller")} software={query.data.controlPlane} />
        </section>
        <section aria-labelledby="data-version-heading">
          <h2 id="data-version-heading" className="mb-3 text-base font-semibold">{t("softwareVersion.dataPlane")} <span className="ml-2 text-sm font-normal text-muted-foreground">{query.data.dataPlane.length} Runner</span></h2>
          <div className="space-y-4">
            {query.data.dataPlane.length === 0 && <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">{t("softwareVersion.empty")}</p>}
            {query.data.dataPlane.map(runner => <VersionDetails key={runner.runnerId} title={runner.runnerId} software={runner.software} status={runner.status} detail={
              `${t("softwareVersion.pool")}: ${runner.poolId} · ${t("softwareVersion.reported")}: ${runner.lastHeartbeatAt ? new Date(runner.lastHeartbeatAt).toLocaleString(i18n.language) : t("softwareVersion.unknown")}`
            } />)}
          </div>
        </section>
        <p className="max-w-4xl text-xs leading-6 text-muted-foreground">{t("softwareVersion.note")}</p>
      </>}
    </div>
  </section>;
}

function VersionDetails({ title, software, status, detail }: { title: string; software: SoftwareVersion; status?: string; detail?: string }) {
  const { t } = useTranslation();
  return <article className="min-w-0 overflow-hidden rounded-lg border bg-card">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
      <div className="min-w-0"><h3 className="break-all text-sm font-semibold">{title}</h3>{detail && <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{detail}</p>}</div>
      {status && <StateBadge state={status} />}
    </div>
    <dl className="grid gap-5 p-5 sm:grid-cols-2 xl:grid-cols-4">
      <Field label={t("softwareVersion.version")}><span className="font-mono">{software.version}</span></Field>
      <Field label={t("softwareVersion.commit")}><span className="break-all font-mono">{software.commit ?? t("softwareVersion.unknown")}</span></Field>
      <Field label={t("softwareVersion.branch")}>{software.branch ?? t(software.commit ? "softwareVersion.detached" : "softwareVersion.unknown")}</Field>
      <Field label={t(software.source === "build" ? "softwareVersion.build" : "softwareVersion.workspace")}>
        <Badge variant="outline" className={software.dirty === true ? "border-amber-300 bg-amber-50 text-amber-800" : ""}>{t(software.dirty === null ? "softwareVersion.unknown" : software.dirty ? "softwareVersion.dirty" : "softwareVersion.clean")}</Badge>
      </Field>
    </dl>
    {software.source === "unknown" && <p className="border-t px-5 py-3 text-xs leading-5 text-muted-foreground">{t(status ? "softwareVersion.missingGitMetadata" : "softwareVersion.unavailable")}</p>}
  </article>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="min-w-0"><dt className="mb-2 text-xs text-muted-foreground">{label}</dt><dd className="break-words text-sm leading-6">{children}</dd></div>;
}
