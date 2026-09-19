import { useId, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export type TopicControlMode = "strict" | "permissive";

export function TopicModeField({ mode, onChange, disabled = false }: { mode: TopicControlMode; onChange: (mode: TopicControlMode) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  return <div className="grid gap-2">
    <Label htmlFor={id}>{t("topicControl.mode")}</Label>
    <select id={id} value={mode} disabled={disabled} onChange={event => onChange(event.target.value as TopicControlMode)} aria-describedby={`${id}-hint`} className="min-h-11 w-full rounded-md border border-input bg-card px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
      <option value="strict">{t("topicControl.strict")}</option>
      <option value="permissive">{t("topicControl.permissive")}</option>
    </select>
    <p id={`${id}-hint`} className="text-xs leading-5 text-muted-foreground">{t(`topicControl.${mode}Hint`)}</p>
  </div>;
}

export function TopicControlFields({ allowed, denied, mode, onAllowedChange, onDeniedChange, onModeChange, fieldRef, allowedLabel }: {
  allowed: string; denied: string; mode: TopicControlMode;
  onAllowedChange: (value: string) => void; onDeniedChange: (value: string) => void; onModeChange: (mode: TopicControlMode) => void;
  fieldRef?: RefObject<HTMLTextAreaElement | null>; allowedLabel?: string;
}) {
  const { t } = useTranslation();
  const id = useId();
  return <div className="space-y-4">
    <TopicModeField mode={mode} onChange={onModeChange} />
    <div className="grid gap-4 md:grid-cols-2">
      <div className="grid content-start gap-2"><Label htmlFor={`${id}-allow`}>{allowedLabel ?? t("topicControl.allowed")}</Label><Textarea id={`${id}-allow`} ref={fieldRef} className="min-h-32 bg-card" value={allowed} onChange={event => onAllowedChange(event.target.value)} placeholder={t("guardrailWizard.onePerLine")} /></div>
      <div className="grid content-start gap-2"><Label htmlFor={`${id}-deny`}>{t("topicControl.denied")}</Label><Textarea id={`${id}-deny`} className="min-h-32 bg-card" value={denied} onChange={event => onDeniedChange(event.target.value)} placeholder={t("topicControl.deniedPlaceholder")} /></div>
    </div>
    <p className="text-xs leading-5 text-muted-foreground">{t("topicControl.denyPriority")}</p>
  </div>;
}
