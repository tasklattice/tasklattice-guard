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
    <section className="mt-5 min-w-0 overflow-hidden rounded-xl border bg-card shadow-xs">
      <header className="border-b bg-muted/25 px-5 py-3">
        <p className="text-xs font-medium text-muted-foreground">{t("guardrails.registry", { count: guardrails.length })}</p>
      </header>
      <Table className="table-fixed">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="px-5">{t("guardrails.guardrail")}</TableHead>
            <TableHead className="w-28">{t("common.status")}</TableHead>
            <TableHead className="hidden w-20 md:table-cell">{t("guardrails.policies")}</TableHead>
            <TableHead className="hidden w-40 lg:table-cell">{t("guardrails.validation")}</TableHead>
            <TableHead className="hidden w-44 xl:table-cell">{t("guardrails.updated")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {guardrails.map((guardrail) => (
            <TableRow
              key={guardrail.id}
              className="group cursor-pointer focus-within:bg-muted/50"
              onClick={() => onOpen(guardrail.id)}
            >
              <TableCell className="min-w-0 whitespace-normal px-5 py-3.5">
                <Link
                  to="/guardrails/$guardrailId"
                  params={{ guardrailId: guardrail.id }}
                  aria-label={t("guardrails.openNamedGuardrail", { name: guardrail.name })}
                  className="flex min-w-0 items-start gap-3 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  onClick={(event) => event.stopPropagation()}
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                    <ShieldCheck className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-sm group-hover:text-primary">{guardrail.name}</strong>
                    <span className="mt-1 line-clamp-2 whitespace-normal break-words text-xs leading-5 text-muted-foreground">
                      {guardrail.purpose}
                    </span>
                  </span>
                </Link>
              </TableCell>
              <TableCell><StateBadge state={guardrail.status} /></TableCell>
              <TableCell className="hidden font-mono text-xs md:table-cell">{guardrail.policy_bindings.length}</TableCell>
              <TableCell className="hidden lg:table-cell">
                {guardrail.latest_validation_run ? (
                  <span className="flex items-center gap-2">
                    <StateBadge state={guardrail.latest_validation_run.status} />
                    <span className="font-mono text-xs text-muted-foreground">{guardrail.latest_validation_run.metrics.compliance_rate}%</span>
                  </span>
                ) : <span className="text-xs text-muted-foreground">{t("guardrails.notRun")}</span>}
              </TableCell>
              <TableCell className="hidden text-xs text-muted-foreground xl:table-cell">
                {new Date(guardrail.updated_at).toLocaleString(i18n.language)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
