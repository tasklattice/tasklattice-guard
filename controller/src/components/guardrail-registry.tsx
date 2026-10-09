import { GuardrailRowActions } from "./guardrail-row-actions";
import { Link } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import { StateBadge } from "@/components/product-shell";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
            <TableHead className="w-28">{t("common.status")}</TableHead>
            <TableHead className="w-24">{t("guardrails.policies")}</TableHead>
            <TableHead className="w-44">{t("guardrails.validation")}</TableHead>
            <TableHead className="w-48">{t("guardrails.updated")}</TableHead>
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
              <TableCell className="font-mono text-xs">{guardrail.policy_bindings.length}</TableCell>
              <TableCell>
                {guardrail.latest_validation_run ? (
                  <span className="flex items-center gap-2">
                    <StateBadge state={guardrail.latest_validation_run.status} />
                    <span className="font-mono text-xs text-muted-foreground">{guardrail.latest_validation_run.metrics.compliance_rate}%</span>
                  </span>
                ) : <span className="text-xs text-muted-foreground">{t("guardrails.notRun")}</span>}
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
