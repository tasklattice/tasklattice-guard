import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ProtectedDeleteSheet } from "./protected-delete-sheet";
import type { Guardrail, GuardrailDeletionImpact, deleteGuardrail } from "@/lib/api";

export type GuardrailDeletionConfirmation = Parameters<typeof deleteGuardrail>[1];

export function DeleteGuardrailSheet({ guardrail, open, impact, loading, deleting, error, onOpenChange, onRetry, onConfirm }: {
  guardrail: Guardrail;
  open: boolean;
  impact?: GuardrailDeletionImpact;
  loading: boolean;
  deleting: boolean;
  error: Error | null;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
  onConfirm: (confirmation: GuardrailDeletionConfirmation) => void;
}) {
  const { t, i18n } = useTranslation();
  const [reason, setReason] = useState("");
  const telemetryFresh = Boolean(impact?.telemetry_fresh);
  const requiresSecondConfirmation = Boolean(impact?.requires_second_confirmation);

  useEffect(() => {
    if (!open) setReason("");
  }, [open]);

  return <ProtectedDeleteSheet
    open={open}
    onOpenChange={onOpenChange}
    entityName={guardrail.name}
    loading={loading}
    ready={telemetryFresh}
    deleting={deleting}
    error={impact && !telemetryFresh ? new Error(t("guardrails.deleteTelemetryStale")) : error}
    requiresConfirmation={requiresSecondConfirmation}
    impactItems={impact ? [
      { label: t("guardrails.recentIncomingRequests", { minutes: impact.window_minutes }), value: impact.incoming_request_count.toLocaleString(i18n.language) },
      { label: t("guardrails.activeRoutersAffected"), value: impact.active_router_count.toLocaleString(i18n.language) },
    ] : []}
    copy={{
      eyebrow: t("guardrails.deleteEyebrow"),
      title: t("guardrails.deleteDialogTitle"),
      description: t("guardrails.deleteDialogDescription", { name: guardrail.name }),
      protectedMessage: t("guardrails.recentTrafficWarning"),
      clearMessage: t("guardrails.noRecentTraffic"),
      retentionNote: t("guardrails.deleteRetentionNote"),
      continueLabel: t("guardrails.continueDelete"),
      deleteLabel: t("guardrails.deleteConfirm"),
      deletingLabel: t("guardrails.deleting"),
      confirmTitle: t("guardrails.deleteRecentTrafficTitle"),
      confirmDescription: t("guardrails.deleteRecentTrafficDescription", { count: impact?.incoming_request_count ?? 0, minutes: impact?.window_minutes ?? 30 }),
      confirmWarning: t("guardrails.deleteStopsTraffic", { count: impact?.active_router_count ?? 0 }),
      typeNameLabel: t("guardrails.typeNameToConfirm", { name: guardrail.name }),
      protectedDeleteLabel: t("guardrails.deleteDespiteTraffic"),
      cancelLabel: t("common.cancel"),
      backLabel: t("common.back"),
      retryLabel: t("common.retry"),
      reasonLabel: t("guardrails.deleteReason"),
      reasonPlaceholder: t("guardrails.deleteReasonPlaceholder"),
    }}
    reason={reason}
    onReasonChange={setReason}
    onRetry={onRetry}
    onConfirm={(confirmRecentTraffic, confirmationName) => onConfirm({
      reason: reason.trim(),
      confirm_recent_traffic: confirmRecentTraffic,
      ...(confirmationName ? { confirmation_name: confirmationName } : {}),
    })}
  />;
}

