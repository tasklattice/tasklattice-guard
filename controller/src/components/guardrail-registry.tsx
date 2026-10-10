import { GuardrailRowActions } from "./guardrail-row-actions";
import { Link } from "@tanstack/react-router";
import { Info, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import { StateBadge } from "@/components/product-shell";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { MAX_GUARDRAIL_VERSIONS } from "../../shared/guardrail-version-limit";
import type { Guardrail } from "@/lib/api";

export function GuardrailRegistry({
  guardrails,
  onOpen,
}: {
  guardrails: Guardrail[];
  onOpen: (guardrailId: string) => void;
}) {
  const { t, i18n } = useTranslation();

  return (
    <Table className="resource-table table-fixed" aria-label={t("pages.guardrails.title")}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="resource-name-column">{t("guardrails.guardrail")}</TableHead>
            <TableHead className="w-24"><ColumnHelp label={t("guardrails.registryReadiness")} help={t("guardrails.registryReadinessHelp")} /></TableHead>
            <TableHead className="w-36">{t("guardrails.registryVersions")}</TableHead>
            <TableHead className="w-72"><ColumnHelp label={t("guardrails.registryTraffic")} help={t("guardrails.registryTrafficHelp")} /></TableHead>
            <TableHead className="w-40">{t("guardrails.updated")}</TableHead>
            <TableHead className="resource-actions-column"><span className="sr-only">{t("common.actions")}</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {guardrails.map((guardrail) => (
            <TableRow
              key={guardrail.id}
              className="resource-row"
              onClick={() => onOpen(guardrail.id)}
            >
              <TableCell className="min-w-0">
                <Link
                  to="/guardrails/$guardrailId"
                  params={{ guardrailId: guardrail.id }}
                  aria-label={t("guardrails.openNamedGuardrail", { name: guardrail.name })}
                  className="resource-name"
                  onClick={(event) => event.stopPropagation()}
                >
                  <ShieldCheck aria-hidden="true" />
                  <span>{guardrail.name}</span>
                </Link>
                <code className="resource-secondary" title={guardrail.id}>{guardrail.id}</code>
              </TableCell>
              <TableCell><StateBadge state={guardrail.status} /></TableCell>
              <TableCell>
                <Link to="/guardrails/$guardrailId" params={{ guardrailId: guardrail.id }} search={{ tab: "immutable" }}
                  onClick={event => event.stopPropagation()} className="inline-flex min-h-11 items-center font-mono text-sm text-primary hover:underline"
                  aria-label={t("guardrails.registryOpenVersions", { name: guardrail.name })}>
                  {guardrail.version_summary ? `${guardrail.version_summary.total}/${MAX_GUARDRAIL_VERSIONS}` : "—"}
                </Link>
                {guardrail.version_summary ? <p className="text-xs text-muted-foreground">{t("guardrails.registryVersionCounts", { released: guardrail.version_summary.released, pending: guardrail.version_summary.pending })}</p> : null}
                {guardrail.version_summary?.missingEvidence ? <p className="text-xs text-destructive">{t("guardrails.registryMissingEvidence", { count: guardrail.version_summary.missingEvidence })}</p> : null}
              </TableCell>
              <TableCell>
                {guardrail.traffic_versions?.length ? <div className="space-y-3 py-2">{guardrail.traffic_versions.map(target => <div key={target.version}>
                  <Link to="/guardrails/$guardrailId" params={{ guardrailId: guardrail.id }} search={{ tab: "immutable", version: target.version }}
                    onClick={event => event.stopPropagation()} className="inline-flex min-h-11 items-center font-mono text-xs text-primary hover:underline">{target.version}</Link>
                  {target.baseline ? <p className="text-xs text-muted-foreground">{t("guardrailPackage.baselineCurrent")}</p> : null}
                  {target.routers.map(router => <div key={router.id} className="flex items-center justify-between gap-2">
                    <Link to="/integration/routers/$routerId" params={{ routerId: router.id }} onClick={event => event.stopPropagation()}
                      title={router.name} className="inline-flex min-h-11 min-w-0 items-center text-xs text-primary hover:underline"><span className="truncate">{router.name}</span></Link>
                    <StateBadge state={router.status} />
                  </div>)}
                </div>)}</div> : <span className="text-xs text-muted-foreground">{t("guardrails.registryUnrouted")}</span>}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {new Date(guardrail.updated_at).toLocaleString(i18n.language)}
              </TableCell>
              <TableCell className="resource-actions-column" onClick={event => event.stopPropagation()}><GuardrailRowActions guardrail={guardrail} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
  );
}

function ColumnHelp({ label, help }: { label: string; help: string }) {
  return <Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex min-h-11 items-center gap-1 text-left" aria-label={label}>
    {label}<Info className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
  </button></TooltipTrigger><TooltipContent className="max-w-80 text-left leading-5">{help}</TooltipContent></Tooltip>;
}
