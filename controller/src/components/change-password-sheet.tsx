import { useEffect, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/notifications";

import { EntitySheet } from "@/components/entity-sheet";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { changePassword } from "@/lib/identity-api";

const FORM_ID = "change-password-form";

export function ChangePasswordSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setError("");
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: () => changePassword({ current_password: currentPassword, new_password: newPassword }),
    onSuccess: () => {
      toast.success(t("auth.passwordChanged"));
      onOpenChange(false);
    },
    onError: (reason) => setError(reason instanceof Error ? reason.message : t("common.unknownError")),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (newPassword !== confirmation) {
      setError(t("auth.passwordMismatch"));
      return;
    }
    mutation.mutate();
  }

  const canSubmit = Boolean(currentPassword) && newPassword.length >= 8 && confirmation.length >= 8 && !mutation.isPending;

  return (
    <EntitySheet
      open={open}
      onOpenChange={onOpenChange}
      eyebrow={t("auth.accountSecurity")}
      title={t("auth.changePassword")}
      description={t("auth.changePasswordDescription")}
      width="md"
      footer={
        <>
          <Button className="!h-11" variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button className="!h-11" type="submit" form={FORM_ID} disabled={!canSubmit}>
            <KeyRound />{mutation.isPending ? t("common.saving") : t("auth.changePassword")}
          </Button>
        </>
      }
    >
      <form id={FORM_ID} className="grid gap-5" onSubmit={submit}>
        <Field label={t("auth.currentPassword")}>
          <Input className="field:h-11" autoFocus type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required />
        </Field>
        <Field label={t("auth.newPassword")} hint={t("auth.passwordHint")}>
          <Input className="field:h-11" type="password" autoComplete="new-password" minLength={8} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required />
        </Field>
        <Field label={t("auth.confirmNewPassword")}>
          <Input className="field:h-11" type="password" autoComplete="new-password" minLength={8} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required />
        </Field>
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <div className="rounded-xl border bg-muted/35 p-4 text-xs leading-5 text-muted-foreground">{t("auth.passwordSessionNotice")}</div>
      </form>
    </EntitySheet>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="grid gap-2 text-sm font-medium">{label}{children}{hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}</label>;
}
