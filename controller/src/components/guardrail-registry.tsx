import { GuardrailRequestRate } from "./guardrail-request-rate";
import type { GuardrailRequestRates } from "@/lib/observability-api";
import { TenantResourceBadge } from "@/components/tenant-resource-badge";
import { hasPermission } from "../../shared/rbac";
import { GuardrailRowActions } from "./guardrail-row-actions";
import { Link } from "@tanstack/react-router";
import { Info, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import { StateBadge } from "@/components/product-shell";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { useAuth } from "@/lib/auth";
import type { Guardrail } from "@/lib/api";

export function GuardrailRegistry({
  guardrails,
  onOpen,
  requestRates, ratesLoading, ratesError,
}: {
  guardrails: Guardrail[];
  requestRates?: GuardrailRequestRates;
  ratesLoading?: boolean;
  ratesError?: boolean;
  onOpen: (guardrailId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const user = useAuth().user;
  const canEdit = hasPermission(user?.role, "guardrails", "write");

  return (
    <Table className="resource-table resource-guardrail-table table-fixed" aria-label={t("pages.guardrails.title")}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="resource-name-column">{t("guardrails.guardrail")}</TableHead>
            <TableHead className="resource-protection-column"><ColumnHelp label={t("guardrails.registryReadiness")} help={t("guardrails.registryReadinessHelp")} /></TableHead>
            <TableHead className="resource-traffic-column"><ColumnHelp label={t("dashboard.metrics.request_rate")} help={t("guardrails.registryTrafficHelp")} /></TableHead>
            <TableHead className="resource-updated-column">{t("guardrails.updated")}</TableHead>
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
                  <TenantResourceBadge ownerTenantId={guardrail.tenant_id} activeTenantId={user?.tenant_id} />
                </Link>
              </TableCell>
              <TableCell><StateBadge state={guardrail.status} />
                {guardrail.status !== "not_ready" && guardrail.protection && guardrail.protection.status !== "applied" ? <p className="mt-2 text-xs leading-5 text-muted-foreground">{t(`protectionMode.states.${guardrail.protection.status}`)} · {t("protectionMode.switching", { mode: t(`states.${guardrail.protection.mode}`) })} · {t("protectionMode.progress", guardrail.protection)}</p> : null}
              </TableCell>
              <TableCell>
                <GuardrailRequestRate guardrailId={guardrail.id} name={guardrail.name} points={requestRates?.byGuardrail[guardrail.id] ?? requestRates?.zeroPoints} loading={ratesLoading} error={ratesError} />
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {new Date(guardrail.updated_at).toLocaleString(i18n.language)}
              </TableCell>
              <TableCell className="resource-actions-column" onClick={event => event.stopPropagation()}>{canEdit && (!guardrail.tenant_id || guardrail.tenant_id === user?.tenant_id) ? <GuardrailRowActions guardrail={guardrail} /> : null}</TableCell>
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
