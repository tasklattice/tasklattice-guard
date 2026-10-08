import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { LoaderCircle, RotateCcw } from "lucide-react";
import { EntitySheet } from "@/components/entity-sheet";
import { ErrorNotice } from "@/components/product-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/notifications";
import { discardGuardrailDraft, getGuardrailDraftChanges, type Guardrail } from "@/lib/api";

export function GuardrailDraftChangesSheet({ guardrail, initialDiscard = false, canManage, onClose, onChanged }: {
  guardrail: Guardrail; initialDiscard?: boolean; canManage: boolean; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(initialDiscard);
  const query = useQuery({ queryKey: ["guardrail-draft-changes", guardrail.id], queryFn: () => getGuardrailDraftChanges(guardrail.id),
    staleTime: 0, refetchOnMount: "always", refetchOnWindowFocus: false });
  const details = query.data;
  const stale = details && details.draftRevision !== guardrail.draft_revision;
  const mutation = useMutation({
    mutationFn: () => {
      if (!details?.canDiscard || !details.baselineVersion || stale) throw new Error(t("guardrails.draftChanges.stale"));
      return discardGuardrailDraft(guardrail.id, details.draftRevision, details.baselineVersion);
    },
    onSuccess: async () => { await onChanged(); toast.success(t("guardrails.draftChanges.discarded")); onClose(); },
  });
  const refresh = async () => { mutation.reset(); setConfirming(false); await onChanged(); await query.refetch(); };
  return <EntitySheet open width="xl" density="compact" closeDisabled={mutation.isPending} onOpenChange={open => { if (!open) onClose(); }}
    eyebrow={guardrail.name} title={t(confirming ? "guardrails.draftChanges.discardTitle" : "guardrails.draftChanges.title")}
    description={t(confirming ? "guardrails.draftChanges.discardDescription" : "guardrails.draftChanges.description")}
    footer={<>
      <Button variant="outline" disabled={mutation.isPending} onClick={() => confirming ? setConfirming(false) : onClose()}>{t(confirming ? "common.cancel" : "common.close")}</Button>
      {canManage && details?.canDiscard ? <Button variant="destructive" disabled={mutation.isPending || query.isFetching || Boolean(stale)} onClick={() => confirming ? mutation.mutate() : setConfirming(true)}>
        {mutation.isPending ? <LoaderCircle className="animate-spin" /> : <RotateCcw />}{t("guardrails.draftChanges.discard")}
      </Button> : null}
    </>}>
    {query.isPending ? <Skeleton className="h-48" /> : query.error ? <ErrorNotice error={query.error} /> : details ? <div className="space-y-5">
      <div className="border-b pb-4 text-sm">
        <p>{details.baselineVersion ? t("guardrails.draftChanges.baseline", { version: details.baselineVersion }) : t("guardrails.draftChanges.firstDraft")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("guardrails.draftRevisionLabel", { revision: details.draftRevision })}</p>
      </div>
      {mutation.error ? <ErrorNotice error={mutation.error} /> : null}
      {stale ? <p role="alert">{t("guardrails.draftChanges.stale")}</p> : null}
      {mutation.error || stale ? <Button variant="outline" onClick={() => void refresh()}>{t("common.refresh")}</Button> : null}
      {!details.baselineAvailable ? <p>{t("guardrails.draftChanges.unavailable")}</p> : !details.hasUnpublishedChanges ? <p role="status">{t("guardrails.draftChanges.none")}</p> : <>
        {confirming ? <p className="border-l-2 border-destructive pl-4 text-sm" role="alert">{t("guardrails.draftChanges.discardImpact")}</p> : null}
        {details.changes.map((change, index) => <details key={`${change.kind}-${change.subject}-${change.field}`} open={index === 0} className="border-b pb-4">
          <summary className="cursor-pointer py-3 text-sm font-medium">{change.subject ? `${change.subject} · ` : ""}{t(`guardrails.draftChanges.kinds.${change.kind}`)}{change.kind === "setting" || change.kind === "policyUpdated" ? ` · ${t(`guardrails.draftChanges.fields.${change.field}`)}` : ""}</summary>
          <div className="grid grid-cols-2 gap-4 pt-2">
            {[{ label: "before", value: change.before }, { label: "after", value: change.after }].map(side => <div key={side.label} className="min-w-0 bg-muted/40 p-3">
              <p className="mb-2 text-xs text-muted-foreground">{t(`guardrails.draftChanges.${side.label}`)}</p>
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-6">{side.value || t("guardrails.draftChanges.empty")}</pre>
            </div>)}
          </div>
        </details>)}
      </>}
    </div> : null}
    {query.error ? <Button className="mt-4" variant="outline" onClick={() => void query.refetch()}>{t("common.retry")}</Button> : null}
  </EntitySheet>;
}
