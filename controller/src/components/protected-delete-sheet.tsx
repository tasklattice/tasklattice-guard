import { useEffect, useId, useState, type ReactNode } from "react";
import { LoaderCircle, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";

import { EntitySheet } from "@/components/entity-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

export type ProtectedDeleteImpactItem = {
  label: ReactNode;
  value: ReactNode;
};

export type ProtectedDeleteCopy = {
  eyebrow: string;
  title: ReactNode;
  description: ReactNode;
  protectedMessage: ReactNode;
  clearMessage: ReactNode;
  retentionNote: ReactNode;
  continueLabel: string;
  deleteLabel: string;
  deletingLabel: string;
  confirmTitle: ReactNode;
  confirmDescription: ReactNode;
  confirmWarning: ReactNode;
  typeNameLabel: string;
  protectedDeleteLabel: string;
  cancelLabel: string;
  backLabel: string;
  retryLabel: string;
  reasonLabel?: string;
  reasonPlaceholder?: string;
};

export function ProtectedDeleteSheet({
  copy,
  deleting,
  entityName,
  error,
  impactItems,
  loading,
  onConfirm,
  onOpenChange,
  onRetry,
  open,
  ready,
  requiresConfirmation,
  reason,
  onReasonChange,
}: {
  copy: ProtectedDeleteCopy;
  deleting: boolean;
  entityName: string;
  error: Error | null;
  impactItems: ProtectedDeleteImpactItem[];
  loading: boolean;
  onConfirm: (confirmedProtectedDelete: boolean, confirmationName?: string) => void;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
  open: boolean;
  ready: boolean;
  requiresConfirmation: boolean;
  reason?: string;
  onReasonChange?: (reason: string) => void;
}) {
  const inputId = useId();
  const [step, setStep] = useState<"impact" | "confirm">("impact");
  const [typedName, setTypedName] = useState("");

  useEffect(() => {
    if (!open) {
      setStep("impact");
      setTypedName("");
    }
  }, [open]);

  const footer = step === "impact" ? <>
    <Button variant="outline" disabled={deleting} onClick={() => onOpenChange(false)}>{copy.cancelLabel}</Button>
    <Button
      variant={requiresConfirmation ? "default" : "destructive"}
      disabled={loading || !ready || deleting || Boolean(onReasonChange && !reason?.trim())}
      onClick={() => { if (requiresConfirmation) setStep("confirm"); else onConfirm(false); }}
    >
      {deleting ? <LoaderCircle className="animate-spin" /> : requiresConfirmation ? <TriangleAlert /> : <Trash2 />}
      {deleting ? copy.deletingLabel : requiresConfirmation ? copy.continueLabel : copy.deleteLabel}
    </Button>
  </> : <>
    <Button variant="outline" disabled={deleting} onClick={() => { setStep("impact"); setTypedName(""); }}>{copy.backLabel}</Button>
    <Button variant="destructive" disabled={typedName !== entityName || deleting} onClick={() => onConfirm(true, typedName)}>
      {deleting ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
      {deleting ? copy.deletingLabel : copy.protectedDeleteLabel}
    </Button>
  </>;

  return (
    <EntitySheet
      open={open}
      onOpenChange={(nextOpen) => { if (!deleting) onOpenChange(nextOpen); }}
      eyebrow={copy.eyebrow}
      title={step === "impact" ? copy.title : copy.confirmTitle}
      description={step === "impact" ? copy.description : copy.confirmDescription}
      width="md"
      density="compact"
      footer={footer}
    >
      {step === "impact" ? <div className="space-y-4">
        {loading ? <Skeleton className="h-28 rounded-lg" /> : ready ? <dl className={`grid overflow-hidden rounded-lg border ${impactItems.length >= 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
          {impactItems.map((item, index) => <div key={index} className="border-b px-4 py-3 last:border-b-0 sm:border-r sm:border-b-0 sm:last:border-r-0">
            <dt className="text-xs leading-5 text-muted-foreground">{item.label}</dt>
            <dd className="mt-1 font-display text-2xl font-semibold tabular-nums">{item.value}</dd>
          </div>)}
        </dl> : null}
        {ready ? <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-xs leading-5 ${requiresConfirmation ? "border-amber-200 bg-amber-50 text-amber-900" : "bg-muted/35 text-muted-foreground"}`}>
          {requiresConfirmation ? <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> : <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
          <span>{requiresConfirmation ? copy.protectedMessage : copy.clearMessage}</span>
        </div> : null}
        <div className="rounded-lg border bg-muted/35 px-4 py-3 text-xs leading-5 text-muted-foreground">{copy.retentionNote}</div>
        {onReasonChange ? <div className="space-y-2">
          <Label htmlFor={`${inputId}-reason`}>{copy.reasonLabel ?? "Reason"}</Label>
          <Input
            id={`${inputId}-reason`}
            className="field:min-h-11"
            value={reason ?? ""}
            placeholder={copy.reasonPlaceholder}
            onChange={(event) => onReasonChange(event.target.value)}
            disabled={deleting}
          />
        </div> : null}
        {error ? <div role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-xs leading-5 text-destructive">
          <p>{error.message}</p>
          {!ready ? <Button className="mt-2 min-h-11" size="sm" variant="outline" onClick={onRetry}>{copy.retryLabel}</Button> : null}
        </div> : null}
      </div> : <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-destructive/25 bg-destructive/5 px-4 py-3 text-xs leading-5 text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{copy.confirmWarning}</span>
        </div>
        <div className="space-y-2">
          <Label htmlFor={inputId}>{copy.typeNameLabel}</Label>
          <Input id={inputId} className="field:min-h-11" autoComplete="off" autoFocus value={typedName} onChange={(event) => setTypedName(event.target.value)} disabled={deleting} />
        </div>
        <div className="rounded-lg border bg-muted/35 px-4 py-3 text-xs leading-5 text-muted-foreground">{copy.retentionNote}</div>
        {error ? <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-xs leading-5 text-destructive">{error.message}</p> : null}
      </div>}
    </EntitySheet>
  );
}
