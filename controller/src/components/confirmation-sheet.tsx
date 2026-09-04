import { LoaderCircle, Save, Trash2, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { EntitySheet } from "@/components/entity-sheet";
import { Button } from "@/components/ui/button";

export function ConfirmationSheet({
  children,
  cancelLabel,
  confirmLabel,
  confirmDisabled = false,
  description,
  eyebrow,
  onConfirm,
  onOpenChange,
  open,
  pending = false,
  pendingLabel,
  title,
  variant = "default",
}: {
  children?: ReactNode;
  cancelLabel: string;
  confirmLabel: string;
  confirmDisabled?: boolean;
  description: ReactNode;
  eyebrow: string;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  pending?: boolean;
  pendingLabel?: string;
  title: ReactNode;
  variant?: "default" | "warning" | "destructive";
}) {
  const Icon = variant === "destructive" ? Trash2 : variant === "warning" ? TriangleAlert : Save;
  return (
    <EntitySheet
      open={open}
      closeDisabled={pending}
      onOpenChange={(next) => { if (!pending) onOpenChange(next); }}
      eyebrow={eyebrow}
      title={title}
      description={description}
      width="md"
      density="compact"
      footer={<>
        <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>{cancelLabel}</Button>
        <Button type="button" variant={variant === "destructive" ? "destructive" : "default"} disabled={pending || confirmDisabled} onClick={onConfirm}>
          {pending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <Icon />}
          {pending ? pendingLabel ?? confirmLabel : confirmLabel}
        </Button>
      </>}
    >
      <div className="space-y-4">{children}</div>
    </EntitySheet>
  );
}
