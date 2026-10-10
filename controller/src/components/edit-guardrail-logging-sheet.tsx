import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Save } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EntitySheet } from "./entity-sheet";
import { ErrorNotice, InfoNotice } from "./product-shell";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Skeleton } from "./ui/skeleton";
import { toast } from "./ui/notifications";
import { queryKeys } from "@/features/query-keys";
import { useAuth } from "@/lib/auth";
import { getGuardrailLoggingSettings, updateGuardrailLoggingSettings, type LoggingLevel } from "@/lib/api";

export function EditGuardrailLoggingSheet({ guardrailId, guardrailName, onClose }: {
  guardrailId: string; guardrailName: string; onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const canEdit = useAuth().user?.role === "admin";
  const [selectedLevel, setSelectedLevel] = useState<LoggingLevel | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const query = useQuery({ queryKey: queryKeys.guardrailLogging(guardrailId), queryFn: () => getGuardrailLoggingSettings(guardrailId) });
  const settings = query.data;
  const level = selectedLevel ?? settings?.level ?? "info";
  const changed = Boolean(settings && level !== settings.level);
  const mutation = useMutation({
    mutationFn: () => updateGuardrailLoggingSettings(guardrailId, level, level !== "info" && acknowledged),
    onSuccess: async updated => {
      client.setQueryData(queryKeys.guardrailLogging(guardrailId), updated);
      await client.invalidateQueries({ queryKey: queryKeys.auditEvents });
      toast.success(t("guardrails.loggingUpdated"));
      onClose();
    },
  });
  const saveDisabled = !canEdit || !changed || query.isFetching || Boolean(query.error) || mutation.isPending || (level !== "info" && !acknowledged);

  return <EntitySheet open width="md" density="compact" closeDisabled={mutation.isPending}
    onOpenChange={open => { if (!open && !mutation.isPending) onClose(); }}
    eyebrow={guardrailName} title={t("guardrails.editLogLevel")} description={t("guardrails.loggingConfirmDescription")}
    footer={<>
      <Button variant="outline" disabled={mutation.isPending} onClick={onClose}>{t("common.cancel")}</Button>
      <Button variant="edit" disabled={saveDisabled} onClick={() => mutation.mutate()}>
        {mutation.isPending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <Save />}
        {t(mutation.isPending ? "common.saving" : "common.save")}
      </Button>
    </>}>
    <div className="space-y-5">
      {query.isPending ? <Skeleton className="h-32" /> : query.error || !settings ? <>
        <ErrorNotice error={query.error ?? new Error(t("guardrails.loggingUnavailable"))} />
        <Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>{t("common.retry")}</Button>
      </> : <>
        <div className="space-y-2">
          <Label htmlFor={`logging-level-${guardrailId}`}>{t("guardrails.loggingLevel")}</Label>
          <Select value={level} disabled={!canEdit || mutation.isPending} onValueChange={value => {
            setSelectedLevel(value as LoggingLevel); setAcknowledged(false); mutation.reset();
          }}>
            <SelectTrigger id={`logging-level-${guardrailId}`}><SelectValue /></SelectTrigger>
            <SelectContent>{(["info", "debug", "trace"] as const).map(value => <SelectItem key={value} value={value}>{value.toUpperCase()}</SelectItem>)}</SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">{t(`guardrails.loggingLevels.${level}.description`)}</p>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">{t("guardrails.loggingScopeHint")}</p>
        <p className="text-xs leading-5 text-muted-foreground">{t("guardrails.loggingRetention", { days: settings.retention_days, time: new Date(settings.updated_at).toLocaleString(i18n.language) })}</p>
        {!settings.content_capture_enabled ? <InfoNotice title={t("guardrails.loggingTitle")}>{t("guardrails.loggingEncryptionMissing")}</InfoNotice> : null}
        {level !== "info" ? <>
          <ul className="list-disc space-y-2 pl-5 text-sm leading-6 text-muted-foreground">
            <li>{t("guardrails.loggingCostWrite")}</li>
            <li>{t("guardrails.loggingCostSensitive")}</li>
            {level === "trace" ? <li>{t("guardrails.loggingCostApproved")}</li> : null}
          </ul>
          {changed ? <label className="flex min-h-11 cursor-pointer items-start gap-3 border p-3">
            <Checkbox checked={acknowledged} disabled={mutation.isPending} onCheckedChange={value => setAcknowledged(Boolean(value))} />
            <span className="text-sm leading-5">{t("guardrails.loggingAcknowledge")}</span>
          </label> : <p className="text-sm text-muted-foreground">{t("guardrails.loggingElevatedActive")}</p>}
        </> : null}
        {!canEdit ? <p className="text-sm text-muted-foreground">{t("guardrails.loggingAdminOnly")}</p> : null}
      </>}
      {mutation.error ? <ErrorNotice error={mutation.error} /> : null}
    </div>
  </EntitySheet>;
}
