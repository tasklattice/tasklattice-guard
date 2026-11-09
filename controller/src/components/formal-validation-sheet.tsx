import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmationSheet } from "./confirmation-sheet";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { formalValidationSchema, type FormalValidation } from "../../shared/formal-validation";

export function FormalValidationSheet({ pending, onClose, onValidate }: { pending: boolean; onClose: () => void; onValidate: (value: FormalValidation) => void }) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ policyId: "", policyVersion: "", confidenceThreshold: "0.8", query: "", validResponse: "", invalidResponse: "" });
  const parsed = formalValidationSchema.safeParse({ ...form, confidenceThreshold: form.confidenceThreshold.trim() ? Number(form.confidenceThreshold) : NaN });
  const labels = { policyId: "policy_id", policyVersion: "policy_version", confidenceThreshold: "confidence_threshold", query: "query", validResponse: "validResponse", invalidResponse: "invalidResponse" } as const;
  return <ConfirmationSheet open variant="testing" title={t("declarativePolicy.formalValidationTitle")} eyebrow={t("modelSettings.catalogTitle")} description={t("declarativePolicy.formalValidationHint")}
    pending={pending} cancelLabel={t("common.cancel")} confirmLabel={t("modelSettings.validateAssignment")} confirmDisabled={!parsed.success}
    onOpenChange={open => { if (!open) onClose(); }} onConfirm={() => { if (parsed.success) onValidate(parsed.data); }}>
    {Object.entries(labels).map(([key, label]) => <label key={key} className="grid gap-2 text-sm"><span>{t(`declarativePolicy.${label}`)}</span>{["query", "validResponse", "invalidResponse"].includes(key)
      ? <Textarea value={form[key as keyof typeof form]} onChange={event => setForm({ ...form, [key]: event.target.value })} />
      : <Input className="field:h-11" value={form[key as keyof typeof form]} onChange={event => setForm({ ...form, [key]: event.target.value })} />}</label>)}
    {!parsed.success ? <p role="status" className="text-xs text-muted-foreground">{t("declarativePolicy.formalValidationRequired")}</p> : null}
  </ConfirmationSheet>;
}
