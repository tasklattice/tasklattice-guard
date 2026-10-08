import { useTranslation } from "react-i18next";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RefreshCw, Trash2 } from "lucide-react";
import { deleteControllerGuardrailVersion, getGuardrailVersionDeletionImpact, type GuardrailVersionDeletionImpact } from "@/lib/controller-api";
import { revisionLabel } from "./traffic-routing/router-view-model";
import { ConfirmationSheet } from "./confirmation-sheet";
import { ErrorNotice } from "./product-shell";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";

type Reference = GuardrailVersionDeletionImpact["references"][number];

/** Deletes one immutable version only after showing everything that still depends on it. */
export function DeleteGuardrailVersionSheet({ guardrailId, version, onDeleted, onClose }: {
  guardrailId: string;
  version: string;
  onDeleted: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const impact = useQuery({
    queryKey: ["guardrail-version-deletion-impact", guardrailId, version],
    queryFn: () => getGuardrailVersionDeletionImpact(guardrailId, version),
    staleTime: 0,
  });
  const remove = useMutation({
    mutationFn: () => deleteControllerGuardrailVersion(guardrailId, version),
    onSuccess: onDeleted,
    // A 409 carries a newer impact; show that instead of a stale one.
    onError: () => void impact.refetch(),
  });
  const data = impact.data;
  return (
    <ConfirmationSheet
      open
      onOpenChange={open => { if (!open && !remove.isPending) onClose(); }}
      eyebrow={t("uiCopy.guardrailVersion")}
      title={t("guardrails.deleteVersionTitle", { version })}
      description={t("guardrails.deleteVersionDescription")}
      cancelLabel={t("common.cancel")}
      confirmLabel={t("uiCopy.deleteVersion")}
      confirmIcon={<Trash2 />}
      confirmDisabled={!data?.deletable || impact.isFetching}
      variant="destructive"
      pending={remove.isPending}
      onConfirm={() => remove.mutate()}
    >
      {impact.isPending ? <Skeleton className="h-28" /> : impact.error ? <ErrorNotice error={impact.error} /> : data && <div className="space-y-4 text-sm">
        {data.references.length > 0 && <section className="space-y-2" aria-label={t("guardrails.versionReferences")}>
          <h3 className="font-medium">{t("guardrails.versionReferences")}</h3>
          <p className="text-muted-foreground">{t("guardrails.versionReferencesDescription")}</p>
          <ul className="divide-y rounded-lg border">
            {data.references.map((reference, index) => <li key={index} className="px-3 py-2"><ReferenceLine reference={reference} /></li>)}
          </ul>
        </section>}
        {data.blockers.length > 0 && <section className="space-y-2">
          <h3 className="font-medium">{t("guardrails.versionStillServing")}</h3>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            {data.blockers.map(blocker => <li key={blocker.code}>{t(`guardrails.versionBlocker.${blocker.code}`, { time: blocker.until ? new Date(blocker.until).toLocaleTimeString() : "" })}</li>)}
          </ul>
        </section>}
        {data.deletable && <p className="rounded-lg border bg-muted/30 px-3 py-2">{t("guardrails.versionNotReferenced")}</p>}
        {data.unrestorableRevisions.length > 0 && <section className="space-y-2">
          <h3 className="font-medium">{t("guardrails.unrestorableRevisions")}</h3>
          <p className="text-muted-foreground">{t("guardrails.unrestorableRevisionsDescription")}</p>
          <ul className="space-y-1">
            {data.unrestorableRevisions.map(item => <li key={`${item.routerId}:${item.revision}`}>{item.routerName} · <code className="text-xs">{revisionLabel(item)}</code></li>)}
          </ul>
        </section>}
        {!data.deletable && <Button variant="outline" size="sm" disabled={impact.isFetching} onClick={() => { remove.reset(); void impact.refetch(); }}><RefreshCw />{t("guardrails.checkAgain")}</Button>}
        {remove.error && <ErrorNotice error={remove.error} />}
      </div>}
    </ConfirmationSheet>
  );
}

function ReferenceLine({ reference }: { reference: Reference }) {
  const { t } = useTranslation();
  if (reference.kind === "latest") return <span>{t("guardrails.versionReference.latest")}</span>;
  return (
    <span>
      <Link className="font-medium text-primary" to="/integration/routers/$routerId" params={{ routerId: reference.routerId }}>{reference.routerName}</Link>
      {" · "}{t(`guardrails.versionReference.${reference.kind}`, { ticket: reference.ticket || "—" })}
    </span>
  );
}
